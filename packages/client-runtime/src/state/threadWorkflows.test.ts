import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import {
  buildEarlierConversationTranscript,
  canDetachThreadProviderSession,
  canForkProjectedAssistantItem,
  deriveThreadQueueWorkflowState,
  planEditInNewThread,
  resolveLatestMergeBackRun,
  threadSupportsProviderHandoff,
} from "./threadWorkflows.ts";

const capabilities = (input?: {
  readonly queued?: boolean;
  readonly steer?: boolean;
  readonly restartSteer?: boolean;
  readonly nativeFork?: boolean;
  readonly portableFork?: boolean;
}) =>
  ({
    turns: {
      supportsQueuedMessages: input?.queued ?? false,
      supportsActiveSteering: input?.steer ?? false,
      supportsSteeringByInterruptRestart: input?.restartSteer ?? false,
    },
    threads: {
      canForkThread: input?.nativeFork ?? false,
      canForkFromTurn: input?.nativeFork ?? false,
    },
    identity: { nativeThreadIds: input?.nativeFork ? "strong" : "none" },
    context: { supportsFullThreadHandoff: input?.portableFork ?? false },
  }) as never;

describe("thread workflows", () => {
  it("allows a completed thread to switch providers after its session detaches", () => {
    const projection = {
      thread: {
        id: "thread",
        activeProviderThreadId: "provider-thread",
        modelSelection: { instanceId: "cursor", model: "grok-4.7" },
      },
      runs: [{ id: "run", status: "completed" }],
      providerSessions: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerInstanceId: "cursor",
          providerSessionId: "detached-session",
          nativeThreadRef: { driver: "cursor", nativeId: "agent-123", strength: "strong" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;

    expect(threadSupportsProviderHandoff(projection)).toBe(true);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        runs: [{ ...projection.runs[0]!, status: "running" }],
      }),
    ).toBe(false);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
      }),
    ).toBe(false);
  });

  it("sorts queued messages and gates reorder and promotion from capabilities", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "later", status: "queued", userMessageId: "message-later", ordinal: 3 },
        {
          id: "first",
          status: "queued",
          userMessageId: "message-first",
          ordinal: 2,
          queuePosition: 1,
        },
      ],
      messages: [
        {
          id: "message-first",
          text: "First",
          attachments: [
            {
              type: "image",
              id: "attachment-first",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 64,
            },
          ],
        },
        { id: "message-later", text: "Later" },
      ],
      providerTurns: [
        {
          id: "provider-turn-active",
          runAttemptId: "attempt-active",
          status: "running",
        },
      ],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, restartSteer: true }),
        },
      ],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["first", "First"],
      ["later", "Later"],
    ]);
    expect(state.queuedRuns.map(({ attachments }) => attachments.map(({ id }) => id))).toEqual([
      ["attachment-first"],
      [],
    ]);
    expect(state.activeRun?.id).toBe("active");
    expect(state.canReorder).toBe(true);
    expect(state.canPromoteToSteer).toBe(true);
  });

  it("keeps held messages visible and clears the hold when they leave the queue", () => {
    for (const status of ["queued", "cancelled", "starting"] as const) {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: null },
        runs: [{ id: "held", status, userMessageId: "message", ordinal: 1, queueHeld: true }],
        messages: [{ id: "message", text: "Saved message" }],
        providerThreads: [],
        providerTurns: [],
        providerSessions: [],
      } as never);
      expect(state.isHeld).toBe(status === "queued");
      expect(state.queuedRuns.map(({ text }) => text)).toEqual(
        status === "queued" ? ["Saved message"] : [],
      );
    }
  });

  it("hides automatic completion delivery from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: null },
      runs: [
        {
          id: "provider-wake",
          status: "queued",
          userMessageId: "provider-wake",
          ordinal: 4,
          queuePosition: 3,
        },
        {
          id: "automatic",
          status: "queued",
          userMessageId: "message-automatic",
          ordinal: 2,
          queuePosition: 1,
        },
        {
          id: "visible",
          status: "queued",
          userMessageId: "message-visible",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        {
          id: "provider-wake",
          text: "Model-facing text",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Monitor updated",
          },
        },
        {
          id: "message-automatic",
          text: "A delegated task reached a terminal state.",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message-visible", text: "Visible queued message" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["visible", "Visible queued message"],
    ]);
  });

  it("removes only the promoted head from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "promoted",
          status: "starting",
          userMessageId: "message-promoted",
          providerThreadId: "provider-thread",
          ordinal: 2,
          queuePosition: null,
        },
        {
          id: "still-queued",
          status: "queued",
          userMessageId: "message-still-queued",
          providerThreadId: "provider-thread",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        { id: "message-promoted", text: "Run now" },
        { id: "message-still-queued", text: "Wait longer" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.activeRun?.id).toBe("promoted");
    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["still-queued", "Wait longer"],
    ]);
  });

  it.each(["preparing", "starting", "waiting"] as const)(
    "does not promote queued work into a %s run",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: "provider-thread" },
        runs: [
          {
            id: "active",
            status,
            providerThreadId: "provider-thread",
            activeAttemptId: "attempt-active",
            ordinal: 1,
          },
          { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
        ],
        messages: [{ id: "message", text: "Queued" }],
        providerTurns: [
          {
            id: "provider-turn-active",
            runAttemptId: "attempt-active",
            status: status === "waiting" ? "completed" : "starting",
          },
        ],
        providerThreads: [
          {
            id: "provider-thread",
            appThreadId: "thread",
            providerSessionId: "provider-session",
          },
        ],
        providerSessions: [
          {
            id: "provider-session",
            status: "running",
            capabilities: capabilities({ queued: true, steer: true }),
          },
        ],
      } as never);

      expect(state.canPromoteToSteer).toBe(false);
    },
  );

  it("does not promote queued work until the running provider turn is projected", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
      ],
      messages: [{ id: "message", text: "Queued" }],
      providerTurns: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, steer: true }),
        },
      ],
    } as never);

    expect(state.canPromoteToSteer).toBe(false);
  });

  it("does not expose known unsupported queue or fork actions", () => {
    const projection = {
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [{ id: "queued", status: "queued", userMessageId: "message", ordinal: 1 }],
      messages: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "ready",
          capabilities: capabilities(),
        },
      ],
    } as never;
    const queue = deriveThreadQueueWorkflowState(projection);
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(queue.canReorder).toBe(false);
    expect(queue.canPromoteToSteer).toBe(false);
    expect(canForkProjectedAssistantItem({ projectedItem, capabilities: capabilities() })).toBe(
      false,
    );
    expect(canDetachThreadProviderSession(projection)).toBe(true);
  });

  it("allows native, portable, and capability-unknown exact-run forks", () => {
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ nativeFork: true }),
      }),
    ).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ portableFork: true }),
      }),
    ).toBe(true);
    expect(canForkProjectedAssistantItem({ projectedItem })).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem: {
          item: { type: "assistant_message", runId: "run", status: "running" },
        } as never,
      }),
    ).toBe(false);
  });

  it("merges the newest provider-finished run while checkpoint capture is pending", () => {
    const projection = {
      runs: [
        { id: "newest-queued", status: "queued", ordinal: 3 },
        { id: "older-completed", status: "completed", ordinal: 1 },
        { id: "newest-finished", status: "waiting", ordinal: 2 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it("does not let a stale completed run later in storage order hide the waiting checkpoint", () => {
    const projection = {
      runs: [
        { id: "newest-finished", status: "waiting", ordinal: 2 },
        { id: "older-completed", status: "completed", ordinal: 1 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it.each(["preparing", "starting", "running"] as const)(
    "does not merge older history while a newer run is %s",
    (status) => {
      const projection = {
        runs: [
          { id: "older-completed", status: "completed", ordinal: 1 },
          { id: "newer-active", status, ordinal: 2 },
        ],
      } as never;

      expect(resolveLatestMergeBackRun(projection)).toBeNull();
    },
  );
});

describe("edit in new thread", () => {
  const loaded = { hasEarlierHistory: false };
  const row = (
    sourceThreadId: string,
    item: {
      readonly type: "user_message" | "assistant_message" | "reasoning";
      readonly id: string;
      readonly runId: string | null;
      readonly text?: string;
      readonly inputIntent?: string;
      readonly attachments?: ReadonlyArray<{ readonly name: string }>;
    },
  ) =>
    ({
      sourceThreadId,
      item: {
        ...item,
        messageId: item.id,
        text: item.text ?? "",
        attachments: item.attachments ?? [],
      },
    }) as never;

  it("forks at the end of the run that answered the previous message", () => {
    const rows = [
      row("parent", { type: "user_message", id: "u1", runId: "r1", inputIntent: "turn_start" }),
      row("parent", { type: "assistant_message", id: "a1", runId: "r1" }),
      row("fork", { type: "user_message", id: "u2", runId: "r2", inputIntent: "turn_start" }),
      row("fork", { type: "reasoning", id: "think", runId: "r2" }),
      row("fork", { type: "assistant_message", id: "a2", runId: "r2" }),
      row("fork", { type: "user_message", id: "u3", runId: "r3", inputIntent: "queued_turn" }),
    ];

    expect(planEditInNewThread(rows, "u3" as never, loaded)).toMatchObject({
      type: "fork",
      sourceThreadId: "fork",
      runId: "r2",
      message: { messageId: "u3" },
    });
    // An inherited answer forks the parent thread it came from.
    expect(planEditInNewThread(rows, "u2" as never, loaded)).toMatchObject({
      type: "fork",
      sourceThreadId: "parent",
      runId: "r1",
    });
  });

  it("starts empty with a transcript when no run precedes the message", () => {
    const rows = [
      row("t", { type: "user_message", id: "u1", runId: null, text: "Old question" }),
      row("t", { type: "assistant_message", id: "a1", runId: null, text: "Old answer" }),
      row("t", { type: "user_message", id: "u2", runId: null, inputIntent: "turn_start" }),
    ];

    const plan = planEditInNewThread(rows, "u2" as never, loaded);
    expect(plan?.type).toBe("fresh");
    expect(plan?.type === "fresh" ? plan.earlierMessages.map((item) => item.id) : []).toEqual([
      "u1",
      "a1",
    ]);
    expect(planEditInNewThread(rows.slice(0, 1), "u1" as never, loaded)).toMatchObject({
      type: "fresh",
      earlierMessages: [],
    });
    // A run may precede the loaded window; never drop that history silently.
    expect(planEditInNewThread(rows, "u2" as never, { hasEarlierHistory: true })).toEqual({
      type: "history_not_loaded",
    });
  });

  it("does not cut a steer out of the run it joined", () => {
    const rows = [
      row("t", { type: "user_message", id: "u1", runId: "r1", inputIntent: "turn_start" }),
      row("t", { type: "user_message", id: "s1", runId: "r1", inputIntent: "steer" }),
    ];

    expect(planEditInNewThread(rows, "s1" as never, loaded)).toBeNull();
    expect(planEditInNewThread(rows, "missing" as never, loaded)).toBeNull();
  });

  it("writes the transcript with context links reduced to their labels", () => {
    const transcript = buildEarlierConversationTranscript({
      title: "Parser",
      messages: [
        {
          type: "user_message",
          text: "Read [parser.ts](t3-context://v1/mention/ctx_1)",
          attachments: [{ name: "log.txt" }],
        },
        { type: "assistant_message", text: "Done." },
        { type: "assistant_message", text: "   " },
      ] as never,
    });

    expect(transcript).toContain('continues "Parser"');
    expect(transcript).toContain("## User\n\nRead parser.ts\n\n(Attached: log.txt)");
    expect(transcript).toContain("## Assistant\n\nDone.");
    expect(transcript.match(/## Assistant/g)).toHaveLength(1);
  });
});
