/**
 * SecretRequests - secrets an agent asks the user for.
 *
 * The user's answer goes straight to the server's secret store under a
 * one-use SecretRef; orchestration only records the request and its status.
 * A tool that needs the value takes the ref and consumes it, so the value
 * never reaches the transcript, projections, clients, or model context.
 *
 * A prompt from a process in the agent's shell (`t3 secret prompt`) shows the
 * same card, but the answer goes back to that waiting process through memory
 * and is never stored. Withdrawing the prompt closes the card as cancelled.
 *
 * @module SecretRequests
 */
import {
  CommandId,
  SecretRef,
  SecretRequestError,
  TurnItemId,
  type NodeId,
  type OrchestrationV2SecretPrompt,
  type ProjectId,
  type ProviderInstanceId,
  type RunId,
  type SecretRequestAnswerInput,
  type ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
/** Store name for a ref's value; refs are fixed-length hex, so names stay short and safe. */
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
/** A value nobody used within this long is dropped; the agent can ask again. */
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;

/**
 * Each request has exactly one ref, derived from where it was asked. Its
 * length never depends on the thread id, so the store's file names stay
 * within filesystem limits, and the requesting tool finds it without a
 * second record. Unguessable without the server's own salt.
 */
const refFor = (salt: string, threadId: ThreadId, turnItemId: string) =>
  SecretRef.make(
    `${SECRET_REF_PREFIX}${NodeCrypto.createHmac("sha256", salt)
      .update(`${threadId}\u0000${turnItemId}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

/** A ref's value, the project it was entered for, and when it was saved. */
const StoredSecret = Schema.fromJsonString(
  Schema.Struct({ projectId: Schema.String, value: Schema.String, savedAt: Schema.Number }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

/** A shell prompt waits this long for the user before it closes the card. */
export const SECRET_PROMPT_TIMEOUT_MS = 15 * 60 * 1000;

export interface SecretPromptInput {
  readonly threadId: ThreadId;
  /** The provider the asking shell belongs to; the run must be its. */
  readonly providerInstanceId: ProviderInstanceId;
  readonly title: string;
  readonly description: string;
  readonly shellPrompt: OrchestrationV2SecretPrompt;
  readonly timeoutMs?: number;
}

/** How a shell prompt ended. Only `saved` carries the value. */
export type SecretPromptOutcome =
  | { readonly status: "saved"; readonly value: string }
  | { readonly status: "declined" | "cancelled" | "timed_out" };

/** The card is shown; `outcome` waits for the answer, `withdraw` closes the card. */
export interface SecretPromptHandle {
  readonly turnItemId: TurnItemId;
  readonly outcome: Effect.Effect<SecretPromptOutcome>;
  readonly withdraw: Effect.Effect<void>;
}

/** A shell prompt could not be shown: the thread has no run the shell belongs to. */
export class SecretPromptUnavailableError extends Data.TaggedError("SecretPromptUnavailableError")<{
  readonly reason: "no_active_run" | "record_failed";
  readonly cause?: unknown;
}> {}

type ShellAnswer =
  | { readonly type: "save"; readonly secret: string }
  | { readonly type: "decline" };

/**
 * One open shell prompt. `answering` holds it while the answer is recorded,
 * so a withdraw in that window leaves the outcome to the answer.
 */
interface ShellPromptWaiter {
  readonly state: Ref.Ref<"open" | "answering" | "withdrawn" | "closed">;
  readonly answer: Deferred.Deferred<ShellAnswer>;
  readonly record: (
    status: "saved" | "declined" | "cancelled",
  ) => Effect.Effect<void, SecretRequestError>;
}

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    /**
     * Answers a pending request in a thread. Saving stores the value under a
     * new ref that the requesting tool reads from the request's status.
     */
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    /** The ref minted when this request was saved, for the tool that asked. */
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    /**
     * Reads and deletes a ref's value. Fails for unknown or used refs, and
     * for refs entered in another project.
     */
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
    /**
     * Shows a card for a process in the agent's shell and returns once it is
     * recorded. The value reaches only `outcome`; nothing stores it.
     */
    readonly prompt: (
      input: SecretPromptInput,
    ) => Effect.Effect<SecretPromptHandle, SecretPromptUnavailableError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const salt = Buffer.from(
    yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie),
  ).toString("hex");

  // Open shell prompts by turn item. Memory only: after a restart the asking
  // process has lost its connection, and recovery closes the card.
  const shellPrompts = new Map<TurnItemId, ShellPromptWaiter>();

  const answerShellPrompt = (turnItemId: TurnItemId, reply: ShellAnswer) =>
    Effect.gen(function* () {
      const waiter = shellPrompts.get(turnItemId);
      const claimed =
        waiter === undefined
          ? "missing"
          : yield* Ref.modify(waiter.state, (state) =>
              state === "open" ? (["claimed", "answering"] as const) : ([state, state] as const),
            );
      if (waiter === undefined || claimed !== "claimed") {
        return yield* new SecretRequestError({
          reason:
            claimed === "answering" || claimed === "closed" ? "already_answered" : "agent_stopped",
        });
      }
      const recorded = yield* waiter
        .record(reply.type === "save" ? "saved" : "declined")
        .pipe(Effect.exit);
      if (recorded._tag === "Failure") {
        // The card still says pending; reopen it for another try unless the
        // process went away meanwhile, which closes it instead.
        const next = yield* Ref.modify(waiter.state, (state) =>
          state === "withdrawn" ? (["withdrawn", "closed"] as const) : (["open", "open"] as const),
        );
        if (next === "withdrawn") {
          shellPrompts.delete(turnItemId);
          yield* waiter.record("cancelled").pipe(Effect.ignore);
        }
        return yield* recorded;
      }
      yield* Ref.set(waiter.state, "closed");
      shellPrompts.delete(turnItemId);
      yield* Deferred.succeed(waiter.answer, reply);
    });

  const prompt: SecretRequests["Service"]["prompt"] = (input) =>
    Effect.gen(function* () {
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["runs"], { turnItemTypes: [], messageRoles: [] })
        .pipe(
          Effect.mapError(
            (cause) => new SecretPromptUnavailableError({ reason: "no_active_run", cause }),
          ),
        );
      // The card belongs to the run whose shell asked, as with request_secret.
      const run = ThreadManagementService.latestActiveRun(records);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== input.providerInstanceId
      ) {
        return yield* new SecretPromptUnavailableError({ reason: "no_active_run" });
      }
      const runId: RunId = run.id;
      const nodeId: NodeId = run.rootNodeId;
      const key = NodeCrypto.randomUUID();
      const turnItemId = TurnItemId.make(`turn-item:secret-prompt:${key}`);
      const record = (secretStatus: "pending" | "saved" | "declined" | "cancelled") =>
        threadManagement
          .dispatch({
            type: "secret_request.record",
            commandId: CommandId.make(`secret-prompt:${key}:${secretStatus}`),
            threadId: input.threadId,
            runId,
            nodeId,
            turnItemId,
            label: input.title,
            reason: input.description,
            shellPrompt: input.shellPrompt,
            secretStatus,
          })
          .pipe(
            Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
          );
      const waiter: ShellPromptWaiter = {
        state: yield* Ref.make<"open" | "answering" | "withdrawn" | "closed">("open"),
        answer: yield* Deferred.make<ShellAnswer>(),
        record,
      };
      shellPrompts.set(turnItemId, waiter);
      yield* record("pending").pipe(
        Effect.mapError(
          (cause) => new SecretPromptUnavailableError({ reason: "record_failed", cause }),
        ),
        Effect.tapError(() => Effect.sync(() => shellPrompts.delete(turnItemId))),
      );

      const withdraw = Effect.gen(function* () {
        const previous = yield* Ref.modify(waiter.state, (state) =>
          state === "open"
            ? (["open", "closed"] as const)
            : state === "answering"
              ? (["answering", "withdrawn"] as const)
              : ([state, state] as const),
        );
        if (previous !== "open") return;
        shellPrompts.delete(turnItemId);
        yield* record("cancelled").pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not close a secret prompt card", { cause }),
          ),
        );
      }).pipe(Effect.uninterruptible);

      const toOutcome = (reply: ShellAnswer): SecretPromptOutcome =>
        reply.type === "save" ? { status: "saved", value: reply.secret } : { status: "declined" };
      const outcome: Effect.Effect<SecretPromptOutcome> = Deferred.await(waiter.answer).pipe(
        Effect.timeoutOption(Duration.millis(input.timeoutMs ?? SECRET_PROMPT_TIMEOUT_MS)),
        Effect.flatMap((answered) =>
          Option.isSome(answered)
            ? Effect.succeed(toOutcome(answered.value))
            : Effect.gen(function* () {
                yield* withdraw;
                // An answer already being recorded when time ran out still wins.
                if ((yield* Ref.get(waiter.state)) !== "withdrawn") {
                  return { status: "timed_out" } as const;
                }
                const late = yield* Deferred.await(waiter.answer).pipe(
                  Effect.timeoutOption(Duration.seconds(10)),
                );
                return Option.isSome(late)
                  ? toOutcome(late.value)
                  : ({ status: "timed_out" } as const);
              }),
        ),
      );
      return { turnItemId, outcome, withdraw };
    }).pipe(Effect.withSpan("SecretRequests.prompt"));

  const answer: SecretRequests["Service"]["answer"] = (input) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.thread_id": input.threadId,
        "secret_request.answer": input.answer.type,
      });
      const records = yield* threadManagement
        .getThreadRecords(input.threadId, ["runs", "turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
      const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
      if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
        return yield* new SecretRequestError({ reason: "not_found" });
      }
      if (item.secretStatus !== "pending") {
        return yield* new SecretRequestError({ reason: "already_answered" });
      }
      // A shell prompt's liveness is its waiting process, not the run: a
      // background command can outlive the turn that started it.
      if (item.shellPrompt !== undefined) {
        return yield* answerShellPrompt(item.id, input.answer);
      }
      // The agent is waiting inside the run that asked; once it has ended,
      // nobody will ever receive the ref, so a value saved now would be lost.
      const run = records.runs.find((candidate) => candidate.id === item.runId);
      if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
      // Store first: the card only says saved once the value is kept. Create,
      // not set: a second answer racing this one must not replace the value.
      // A value already there on a card still pending is an earlier save whose
      // record failed and could not be cleaned up; recording it finishes that save.
      if (input.answer.type === "save") {
        const encoded = yield* encodeStored({
          projectId: records.thread.projectId,
          value: input.answer.secret.trim(),
          savedAt: yield* Clock.currentTimeMillis,
        }).pipe(Effect.orDie);
        yield* store
          .create(
            storeName(refFor(salt, input.threadId, item.id)),
            new TextEncoder().encode(encoded),
          )
          .pipe(
            Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
            Effect.mapError(
              (error) => new SecretRequestError({ reason: "store_failed", cause: error }),
            ),
          );
      }
      const secretStatus = input.answer.type === "save" ? "saved" : "declined";
      yield* threadManagement
        .dispatch({
          type: "secret_request.record",
          commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
          threadId: input.threadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          label: item.label,
          reason: item.reason,
          ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
          secretStatus,
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
          // The card still says pending, so the user can save again; the value
          // stored above would make that retry look already answered.
          Effect.tapError(() =>
            input.answer.type === "save"
              ? removeLogged(storeName(refFor(salt, input.threadId, item.id)))
              : Effect.void,
          ),
        );
      if (input.answer.type !== "save") return;
      // A request is answered once: if the agent's wait closed the card between
      // the checks above and this record, the record changed nothing. Nobody
      // will receive the ref, so the value is deleted rather than left to expire.
      const recorded = yield* threadManagement
        .getThreadRecords(input.threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        );
      const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
      if (card?.type === "secret_request" && card.secretStatus !== "saved") {
        yield* removeLogged(storeName(refFor(salt, input.threadId, item.id)));
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
    }).pipe(Effect.withSpan("SecretRequests.answer"));

  const savedRef: SecretRequests["Service"]["savedRef"] = (input) =>
    Effect.gen(function* () {
      const ref = refFor(salt, input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    });

  /** Removes a stored value; a failure is logged, since the value is still on disk. */
  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // get and remove are separate store calls; one consumer at a time keeps two
  // concurrent calls from both reading a ref before either deletes it.
  const consumeLock = yield* Semaphore.make(1);
  const consume: SecretRequests["Service"]["consume"] = (input) =>
    consumeRef(input).pipe(
      consumeLock.withPermits(1),
      Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
      Effect.tapError(() =>
        Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
      ),
      Effect.withSpan("SecretRequests.consume"),
    );

  const consumeRef = (input: { readonly ref: SecretRef; readonly projectId: ProjectId }) =>
    Effect.gen(function* () {
      if (!REF_PATTERN.test(input.ref))
        return yield* new SecretRequestError({ reason: "invalid_ref" });
      const stored = yield* store
        .get(storeName(input.ref))
        .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isNone(decoded) || decoded.value.projectId !== input.projectId) {
        return yield* new SecretRequestError({ reason: "ref_unavailable" });
      }
      if ((yield* Clock.currentTimeMillis) - decoded.value.savedAt > SECRET_REF_TTL_MS) {
        // The hourly sweep retries a removal that fails here.
        yield* removeLogged(storeName(input.ref));
        return yield* new SecretRequestError({ reason: "ref_expired" });
      }
      // One use: the value moves into whatever consumed it. If it cannot be
      // deleted, it is not handed out, so a ref is never used twice.
      if (!(yield* removeLogged(storeName(input.ref)))) {
        return yield* new SecretRequestError({ reason: "consume_failed" });
      }
      return decoded.value.value;
    });

  /**
   * Drops values nobody used before they expired, so an agent that never
   * consumed its ref does not leave the user's secret on disk.
   */
  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  // Once at startup, then hourly; a value lingers at most an hour past expiry.
  yield* sweepExpired;
  yield* sweepExpired.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({ answer, savedRef, consume, prompt });
});

export const layer = Layer.effect(SecretRequests, make);
