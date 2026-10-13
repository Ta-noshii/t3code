import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRequestAnswers,
  deriveBarItems,
  deriveBarRequest,
  deriveModelOptions,
  deriveThreadState,
  isListedThread,
  parseOp,
  resolveDefaultModel,
  toThreadRow,
} from "./model.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const threadId = ThreadId.make("thread-1");
const instanceId = ProviderInstanceId.make("codex");

const shell: OrchestrationV2ThreadShell = {
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: "Fix the trade page",
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  providerInstanceHistory: [],
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at("2026-10-13T10:00:00.000Z"),
  updatedAt: at("2026-10-13T11:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const completed = {
  status: "completed" as const,
  latestRunCompletedAt: at("2026-10-13T11:00:00.000Z"),
};

describe("deriveThreadState", () => {
  it("puts a pending request ahead of everything else", () => {
    expect(
      deriveThreadState(
        {
          ...shell,
          status: "running",
          snoozedUntil: at("2026-10-14T00:00:00.000Z"),
          pendingRuntimeRequest: {
            id: "request-1" as never,
            kind: "command",
            createdAt: at("2026-10-13T11:00:00.000Z"),
          },
        },
        NOW,
      ),
    ).toBe("waiting");
  });

  it("treats queued runs and live activity as working", () => {
    expect(deriveThreadState({ ...shell, status: "queued" }, NOW)).toBe("working");
    expect(deriveThreadState({ ...shell, activityRunStatus: "preparing" }, NOW)).toBe("working");
  });

  it("only snoozes until snoozedUntil passes", () => {
    const snoozed = { ...shell, ...completed, snoozedUntil: at("2026-10-13T13:00:00.000Z") };
    expect(deriveThreadState(snoozed, NOW)).toBe("snoozed");
    expect(deriveThreadState(snoozed, Date.parse("2026-10-13T14:00:00.000Z"))).toBe("unread");
  });

  it("shows a failure until the thread is visited", () => {
    const failed = {
      ...shell,
      status: "failed" as const,
      latestRunCompletedAt: at("2026-10-13T11:00:00.000Z"),
    };
    expect(deriveThreadState(failed, NOW)).toBe("failed");
    expect(
      deriveThreadState({ ...failed, lastVisitedAt: at("2026-10-13T11:30:00.000Z") }, NOW),
    ).toBe("idle");
    expect(deriveThreadState({ ...shell, lastError: "Provider crashed" }, NOW)).toBe("failed");
  });

  it("is unread after a completed run until visited, unless settled", () => {
    expect(deriveThreadState({ ...shell, ...completed }, NOW)).toBe("unread");
    expect(
      deriveThreadState(
        { ...shell, ...completed, lastVisitedAt: at("2026-10-13T11:05:00.000Z") },
        NOW,
      ),
    ).toBe("idle");
    expect(
      deriveThreadState({ ...shell, ...completed, settledAt: at("2026-10-13T11:01:00.000Z") }, NOW),
    ).toBe("settled");
    expect(
      deriveThreadState(
        {
          ...shell,
          ...completed,
          lastVisitedAt: at("2026-10-13T11:05:00.000Z"),
          settledAt: at("2026-10-13T11:01:00.000Z"),
          settledOverride: "active",
        },
        NOW,
      ),
    ).toBe("idle");
  });
});

describe("isListedThread", () => {
  it("lists top-level threads and forks but not subagents", () => {
    expect(isListedThread(shell)).toBe(true);
    const parentThreadId = ThreadId.make("thread-parent");
    const fork = {
      ...shell,
      lineage: {
        rootThreadId: parentThreadId,
        parentThreadId,
        relationshipToParent: "fork" as const,
      },
    };
    const subagent = {
      ...shell,
      lineage: {
        rootThreadId: parentThreadId,
        parentThreadId,
        relationshipToParent: "subagent" as const,
      },
    };
    expect(isListedThread(fork)).toBe(true);
    expect(isListedThread(subagent)).toBe(false);
  });
});

describe("toThreadRow", () => {
  it("fills the row from the shell and cuts the last line to one line", () => {
    const row = toThreadRow(
      {
        ...shell,
        status: "running",
        activeRunId: "run-1" as never,
        activityRunStartedAt: at("2026-10-13T11:58:00.000Z"),
        pinnedAt: at("2026-10-13T09:00:00.000Z"),
        latestVisibleMessage: {
          id: "message-1" as never,
          role: "assistant",
          text: `\n  First   line\nsecond line ${"x".repeat(300)}`,
          updatedAt: at("2026-10-13T11:59:00.000Z"),
        },
      },
      { projectTitle: "new-website", request: null, queuedCount: 2, latest: null },
      NOW,
    );
    expect(row).toEqual({
      id: "thread-1",
      projectId: "project-1",
      projectTitle: "new-website",
      title: "Fix the trade page",
      state: "working",
      request: null,
      lastLine: "First line",
      updatedAt: "2026-10-13T11:00:00.000Z",
      runStartedAt: "2026-10-13T11:58:00.000Z",
      activeRunId: "run-1",
      queuedCount: 2,
      pinned: true,
      snoozedUntil: null,
      error: null,
    });
  });

  it("names the request from the shell until its details are known", () => {
    const pending = {
      ...shell,
      pendingRuntimeRequest: {
        id: "request-1" as never,
        kind: "command" as const,
        createdAt: at("2026-10-13T11:00:00.000Z"),
      },
    };
    const extras = { projectTitle: "new-website", queuedCount: 0, latest: null };
    expect(toThreadRow(pending, { ...extras, request: null }, NOW).request).toEqual({
      id: "request-1",
      kind: "command",
      title: "Run a command in new-website",
      summary: "Run a command",
      decisions: [],
      hasQuestions: false,
    });
    const row = toThreadRow(
      pending,
      {
        ...extras,
        request: {
          id: "request-1",
          kind: "command",
          title: "Run a command in new-website",
          detail: "pnpm exec playwright test",
          decisions: ["accept", "decline"],
          questions: [],
          summary: "Run a command: pnpm exec playwright test",
        },
      },
      NOW,
    );
    expect(row.request?.decisions).toEqual(["accept", "decline"]);
    expect(row.lastLine).toBe("Run a command: pnpm exec playwright test");
  });
});

// --- Projection fixtures ------------------------------------------------------

let ordinal = 0;
function item(fields: Record<string, unknown>): OrchestrationV2TurnItem {
  ordinal += 1;
  return {
    id: `item-${ordinal}`,
    threadId,
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: at("2026-10-13T11:00:00.000Z"),
    ...fields,
  } as unknown as OrchestrationV2TurnItem;
}

const timeline = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  runs: ReadonlyArray<{ id: string; status: string }> = [],
) =>
  ({
    visibleTurnItems: items.map((entry, position) => ({ position, item: entry })),
    runs,
  }) as unknown as Pick<OrchestrationV2ThreadProjection, "visibleTurnItems" | "runs">;

describe("deriveBarItems", () => {
  it("maps messages and tools, skips reasoning and queued messages, keeps the newest", () => {
    const items = deriveBarItems(
      timeline(
        [
          item({ type: "user_message", text: "Fix the overflow", inputIntent: "message" }),
          item({ type: "reasoning", text: "thinking" }),
          item({
            type: "dynamic_tool",
            toolName: "Read",
            input: { file_path: "/repo/src/PreviewView.tsx" },
          }),
          item({
            type: "command_execution",
            input: "vp test PreviewView\n--watch",
            exitCode: 1,
          }),
          item({ type: "file_change", fileName: "src/trade.tsx", status: "running" }),
          item({ type: "assistant_message", text: "y".repeat(4100), streaming: false }),
          item({
            type: "error",
            failure: { class: "provider", message: "Rate limited", code: null, retryable: true },
          }),
          item({
            type: "user_message",
            runId: "run-2",
            text: "Queued follow-up",
            inputIntent: "message",
          }),
        ],
        [{ id: "run-2", status: "queued" }],
      ),
    );
    expect(items).toEqual([
      { kind: "user", text: "Fix the overflow" },
      { kind: "tool", text: "read PreviewView.tsx", status: "done" },
      { kind: "tool", text: "vp test PreviewView", status: "failed" },
      { kind: "tool", text: "edit trade.tsx", status: "running" },
      { kind: "assistant", text: "y".repeat(4000), truncated: true },
      { kind: "error", text: "Rate limited" },
    ]);
  });

  it("returns at most the limit, oldest first", () => {
    const many = Array.from({ length: 50 }, (_, index) =>
      item({ type: "user_message", text: `message ${index}`, inputIntent: "message" }),
    );
    const items = deriveBarItems(timeline(many));
    expect(items).toHaveLength(40);
    expect(items[0]).toEqual({ kind: "user", text: "message 10" });
    expect(items[39]).toEqual({ kind: "user", text: "message 49" });
  });
});

describe("requests", () => {
  const pendingRequest = (id: string, kind: string) => ({
    id,
    kind,
    status: "pending",
    responseCapability: { type: "live" },
    createdAt: at("2026-10-13T11:00:00.000Z"),
  });
  const requestProjection = (
    requests: ReadonlyArray<unknown>,
    turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  ) =>
    ({ runtimeRequests: requests, turnItems }) as unknown as Pick<
      OrchestrationV2ThreadProjection,
      "runtimeRequests" | "turnItems"
    >;

  it("describes an approval with the provider's decisions", () => {
    const projection = requestProjection(
      [pendingRequest("request-1", "command")],
      [
        item({
          type: "approval_request",
          requestId: "request-1",
          requestKind: "command",
          prompt: "pnpm exec playwright test trade.spec.ts",
          options: [
            { decision: "accept", label: "Run" },
            { decision: "decline", label: "Skip" },
          ],
        }),
      ],
    );
    expect(deriveBarRequest(projection, "new-website")).toEqual({
      id: "request-1",
      kind: "command",
      title: "Run a command in new-website",
      detail: "pnpm exec playwright test trade.spec.ts",
      decisions: ["accept", "decline"],
      questions: [],
      summary: "Run a command: pnpm exec playwright test trade.spec.ts",
    });
  });

  it("falls back to the web's default decisions", () => {
    const projection = requestProjection([pendingRequest("request-1", "file-change")], []);
    expect(deriveBarRequest(projection, null)?.decisions).toEqual([
      "accept",
      "acceptForSession",
      "decline",
      "cancel",
    ]);
  });

  const questionProjection = requestProjection(
    [pendingRequest("request-2", "user_input")],
    [
      item({
        type: "user_input_request",
        requestId: "request-2",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which pages?",
            multiSelect: true,
            options: [
              { label: "Trade", description: "The trade page", value: "trade" },
              { label: "Profile", description: "The profile page" },
            ],
          },
          {
            id: "notes",
            header: "Notes",
            question: "Anything else?",
            options: [],
          },
        ],
      }),
    ],
  );

  it("describes questions with no decisions", () => {
    const request = deriveBarRequest(questionProjection, "new-website");
    expect(request?.kind).toBe("user_input");
    expect(request?.decisions).toEqual([]);
    expect(request?.title).toBe("Answer 2 questions");
    expect(request?.questions[0]).toEqual({
      id: "scope",
      header: "Scope",
      question: "Which pages?",
      multiSelect: true,
      options: [
        { label: "Trade", description: "The trade page" },
        { label: "Profile", description: "The profile page" },
      ],
    });
    expect(request?.questions[1]?.multiSelect).toBe(false);
  });

  it("maps answer labels to option values", () => {
    expect(
      buildRequestAnswers(questionProjection, "request-2", {
        scope: ["Trade", "Profile"],
        notes: ["Keep the header"],
      }),
    ).toEqual({ scope: ["trade", "Profile"], notes: "Keep the header" });
  });
});

describe("launch options", () => {
  const provider = (fields: Record<string, unknown>) =>
    ({
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      models: [],
      ...fields,
    }) as unknown as ServerProvider;

  const providers = [
    provider({
      instanceId: "codex",
      displayName: "Codex",
      models: [
        { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true },
        { slug: "old", name: "Old", isCustom: false, isLegacy: true },
      ] as never,
    }),
    provider({
      instanceId: "codex-work",
      displayName: "Codex Work",
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false }] as never,
    }),
    provider({
      instanceId: "off",
      enabled: false,
      models: [{ slug: "x", name: "X", isCustom: false }] as never,
    }),
  ];

  it("lists models of usable instances and tells duplicates apart", () => {
    expect(deriveModelOptions(providers)).toEqual([
      { instanceId: "codex", model: "gpt-5.4", label: "GPT-5.4 (Codex)" },
      { instanceId: "codex-work", model: "gpt-5.4", label: "GPT-5.4 (Codex Work)" },
    ]);
  });

  it("keeps a usable configured default and replaces an unusable one", () => {
    const configured = { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5.4" };
    expect(resolveDefaultModel(providers, configured)).toEqual(configured);
    expect(
      resolveDefaultModel(providers, { instanceId: ProviderInstanceId.make("off"), model: "x" }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.4" });
  });
});

describe("parseOp", () => {
  it("parses ops and keeps their id", () => {
    expect(parseOp('{"op":"refresh","id":"1"}')).toEqual({
      ok: true,
      op: { op: "refresh", id: "1" },
    });
    expect(parseOp('{"op":"reply","id":"2","threadId":"t","text":"go"}')).toEqual({
      ok: true,
      op: { op: "reply", id: "2", threadId: "t", text: "go", mode: "auto" },
    });
    expect(parseOp('{"op":"answer","threadId":"t","requestId":"r","answers":{"q":"x"}}')).toEqual({
      ok: true,
      op: { op: "answer", threadId: "t", requestId: "r", answers: { q: ["x"] } },
    });
    expect(parseOp('{"op":"pin","threadId":"t"}')).toEqual({
      ok: true,
      op: { op: "pin", threadId: "t" },
    });
  });

  it("rejects bad lines with the id when there is one", () => {
    expect(parseOp("not json")).toEqual({ ok: false, message: "Op is not valid JSON" });
    expect(parseOp('{"op":"open","id":"3"}')).toEqual({
      ok: false,
      id: "3",
      message: "open needs threadId",
    });
    expect(parseOp('{"op":"reply","id":"4","threadId":"t","text":"x","mode":"later"}')).toEqual({
      ok: false,
      id: "4",
      message: "reply mode is auto, queue or steer",
    });
    expect(
      parseOp('{"op":"respond","id":"5","threadId":"t","requestId":"r","decision":"yes"}'),
    ).toMatchObject({ ok: false, id: "5" });
    expect(parseOp('{"op":"fly","id":"6"}')).toEqual({
      ok: false,
      id: "6",
      message: "Unknown op fly",
    });
  });
});
