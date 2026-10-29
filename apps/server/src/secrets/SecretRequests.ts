// Answers stay in the secret store behind one-use refs; orchestration records only request status.
// Consuming tools keep values out of transcripts, projections, clients and model context.
// A `file` request instead moves its value to an owner-only file for the agent's own shell.
// A prompt from a process in the agent's shell (`t3 secret prompt`) shows the same card, but
// the answer goes back to that waiting process through memory and is never stored.
// Withdrawing the prompt closes the card as cancelled.
import { pipe } from "effect/Function";
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
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;

const refFor = (salt: string, threadId: ThreadId, turnItemId: string) =>
  SecretRef.make(
    `${SECRET_REF_PREFIX}${NodeCrypto.createHmac("sha256", salt)
      .update(`${threadId}\u0000${turnItemId}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

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
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Moves a saved `file` request's value to an owner-only file and returns its path. */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
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
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  // Beside the store's own files so the same owner-only directory and cleanup rules apply.
  const filesDir = store.directory === undefined ? undefined : path.join(store.directory, "files");

  const salt = Buffer.from(
    yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie),
  ).toString("hex");

  // Open shell prompts by turn item. Memory only: after a restart the asking
  // process has lost its connection, and recovery closes the card.
  const shellPrompts = new Map<TurnItemId, ShellPromptWaiter>();

  const answerShellPrompt = Effect.fn("SecretRequests.answerShellPrompt")(function* (
    turnItemId: TurnItemId,
    reply: ShellAnswer,
  ) {
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

  const prompt: SecretRequests["Service"]["prompt"] = Effect.fn("SecretRequests.prompt")(
    function* (input) {
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
    },
  );

  const answer: SecretRequests["Service"]["answer"] = Effect.fn("SecretRequests.answer")(
    function* (input) {
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
      const run = records.runs.find((candidate) => candidate.id === item.runId);
      if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
      // Create before recording so racing answers cannot overwrite values or show saved before storage.
      // Existing values on pending cards finish earlier saves whose recording failed.
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
          ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
          secretStatus,
        })
        .pipe(
          Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
          // Clear failed saves so the pending card can be answered again.
          Effect.tapError(() =>
            input.answer.type === "save"
              ? pipe(refFor(salt, input.threadId, item.id), storeName, removeLogged)
              : Effect.void,
          ),
        );
      if (input.answer.type !== "save") return;
      // The wait may have closed the card; delete unrecorded answers because no one receives their refs.
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
        yield* pipe(refFor(salt, input.threadId, item.id), storeName, removeLogged);
        return yield* new SecretRequestError({ reason: "agent_stopped" });
      }
    },
  );

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = refFor(salt, input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    },
  );

  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // Serialize get/remove so concurrent consumers cannot read the same one-use ref.
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

  /** A live ref's value, left in the store. */
  const readRef = Effect.fn("SecretRequests.readRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
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
      yield* removeLogged(storeName(input.ref));
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    return decoded.value.value;
  });

  const consumeRef = Effect.fn("SecretRequests.consumeRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    const value = yield* readRef(input);
    // One use: the value moves into whatever consumed it. If it cannot be
    // deleted, it is not handed out, so a ref is never used twice.
    if (!(yield* removeLogged(storeName(input.ref)))) {
      return yield* new SecretRequestError({ reason: "consume_failed" });
    }
    return value;
  });

  const saveToFile: SecretRequests["Service"]["saveToFile"] = Effect.fn(
    "SecretRequests.saveToFile",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // Only a card that told the user the agent's commands can read the value may write it out.
    if (
      item?.type !== "secret_request" ||
      item.secretStatus !== "saved" ||
      item.delivery !== "file"
    ) {
      return yield* new SecretRequestError({ reason: "not_a_file_request" });
    }
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const ref = refFor(salt, input.threadId, item.id);
    const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
    return yield* Effect.gen(function* () {
      // One use: the file counts as delivered only once the stored copy is gone. A retry with the
      // same clientRequestId gets the file the first call wrote and finishes that removal.
      const removeStored = removeLogged(storeName(ref)).pipe(
        Effect.flatMap((removed) =>
          removed ? Effect.succeed(file) : new SecretRequestError({ reason: "consume_failed" }),
        ),
      );
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        return yield* removeStored;
      }
      // The stored value goes only after the file is complete, so a failed write can retry.
      const value = yield* readRef({ ref, projectId: records.thread.projectId });
      const partial = `${file}.partial`;
      yield* fileSystem.makeDirectory(filesDir, { recursive: true, mode: 0o700 }).pipe(
        Effect.andThen(fileSystem.chmod(filesDir, 0o700)),
        Effect.andThen(fileSystem.remove(partial, { force: true })),
        // `wx` never follows or replaces an existing path.
        Effect.andThen(
          fileSystem.writeFile(partial, new TextEncoder().encode(value), {
            flag: "wx",
            mode: 0o600,
          }),
        ),
        Effect.andThen(fileSystem.rename(partial, file)),
        Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
      );
      return yield* removeStored;
    }).pipe(consumeLock.withPermits(1));
  });

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
  const sweepExpiredFiles = Effect.gen(function* () {
    if (filesDir === undefined || !(yield* fileSystem.exists(filesDir))) return;
    const now = yield* Clock.currentTimeMillis;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(filesDir, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (Option.exists(mtime, (time) => now - time.getTime() <= SECRET_REF_TTL_MS)) continue;
      yield* fileSystem.remove(file);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );
  const sweep = Effect.andThen(sweepExpired, sweepExpiredFiles);
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({ answer, savedRef, consume, saveToFile, prompt });
});

export const layer = Layer.effect(SecretRequests, make);
