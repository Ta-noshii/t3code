import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import * as ServerConfig from "../../../config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  listSubagentModels,
  SubagentsToolkitHandlersLive,
  resolveSubagentModel,
  SUBAGENT_TITLE_PREFIX,
  subagentReplyOf,
  subagentStateOf,
  subagentTitle,
} from "./handlers.ts";
import { SubagentsToolkit } from "./tools.ts";

const model = (slug: string, name: string, aliases?: ReadonlyArray<string>) => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
  ...(aliases === undefined ? {} : { aliases }),
});

const provider = (
  instanceId: string,
  driver: string,
  models: ServerProvider["models"],
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  driver: ProviderDriverKind.make(driver),
  instanceId: ProviderInstanceId.make(instanceId),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  checkedAt: "2026-09-30T00:00:00Z",
  auth: { status: "authenticated" },
  models,
  skills: [],
  slashCommands: [],
  ...overrides,
});

const claude = provider("claudeAgent", "claudeAgent", [
  model("claude-opus-5-5", "Claude Opus 5.5", ["opus"]),
  model("claude-sonnet-5", "Claude Sonnet 5", ["sonnet"]),
]);
const codex = provider("codex", "codex", [
  model("gpt-6-luna", "GPT-6 Luna"),
  model("gpt-6", "GPT-6"),
]);
const signedOutCursor = provider("cursor", "cursor", [model("composer-3", "Composer 3")], {
  auth: { status: "unauthenticated" },
});

describe("resolveSubagentModel", () => {
  const providers = [claude, codex, signedOutCursor];

  it("resolves a unique partial name to its provider", () => {
    const resolved = resolveSubagentModel(providers, "luna");
    expect(resolved._tag).toBe("Resolved");
    if (resolved._tag !== "Resolved") return;
    expect(resolved.provider.instanceId).toBe("codex");
    expect(resolved.model).toBe("gpt-6-luna");
  });

  it("prefers an exact match over partial ones", () => {
    // "gpt-6" is also part of "gpt-6-luna".
    const resolved = resolveSubagentModel(providers, "GPT-6");
    expect(resolved._tag === "Resolved" && resolved.model).toBe("gpt-6");
  });

  it("matches aliases", () => {
    const resolved = resolveSubagentModel(providers, "opus");
    expect(resolved._tag === "Resolved" && resolved.model).toBe("claude-opus-5-5");
  });

  it("names the candidates when a partial match is ambiguous", () => {
    const resolved = resolveSubagentModel(providers, "claude");
    expect(resolved._tag).toBe("NotFound");
    if (resolved._tag !== "NotFound") return;
    expect(resolved.detail).toContain("claudeAgent/claude-opus-5-5");
    expect(resolved.detail).toContain("claudeAgent/claude-sonnet-5");
  });

  it("narrows by provider driver or instance", () => {
    const shared = provider("codex-work", "codex", [model("gpt-6-luna", "GPT-6 Luna")]);
    expect(resolveSubagentModel([codex, shared], "luna")._tag).toBe("NotFound");
    const resolved = resolveSubagentModel([codex, shared], "luna", "codex-work");
    expect(resolved._tag === "Resolved" && resolved.provider.instanceId).toBe("codex-work");
  });

  it("treats spaces and hyphens alike, and asks for the provider when two offer the model", () => {
    const opencode = provider("opencode", "opencode", [
      model("opencode/muse-spark-1.3-contributor-free", "Muse Spark 1.3 Free"),
    ]);
    const cursor = provider("cursor", "cursor", [model("muse-spark-1.3", "Muse Spark 1.3")]);
    const ambiguous = resolveSubagentModel([opencode, cursor], "muse spark");
    expect(ambiguous._tag === "NotFound" && ambiguous.detail).toContain(
      "opencode/opencode/muse-spark-1.3-contributor-free",
    );
    const resolved = resolveSubagentModel([opencode, cursor], "muse spark", "OpenCode");
    expect(resolved._tag === "Resolved" && resolved.model).toBe(
      "opencode/muse-spark-1.3-contributor-free",
    );
  });

  it("skips signed-out providers", () => {
    expect(resolveSubagentModel(providers, "composer")._tag).toBe("NotFound");
    expect(listSubagentModels(providers).providers.map((entry) => entry.provider)).toEqual([
      "claudeAgent",
      "codex",
    ]);
  });
});

const turnA = TurnId.make("turn-a");
const turnB = TurnId.make("turn-b");
const shell = (
  overrides: Partial<Parameters<typeof subagentStateOf>[0]> = {},
): Parameters<typeof subagentStateOf>[0] => ({
  latestTurn: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...overrides,
});
const latestTurn = (turnId: TurnId, state: "running" | "completed" | "interrupted" | "error") => ({
  turnId,
  state,
  requestedAt: "2026-09-30T00:00:00Z",
  startedAt: "2026-09-30T00:00:00Z",
  completedAt: null,
  assistantMessageId: null,
});

describe("subagentStateOf", () => {
  const pending = { baselineTurnId: turnA, dispatchedAt: "2026-09-30T00:00:05Z" };

  it("keeps reporting running until a turn after the baseline appears", () => {
    const state = subagentStateOf(shell({ latestTurn: latestTurn(turnA, "completed") }), pending);
    expect(state).toEqual({ status: "running", turnId: null, error: null });
  });

  it("reports the new turn once it ends", () => {
    const state = subagentStateOf(shell({ latestTurn: latestTurn(turnB, "completed") }), pending);
    expect(state).toEqual({ status: "completed", turnId: turnB, error: null });
  });

  it("reports a session that failed after the dispatch as an error", () => {
    const state = subagentStateOf(
      shell({
        latestTurn: latestTurn(turnA, "completed"),
        session: {
          threadId: ThreadId.make("child"),
          status: "error",
          providerName: null,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Codex is not signed in.",
          updatedAt: "2026-09-30T00:00:06Z",
        },
      }),
      pending,
    );
    expect(state).toEqual({ status: "error", turnId: null, error: "Codex is not signed in." });
  });

  it("surfaces approvals the user has to answer", () => {
    const state = subagentStateOf(
      shell({ latestTurn: latestTurn(turnB, "running"), hasPendingApprovals: true }),
      pending,
    );
    expect(state.status).toBe("needs_user");
  });

  it("without a pending turn, reports the latest one", () => {
    const state = subagentStateOf(shell({ latestTurn: latestTurn(turnA, "interrupted") }), null);
    expect(state.status).toBe("interrupted");
  });
});

describe("subagentReplyOf", () => {
  const message = (
    role: "user" | "assistant",
    text: string,
    turnId: TurnId | null,
    streaming = false,
  ) => ({ role, text, turnId, streaming });

  it("returns the turn's last non-empty assistant message", () => {
    const reply = subagentReplyOf(
      [
        message("assistant", "old answer", turnA),
        message("user", "next task", null),
        message("assistant", "Looking at the files.", turnB),
        message("assistant", "Done: the bug was in parse().", turnB),
        message("assistant", "  ", turnB),
      ],
      turnB,
    );
    expect(reply).toEqual({ reply: "Done: the bug was in parse().", streaming: false });
  });

  it("waits while the reply is still streaming", () => {
    expect(subagentReplyOf([message("assistant", "Done", turnB, true)], turnB)).toEqual({
      reply: null,
      streaming: true,
    });
  });
});

describe("subagentTitle", () => {
  it("prefixes and shortens the prompt", () => {
    const title = subagentTitle(`Review   the diff\n${"x".repeat(100)}`);
    expect(title.startsWith(`${SUBAGENT_TITLE_PREFIX}Review the diff x`)).toBe(true);
    expect(title.length).toBe(SUBAGENT_TITLE_PREFIX.length + 60);
  });
});

const PROJECT_ID = ProjectId.make("project-1");
const PARENT_ID = ThreadId.make("parent");
const SIBLING_ID = ThreadId.make("sibling");

const threadShell = (id: ThreadId, title: string): OrchestrationThreadShell => ({
  id,
  projectId: PROJECT_ID,
  title,
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/x",
  worktreePath: "/worktrees/feature-x",
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

/**
 * A fake engine whose turns complete at once with a canned reply, over a state
 * directory that outlives one toolkit instance, the way a server restart does.
 */
/** A fresh T3 home, removed when the test's scope closes. */
const tempBaseDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-subagents-" });
}).pipe(Effect.provide(NodeServices.layer));

// Module-wide, so a restarted harness never reuses a turn id.
let turns = 0;
const makeHarness = Effect.fn("makeSubagentsHarness")(function* (baseDir: string) {
  const threads = new Map<ThreadId, OrchestrationThreadShell>([
    [PARENT_ID, threadShell(PARENT_ID, "Parent")],
    [SIBLING_ID, threadShell(SIBLING_ID, "Sibling")],
  ]);
  const messages = new Map<ThreadId, Array<OrchestrationMessage>>();
  const commands: Array<OrchestrationCommand> = [];
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.sync(() => {
      commands.push(command);
      if (command.type === "thread.create") {
        threads.set(command.threadId, {
          ...threadShell(command.threadId, command.title),
          modelSelection: command.modelSelection,
          branch: command.branch,
          worktreePath: command.worktreePath,
        });
      }
      if (command.type === "thread.turn.start") {
        const turnId = TurnId.make(`turn-${++turns}`);
        const thread = threads.get(command.threadId)!;
        threads.set(command.threadId, {
          ...thread,
          latestTurn: {
            turnId,
            state: "completed",
            requestedAt: command.createdAt,
            startedAt: command.createdAt,
            completedAt: command.createdAt,
            assistantMessageId: null,
          },
        });
        messages.set(command.threadId, [
          ...(messages.get(command.threadId) ?? []),
          {
            id: MessageId.make(`reply-${turns}`),
            role: "assistant",
            text: `Answer to: ${command.message.text}`,
            turnId,
            streaming: false,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        ]);
      }
      return { sequence: commands.length };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
      getThreadDetailById: (threadId) =>
        Effect.succeed(
          Option.some({ messages: messages.get(threadId) ?? [] } as unknown as OrchestrationThread),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([claude, codex]) }),
    ServerConfig.layerTest(process.cwd(), baseDir),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const toolkit = yield* SubagentsToolkit.pipe(
    Effect.provide(SubagentsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof SubagentsToolkit.tools>(
    caller: ThreadId,
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof SubagentsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        threadId: caller,
        providerSessionId: "session-1",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set<McpInvocationContext.McpCapability>(["subagents"]),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { call, commands, threads };
});

describe("subagents toolkit", () => {
  it.effect("starts a subagent on another provider, on the parent's checkout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const harness = yield* makeHarness(baseDir);
        const result = yield* harness.call(PARENT_ID, "start_subagent", {
          prompt: "Review parse()",
          model: "luna",
        });
        expect(result).toMatchObject({
          title: `${SUBAGENT_TITLE_PREFIX}Review parse()`,
          provider: "codex",
          model: "gpt-6-luna",
          status: "completed",
          reply: "Answer to: Review parse()",
        });
        expect(harness.threads.get(ThreadId.make(result.threadId))).toMatchObject({
          branch: "feature/x",
          worktreePath: "/worktrees/feature-x",
        });
      }),
    ),
  );

  it.effect("keeps each subagent tied to its parent across a restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* tempBaseDir;
        const first = yield* makeHarness(baseDir);
        const started = yield* first.call(PARENT_ID, "start_subagent", {
          prompt: "Find the bug",
          model: "gpt-6-luna",
        });
        const childId = ThreadId.make(started.threadId);

        const restarted = yield* makeHarness(baseDir);
        restarted.threads.set(childId, first.threads.get(childId)!);

        const again = yield* restarted.call(PARENT_ID, "message_subagent", {
          threadId: childId,
          prompt: "And the fix?",
        });
        expect(again.reply).toBe("Answer to: And the fix?");

        const sibling = yield* restarted
          .call(SIBLING_ID, "wait_for_subagent", { threadId: childId })
          .pipe(Effect.flip);
        expect(sibling._tag).toBe("SubagentThreadNotFoundError");

        const nested = yield* restarted
          .call(childId, "start_subagent", { prompt: "Help", model: "opus" })
          .pipe(Effect.flip);
        expect(nested._tag).toBe("SubagentNestingError");
      }),
    ),
  );
});
