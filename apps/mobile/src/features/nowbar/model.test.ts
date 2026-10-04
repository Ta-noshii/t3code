import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { agentStatusText, completedNowBarRows, projectNowBarRows, readIdentity } from "./model";

const environmentId = EnvironmentId.make("laptop");
const connected = new Set([environmentId]);
type RunPatch = Partial<NonNullable<EnvironmentThreadShell["latestRun"]>>;
function run(patch: RunPatch = {}): NonNullable<EnvironmentThreadShell["latestRun"]> {
  return {
    runId: RunId.make("turn"),
    status: "running",
    requestedAt: "2026-09-09T10:00:00Z",
    startedAt: "2026-09-09T10:00:01Z",
    completedAt: null,
    assistantMessageId: null,
    ...patch,
  };
}
function background(kind: "monitor" | "command") {
  return [
    { taskId: "task-1", kind },
  ] as unknown as EnvironmentThreadShell["pendingBackgroundTasks"];
}
function withMessage(
  base: EnvironmentThreadShell,
  message: { role: "assistant" | "user"; text: string; updatedAt: string },
): EnvironmentThreadShell {
  return {
    ...base,
    source: {
      ...base.source,
      latestVisibleMessage: {
        id: MessageId.make("m1"),
        role: message.role,
        text: message.text,
        updatedAt: DateTime.makeUnsafe(message.updatedAt),
      },
    },
  } as EnvironmentThreadShell;
}
function thread(patch: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make("task"),
    projectId: ProjectId.make("project"),
    title: "Build a feature",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestRun: run(),
    runtime: null,
    pendingBackgroundTasks: [],
    source: { latestVisibleMessage: null } as unknown as EnvironmentThreadShell["source"],
    createdAt: "2026-09-09T10:00:00Z",
    updatedAt: "2026-09-09T10:00:02Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...patch,
  } as unknown as EnvironmentThreadShell;
}

describe("Now Bar agent projection", () => {
  it("shares active provider, model and event time with native and host push consumers", () => {
    const running = thread({
      modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "claude-sonnet" },
    });
    expect(projectNowBarRows([running], [], connected)[0]).toMatchObject({
      provider: "cursor",
      model: "claude-sonnet",
      eventAt: Date.parse(running.latestRun!.requestedAt!),
    });
    const finished = {
      ...running,
      latestRun: run({ status: "completed", completedAt: "2026-09-09T10:05:00Z" }),
    };
    expect(
      projectNowBarRows([finished], [], connected, { since: 0, readTurns: {} })[0]?.eventAt,
    ).toBe(Date.parse(finished.latestRun.completedAt!));
    expect(
      projectNowBarRows([{ ...running, updatedAt: "2026-09-09T10:01:00Z" }], [], connected),
    ).toEqual(projectNowBarRows([running], [], connected));
  });
  it("resolves exact names in the thread's environment and provider, preserving unknown model IDs", () => {
    const catalogs = new Map([
      [
        environmentId,
        {
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              models: [{ slug: "test", name: "GPT Display Name" }],
            },
            {
              instanceId: "custom",
              driver: "cursor",
              models: [{ slug: "test", name: "Claude Display Name" }],
            },
          ],
        },
      ],
    ]);
    const selected = thread({
      modelSelection: { instanceId: ProviderInstanceId.make("custom"), model: "test" },
    });
    expect(projectNowBarRows([selected], [], connected, undefined, catalogs)[0]).toMatchObject({
      provider: "cursor",
      model: "test",
      modelLabel: "Claude Display Name",
    });
    expect(projectNowBarRows([thread()], [], connected, undefined, catalogs)[0]?.modelLabel).toBe(
      "GPT Display Name",
    );
    const unknown = thread({
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "private-model-v2" },
    });
    expect(projectNowBarRows([unknown], [], connected, undefined, catalogs)[0]?.modelLabel).toBe(
      "private-model-v2",
    );
    expect(projectNowBarRows([thread()], [], connected)[0]?.modelLabel).toBe("test");
  });
  it("prefers latest agent updates but never covers attention, offline or a new turn", () => {
    const running = thread();
    const statuses = new Map([
      [JSON.stringify([environmentId, running.id, "turn"]), "Running focused tests"],
    ]);
    const project = (candidate: EnvironmentThreadShell) =>
      projectNowBarRows([candidate], [], connected, undefined, undefined, statuses)[0];
    expect(project(running)?.status).toBe("Running focused tests");
    expect(
      project({
        ...running,
        pendingBackgroundTasks: background("monitor"),
        latestRun: run({ status: "completed" }),
      })?.status,
    ).toBe("Watching for changes");
    expect(project({ ...running, hasPendingApprovals: true })?.status).toBe(
      "Approval needed · Review to continue",
    );
    expect(
      projectNowBarRows([running], [], new Set(), undefined, undefined, statuses)[0]?.status,
    ).toContain("Connection paused");
    expect(project({ ...running, latestRun: run({ runId: RunId.make("next") }) })?.status).toBe(
      "Agent is working",
    );
  });
  it("reads agent text from the current run's latest assistant message only", () => {
    const running = thread();
    expect(
      agentStatusText(
        withMessage(running, {
          role: "assistant",
          text: "Running\n  focused tests",
          updatedAt: "2026-09-09T10:00:05Z",
        }),
      ),
    ).toBe("Running focused tests");
    expect(
      agentStatusText(
        withMessage(running, { role: "user", text: "Prompt", updatedAt: "2026-09-09T10:00:05Z" }),
      ),
    ).toBeUndefined();
    expect(
      agentStatusText(
        withMessage(running, {
          role: "assistant",
          text: "Earlier run",
          updatedAt: "2026-09-09T09:00:00Z",
        }),
      ),
    ).toBeUndefined();
    expect(
      agentStatusText(
        withMessage(running, {
          role: "assistant",
          text: "x".repeat(20_000),
          updatedAt: "2026-09-09T10:00:05Z",
        }),
      ),
    ).toHaveLength(240);
  });
  it("distinguishes approval, question, plan review and background work", () => {
    const cases = [
      { hasPendingApprovals: true },
      { hasPendingUserInput: true },
      { hasActionableProposedPlan: true },
      { pendingBackgroundTasks: background("command") },
    ];
    expect(
      cases.map((patch) => projectNowBarRows([thread(patch)], [], connected)[0]?.kind),
    ).toEqual(["approval", "input", "plan", "background"]);
  });
  it("retains new unread completions until the matching turn is read, including offline", () => {
    const finished = thread({
      latestRun: run({ status: "completed", completedAt: "2026-09-09T10:05:00Z" }),
    });
    const unread = { since: Date.parse("2026-09-09T10:00:00Z"), readTurns: {} };
    const rows = projectNowBarRows([finished], [], connected, unread);
    expect(rows[0]?.phase).toBe("completed");
    expect(projectNowBarRows([finished], [], new Set(), unread)[0]?.phase).toBe("completed");
    expect(
      projectNowBarRows([finished], [], connected, {
        ...unread,
        readTurns: { [readIdentity(finished)]: finished.latestRun!.runId },
      }),
    ).toEqual([]);
    expect(completedNowBarRows(rows, [finished], connected)).toEqual([]);
    expect(
      projectNowBarRows([finished], [], connected, {
        ...unread,
        since: Date.parse("2026-09-09T11:00:00Z"),
      }),
    ).toEqual([]);
    expect(
      projectNowBarRows(
        [{ ...finished, archivedAt: "2026-09-09T11:00:00Z" }],
        [],
        connected,
        unread,
      ),
    ).toEqual([]);
  });
  it("read receipts do not suppress a later turn or a matching ID in another environment", () => {
    const finished = thread({
      latestRun: run({ status: "failed", completedAt: "2026-09-09T10:05:00Z" }),
    });
    const unread = { since: 0, readTurns: { [readIdentity(finished)]: "old-turn" } };
    expect(projectNowBarRows([finished], [], connected, unread)[0]?.phase).toBe("error");
    const other = { ...finished, environmentId: EnvironmentId.make("other") };
    expect(
      projectNowBarRows([other], [], connected, {
        since: 0,
        readTurns: { [readIdentity(finished)]: finished.latestRun!.runId },
      })[0]?.phase,
    ).toBe("error");
  });
  it("prioritizes attention over working rows", () => {
    const rows = projectNowBarRows(
      [thread(), thread({ id: ThreadId.make("approval"), hasPendingApprovals: true })],
      [],
      connected,
    );
    expect(rows.map((row) => row.phase)).toEqual(["attention", "working"]);
    expect(rows[0]?.status).toContain("Approval needed");
  });
  it("does not conflate matching thread IDs in different environments", () => {
    const other = EnvironmentId.make("desktop");
    const rows = projectNowBarRows(
      [thread(), thread({ environmentId: other })],
      [],
      new Set([environmentId, other]),
    );
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(new Set(rows.map((row) => row.url)).size).toBe(2);
  });
  it("shows disconnected cached work as offline, never complete", () => {
    const active = projectNowBarRows([thread()], [], connected);
    const rows = projectNowBarRows([thread()], [], new Set());
    expect(rows[0]?.phase).toBe("offline");
    expect(completedNowBarRows(active, [thread()], new Set())).toEqual([]);
  });
  it("only sends completion for the same observed turn after it ends", () => {
    const running = thread();
    const previous = projectNowBarRows([running], [], connected);
    const finished = thread({ latestRun: run({ status: "completed" }) });
    expect(projectNowBarRows([finished], [], connected)).toEqual([]);
    expect(completedNowBarRows(previous, [finished], connected)[0]?.status).toContain(
      "Work complete",
    );
    expect(completedNowBarRows([], [finished], connected)).toEqual([]);
    expect(
      completedNowBarRows(
        previous,
        [thread({ latestRun: run({ status: "completed", runId: RunId.make("new") }) })],
        connected,
      ),
    ).toEqual([]);
  });
  it("keeps background agents and user questions live after the main turn ends", () => {
    const finished = run({ status: "completed" });
    expect(
      projectNowBarRows(
        [thread({ latestRun: finished, pendingBackgroundTasks: background("monitor") })],
        [],
        connected,
      )[0]?.phase,
    ).toBe("monitoring");
    expect(
      projectNowBarRows(
        [thread({ latestRun: finished, hasPendingUserInput: true })],
        [],
        connected,
      )[0]?.phase,
    ).toBe("attention");
  });
  it("does not invent a progress percentage or include archived work", () => {
    expect(projectNowBarRows([thread()], [], connected)[0]?.total).toBe(0);
    expect(
      projectNowBarRows([thread({ archivedAt: "2026-09-09T12:00:00Z" })], [], connected),
    ).toEqual([]);
  });
});
