import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  listSubagentModels,
  resolveSubagentModel,
  SUBAGENT_TITLE_PREFIX,
  subagentReplyOf,
  subagentStateOf,
  subagentTitle,
} from "./handlers.ts";

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
