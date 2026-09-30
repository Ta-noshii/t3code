import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  isProviderAvailable,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  type ServerProvider,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../../atomicWrite.ts";
import * as ServerConfig from "../../../config.ts";

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DEFAULT_SUBAGENT_WAIT_SECONDS,
  type ListSubagentModelsResult,
  SubagentBusyError,
  SubagentModelNotFoundError,
  SubagentNestingError,
  SubagentOperationFailedError,
  type SubagentResult,
  type SubagentStatus,
  SubagentsToolkit,
  SubagentThreadNotFoundError,
} from "./tools.ts";

/** Marks subagent threads in the sidebar. */
export const SUBAGENT_TITLE_PREFIX = "Subagent · ";
const MAX_TITLE_CHARS = 60;
const MAX_REPLY_CHARS = 40_000;
const POLL_INTERVAL = "1 second";

/** Providers a subagent can start on: installed, enabled, reachable, not signed out. */
export function usableProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      isProviderAvailable(provider) &&
      provider.status !== "error" &&
      provider.status !== "disabled" &&
      provider.auth.status !== "unauthenticated" &&
      provider.models.length > 0,
  );
}

export function listSubagentModels(
  providers: ReadonlyArray<ServerProvider>,
): ListSubagentModelsResult {
  return {
    providers: usableProviders(providers).map((provider) => ({
      provider: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? provider.driver,
      models: provider.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        aliases: model.aliases ?? [],
        isDefault: model.isDefault === true,
      })),
    })),
  };
}

export type ModelResolution =
  | {
      readonly _tag: "Resolved";
      readonly provider: ServerProvider;
      readonly model: string;
    }
  | { readonly _tag: "NotFound"; readonly detail: string };

/** Case-insensitive, and "muse spark", "muse-spark" and "muse_spark" compare equal. */
const lower = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "-");

/**
 * Finds the one model the agent means. Exact slug, name or alias matches win;
 * otherwise a partial match ("luna" for "gpt-6-luna") is used when it is unique.
 */
export function resolveSubagentModel(
  providers: ReadonlyArray<ServerProvider>,
  requestedModel: string,
  requestedProvider?: string,
): ModelResolution {
  let candidates = usableProviders(providers);
  if (requestedProvider !== undefined) {
    const wanted = lower(requestedProvider);
    candidates = candidates.filter((provider) =>
      [provider.instanceId, provider.driver, provider.displayName ?? ""].some(
        (label) => lower(label) === wanted,
      ),
    );
    if (candidates.length === 0) {
      return {
        _tag: "NotFound",
        detail: `No installed, signed-in provider is called "${requestedProvider}".`,
      };
    }
  }
  const wanted = lower(requestedModel);
  const pairs = candidates.flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })),
  );
  const exact = pairs.filter(({ model }) =>
    [model.slug, model.name, model.shortName ?? "", ...(model.aliases ?? [])].some(
      (label) => lower(label) === wanted,
    ),
  );
  const partial =
    exact.length > 0
      ? exact
      : pairs.filter(
          ({ model }) => lower(model.slug).includes(wanted) || lower(model.name).includes(wanted),
        );
  const [only, ...rest] = partial;
  if (only !== undefined && rest.length === 0) {
    return { _tag: "Resolved", provider: only.provider, model: only.model.slug };
  }
  if (only === undefined) {
    return { _tag: "NotFound", detail: "Nothing matched." };
  }
  const listed = partial
    .slice(0, 8)
    .map(({ provider, model }) => `${provider.instanceId}/${model.slug}`)
    .join(", ");
  return {
    _tag: "NotFound",
    detail: `It matches several models (${listed}${partial.length > 8 ? ", …" : ""}); pass the exact slug, or provider as well.`,
  };
}

/** The turn a caller is waiting on: whichever turn starts after `baselineTurnId`. */
export interface PendingTurn {
  readonly baselineTurnId: TurnId | null;
  /** ISO time the turn was dispatched; a session error after it means the start failed. */
  readonly dispatchedAt: string;
}

export interface SubagentState {
  readonly status: SubagentStatus;
  readonly turnId: TurnId | null;
  readonly error: string | null;
}

export function subagentStateOf(
  thread: Pick<
    OrchestrationThreadShell,
    "latestTurn" | "session" | "hasPendingApprovals" | "hasPendingUserInput"
  >,
  pending: PendingTurn | null,
): SubagentState {
  const turn = thread.latestTurn;
  const session = thread.session;
  const isNewTurn = turn !== null && (pending === null || turn.turnId !== pending.baselineTurnId);
  const turnId = isNewTurn ? turn.turnId : null;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    return { status: "needs_user", turnId, error: null };
  }
  if (!isNewTurn) {
    if (
      pending !== null &&
      session?.status === "error" &&
      session.updatedAt >= pending.dispatchedAt
    ) {
      return {
        status: "error",
        turnId: null,
        error: session.lastError ?? "The provider session failed to start.",
      };
    }
    return { status: "running", turnId: null, error: null };
  }
  switch (turn.state) {
    case "running":
      return { status: "running", turnId, error: null };
    case "completed":
      return { status: "completed", turnId, error: null };
    case "interrupted":
      return { status: "interrupted", turnId, error: null };
    case "error":
      return { status: "error", turnId, error: session?.lastError ?? null };
  }
}

/** The turn's last assistant message, or null while it is still streaming. */
export function subagentReplyOf(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text" | "turnId" | "streaming">>,
  turnId: TurnId,
): { readonly reply: string | null; readonly streaming: boolean } {
  const assistant = messages.filter(
    (message) => message.role === "assistant" && message.turnId === turnId,
  );
  if (assistant.some((message) => message.streaming)) {
    return { reply: null, streaming: true };
  }
  const last = assistant.findLast((message) => message.text.trim().length > 0);
  if (last === undefined) return { reply: null, streaming: false };
  const text = last.text.trim();
  return {
    reply:
      text.length > MAX_REPLY_CHARS
        ? `${text.slice(0, MAX_REPLY_CHARS)}\n\n[Cut at ${MAX_REPLY_CHARS} characters. The full reply is in the subagent's thread.]`
        : text,
    streaming: false,
  };
}

export function subagentTitle(prompt: string, title?: string): string {
  const source = (title ?? prompt).replace(/\s+/g, " ").trim();
  const cut = source.length > MAX_TITLE_CHARS ? `${source.slice(0, MAX_TITLE_CHARS - 1)}…` : source;
  return `${SUBAGENT_TITLE_PREFIX}${cut}`;
}

interface SubagentRecord {
  readonly parentThreadId: ThreadId;
  pending: PendingTurn | null;
}

/**
 * Which thread started each subagent, kept in the state directory so a parent
 * can still reach its subagents, and only its own, after a server restart.
 */
export const SUBAGENT_PARENTS_FILE = "subagents.json";
const SubagentParentsFile = Schema.fromJsonString(
  Schema.Struct({ parents: Schema.Record(Schema.String, Schema.String) }),
);
const decodeParentsFile = Schema.decodeUnknownEffect(SubagentParentsFile);
const encodeParentsFile = Schema.encodeSync(SubagentParentsFile);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const parentsPath = path.join(config.stateDir, SUBAGENT_PARENTS_FILE);
  const saveLock = yield* Semaphore.make(1);
  const failed =
    (operation: string) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<never, SubagentOperationFailedError> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new SubagentOperationFailedError({ operation, cause }));

  const records = new Map<ThreadId, SubagentRecord>();
  const saved = yield* fileSystem.readFileString(parentsPath).pipe(
    Effect.flatMap(decodeParentsFile),
    Effect.map((file) => file.parents),
    Effect.catch((cause) =>
      fileSystem.exists(parentsPath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.tap((exists) =>
          exists
            ? Effect.logWarning("could not read subagent parents; starting without them", {
                cause,
              })
            : Effect.void,
        ),
        Effect.as({} as Record<string, string>),
      ),
    ),
  );
  for (const [child, parent] of Object.entries(saved)) {
    records.set(ThreadId.make(child), { parentThreadId: ThreadId.make(parent), pending: null });
  }

  const saveParents = saveLock.withPermits(1)(
    Effect.suspend(() =>
      writeFileStringAtomically({
        filePath: parentsPath,
        contents: encodeParentsFile({
          parents: Object.fromEntries(
            [...records].map(([child, record]) => [child, record.parentThreadId]),
          ),
        }),
      }),
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(failed("save the subagent's parent")),
    ),
  );

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readShell = (threadId: ThreadId, operation: string) =>
    snapshots.getThreadShellById(threadId).pipe(Effect.catchCause(failed(operation)));

  const requireCaller = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("subagents");
    const caller = yield* readShell(scope.threadId, "read this thread");
    if (Option.isNone(caller)) {
      return yield* new SubagentThreadNotFoundError({ threadId: scope.threadId });
    }
    return caller.value;
  });

  /** A subagent the calling thread started. */
  const requireChild = Effect.fn("SubagentsToolkit.requireChild")(function* (rawThreadId: string) {
    const caller = yield* requireCaller;
    const threadId = ThreadId.make(rawThreadId);
    const record = records.get(threadId);
    if (record === undefined || record.parentThreadId !== caller.id) {
      return yield* new SubagentThreadNotFoundError({ threadId: rawThreadId });
    }
    const child = yield* readShell(threadId, "read the subagent's thread");
    if (Option.isNone(child)) {
      return yield* new SubagentThreadNotFoundError({ threadId: rawThreadId });
    }
    return { caller, child: child.value, record };
  });

  const resultOf = (thread: OrchestrationThreadShell, state: SubagentState, reply: string | null) =>
    ({
      threadId: thread.id,
      title: thread.title,
      provider: thread.modelSelection.instanceId,
      model: thread.modelSelection.model,
      status: state.status,
      reply,
      error: state.error,
    }) satisfies SubagentResult;

  /** Polls the child until its pending turn ends (and its reply has finished streaming) or time runs out. */
  const waitForTurn = Effect.fn("SubagentsToolkit.waitForTurn")(function* (
    threadId: ThreadId,
    record: SubagentRecord,
    waitSeconds: number,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + waitSeconds * 1000;
    while (true) {
      const shell = yield* readShell(threadId, "read the subagent's thread");
      if (Option.isNone(shell)) {
        return yield* new SubagentThreadNotFoundError({ threadId });
      }
      const state = subagentStateOf(shell.value, record.pending);
      if (state.status !== "running" && state.status !== "needs_user") {
        let reply: string | null = null;
        let streaming = false;
        if (state.turnId !== null) {
          const detail = yield* snapshots
            .getThreadDetailById(threadId, { activityKinds: [] })
            .pipe(Effect.catchCause(failed("read the subagent's reply")));
          if (Option.isSome(detail)) {
            ({ reply, streaming } = subagentReplyOf(detail.value.messages, state.turnId));
          }
        }
        if (!streaming) {
          record.pending = null;
          return resultOf(shell.value, state, reply);
        }
      }
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return resultOf(shell.value, state, null);
      }
      yield* Effect.sleep(POLL_INTERVAL);
    }
  });

  const startTurn = Effect.fn("SubagentsToolkit.startTurn")(function* (
    child: OrchestrationThreadShell,
    record: SubagentRecord,
    prompt: string,
  ) {
    const dispatchedAt = yield* nowIso;
    record.pending = { baselineTurnId: child.latestTurn?.turnId ?? null, dispatchedAt };
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:mcp-subagent-turn:${child.id}:${yield* uuid}`),
        threadId: child.id,
        message: {
          messageId: MessageId.make(yield* uuid),
          role: "user",
          text: prompt,
          attachments: [],
        },
        modelSelection: child.modelSelection,
        runtimeMode: child.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: dispatchedAt,
      })
      .pipe(Effect.catchCause(failed("start the subagent's turn")));
  });

  return SubagentsToolkit.of({
    list_subagent_models: () =>
      Effect.gen(function* () {
        yield* McpInvocationContext.requireMcpCapability("subagents");
        return listSubagentModels(yield* registry.getProviders);
      }),

    start_subagent: (input) =>
      Effect.gen(function* () {
        const caller = yield* requireCaller;
        if (records.has(caller.id)) {
          return yield* new SubagentNestingError({});
        }
        const resolution = resolveSubagentModel(
          yield* registry.getProviders,
          input.model,
          input.provider,
        );
        if (resolution._tag === "NotFound") {
          return yield* new SubagentModelNotFoundError({
            requested:
              input.provider === undefined ? input.model : `${input.provider}/${input.model}`,
            detail: resolution.detail,
          });
        }
        const threadId = ThreadId.make(yield* uuid);
        const createdAt = yield* nowIso;
        const modelSelection = {
          instanceId: resolution.provider.instanceId,
          model: resolution.model,
        };
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(`server:mcp-subagent-create:${threadId}:${yield* uuid}`),
            threadId,
            projectId: caller.projectId,
            title: subagentTitle(input.prompt, input.title),
            modelSelection,
            runtimeMode: caller.runtimeMode,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            // Same checkout as the parent, so the subagent sees and edits the same files.
            branch: caller.branch,
            worktreePath: caller.worktreePath,
            createdAt,
          })
          .pipe(Effect.catchCause(failed("create the subagent's thread")));
        const record: SubagentRecord = { parentThreadId: caller.id, pending: null };
        records.set(threadId, record);
        yield* saveParents;
        const child = yield* readShell(threadId, "read the subagent's thread");
        if (Option.isNone(child)) {
          return yield* new SubagentThreadNotFoundError({ threadId });
        }
        yield* startTurn(child.value, record, input.prompt);
        return yield* waitForTurn(
          threadId,
          record,
          input.waitSeconds ?? DEFAULT_SUBAGENT_WAIT_SECONDS,
        );
      }),

    message_subagent: (input) =>
      Effect.gen(function* () {
        const { child, record } = yield* requireChild(input.threadId);
        const state = subagentStateOf(child, record.pending);
        if (state.status === "running" || state.status === "needs_user") {
          return yield* new SubagentBusyError({ threadId: child.id });
        }
        yield* startTurn(child, record, input.prompt);
        return yield* waitForTurn(
          child.id,
          record,
          input.waitSeconds ?? DEFAULT_SUBAGENT_WAIT_SECONDS,
        );
      }),

    wait_for_subagent: (input) =>
      Effect.gen(function* () {
        const { child, record } = yield* requireChild(input.threadId);
        return yield* waitForTurn(
          child.id,
          record,
          input.waitSeconds ?? DEFAULT_SUBAGENT_WAIT_SECONDS,
        );
      }),

    stop_subagent: (input) =>
      Effect.gen(function* () {
        const { child, record } = yield* requireChild(input.threadId);
        const state = subagentStateOf(child, record.pending);
        if (state.status === "running" || state.status === "needs_user") {
          yield* engine
            .dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`server:mcp-subagent-stop:${child.id}:${yield* uuid}`),
              threadId: child.id,
              ...(state.turnId === null ? {} : { turnId: state.turnId }),
              createdAt: yield* nowIso,
            })
            .pipe(Effect.catchCause(failed("stop the subagent")));
        }
        return yield* waitForTurn(child.id, record, 10);
      }),
  });
});

export const SubagentsToolkitHandlersLive = SubagentsToolkit.toLayer(make);
