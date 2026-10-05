import { describe, expect, it } from "vite-plus/test";

import {
  delegatedTaskName,
  toolCallDigest,
  toolDigestText,
  toolResultDigest,
} from "./toolDigest.ts";

const TASK_ID =
  "node:delegated-task:command%3Amcp%3Aafa79ed0-62e1-4d07-8af6-6986c2c0db84%3Adelegate-task%3Awiki-perf-1";
const CHILD_THREAD_ID =
  "thread:delegated-task:command%3Amcp%3Aafa79ed0-62e1-4d07-8af6-6986c2c0db84%3Adelegate-task%3Awiki-perf-1";

const taskStatus = {
  taskId: TASK_ID,
  childThreadId: CHILD_THREAD_ID,
  childRunId: "run:thread:abc:ordinal:1",
  childNodeId: TASK_ID,
  status: "running",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  providerInstanceId: "codex",
  model: "gpt-6.1-sol",
  summary: null,
  waitTimedOut: true,
};

describe("toolResultDigest", () => {
  it("reads a task status as its name, model and thread, with ids tucked away", () => {
    const digest = toolResultDigest("mcp__t3-code__task_status", taskStatus, {
      taskId: TASK_ID,
      waitMs: "300000",
    });
    expect(digest).toMatchObject({
      status: { label: "Running", tone: "info" },
      title: "wiki-perf-1",
      meta: [
        { kind: "model", providerInstanceId: "codex", model: "gpt-6.1-sol" },
        { kind: "fact", text: "Still running after 5 min", icon: "clock" },
      ],
      threads: [{ threadId: CHILD_THREAD_ID, label: "Open task thread" }],
    });
    expect(digest?.details.map(([label]) => label)).toEqual([
      "Task id",
      "Child thread id",
      "Child run id",
      "Child node id",
    ]);
  });

  it("shows a finished task's summary as its result", () => {
    const digest = toolResultDigest(
      "t3-code.task_status",
      {
        ...taskStatus,
        status: "completed",
        latestTerminalStatus: "completed",
        latestTerminalSummary: "Saved 3 screenshots.",
        waitTimedOut: false,
      },
      { taskId: TASK_ID },
    );
    expect(digest).toMatchObject({
      status: { label: "Completed", tone: "success" },
      text: "Saved 3 screenshots.",
      textLabel: "Result",
      meta: [{ kind: "model", providerInstanceId: "codex", model: "gpt-6.1-sol" }],
    });
  });

  it("turns an error string into a failure", () => {
    expect(
      toolResultDigest("mcp__t3-code__preview_click", "Error: Preview automation timed out"),
    ).toMatchObject({
      status: { label: "Failed", tone: "error" },
      error: "Preview automation timed out",
    });
  });

  it("says when a list tool found nothing", () => {
    expect(toolResultDigest("mcp__t3-code__t3_thread_search", { threads: [] })).toMatchObject({
      empty: "No threads",
    });
  });

  it("names a page by its title and links its url", () => {
    expect(
      toolResultDigest("mcp__t3-code__preview_navigate", {
        url: "https://example.com/wiki",
        title: "Wiki",
        viewport: { width: 375, height: 812 },
        toolIcon: "globe",
      }),
    ).toMatchObject({
      title: "Wiki",
      href: "https://example.com/wiki",
      meta: [
        { kind: "fact", text: "example.com/wiki", icon: "link" },
        { kind: "fact", text: "375×812", icon: "viewport" },
      ],
      details: [],
    });
  });

  it("reads an empty thread wait as still running", () => {
    expect(toolResultDigest("mcp__t3-code__t3_thread_wait", null)).toMatchObject({
      status: { label: "Still running" },
    });
  });

  it("does not repeat the prompt a result echoes back", () => {
    const prompt = "Check the release run.";
    const digest = toolResultDigest(
      "mcp__t3-code__schedule_task",
      { title: "Release watch", prompt, schedule: { type: "interval", everyMs: 300000 } },
      { prompt },
    );
    expect(digest?.text).toBeUndefined();
    expect(digest?.meta).toContainEqual({ kind: "fact", text: "Every 5 min", icon: "repeat" });
  });

  it("leaves plain text to the caller", () => {
    expect(toolResultDigest("mcp__t3-code__preview_click", "Clicked.")).toBeNull();
  });
});

describe("toolCallDigest", () => {
  it("keeps the prompt and target model and drops ids", () => {
    expect(
      toolCallDigest("mcp__t3-code__delegate_task", {
        task: "Take proof screenshots.",
        target: {
          providerInstanceId: "codex",
          model: "gpt-6.1-sol",
          options: { reasoningEffort: "medium" },
        },
        mode: "async",
        clientRequestId: "proof-1",
      }),
    ).toEqual({
      meta: [
        {
          kind: "model",
          providerInstanceId: "codex",
          model: "gpt-6.1-sol",
          effort: "medium",
        },
      ],
      text: "Take proof screenshots.",
      textLabel: "Task",
      args: [["Mode", "async"]],
      threads: [],
    });
    expect(
      toolCallDigest("mcp__t3-code__task_status", { taskId: TASK_ID, waitMs: "300000" }),
    ).toMatchObject({ args: [["Wait", "5 min"]] });
  });

  it("leaves the model to the call when the result repeats its target", () => {
    const digest = toolResultDigest("mcp__t3-code__delegate_task", taskStatus, {
      task: "Take proof screenshots.",
      target: { providerInstanceId: "codex", model: "gpt-6.1-sol" },
    });
    expect(digest?.meta.some((meta) => meta.kind === "model")).toBe(false);
  });

  it("ignores tools that are not T3's", () => {
    expect(toolCallDigest("mcp__github__get_issue", { number: 1 })).toBeNull();
  });
});

describe("helpers", () => {
  it("reads the caller's task name from the id", () => {
    expect(delegatedTaskName(TASK_ID)).toBe("wiki-perf-1");
    expect(delegatedTaskName("task_123")).toBeUndefined();
  });

  it("prints a digest as plain text", () => {
    const digest = toolResultDigest("mcp__t3-code__task_status", taskStatus, { waitMs: 300000 });
    expect(toolDigestText(digest!)).toBe(
      "Running: wiki-perf-1\nCodex gpt-6.1-sol, Still running after 5 min",
    );
  });
});
