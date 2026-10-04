import * as DateTime from "effect/DateTime";
import type { EnvironmentProject, EnvironmentThreadShell } from "./state/shell.ts";

export interface NowBarRow {
  readonly key: string;
  readonly title: string;
  readonly project: string;
  readonly phase:
    | "working"
    | "attention"
    | "monitoring"
    | "offline"
    | "completed"
    | "error"
    | "stopped";
  readonly kind?: "approval" | "input" | "plan" | "background" | undefined;
  readonly status: string;
  readonly startedAt: number;
  readonly completed: number;
  readonly total: number;
  readonly url: string;
  readonly provider?: string;
  readonly model?: string;
  readonly modelLabel?: string;
  readonly eventAt?: number;
}

// The same provider catalog supplies names to the mobile model picker and host push.
export interface NowBarCatalog {
  readonly providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly driver: string;
    readonly models: ReadonlyArray<{
      readonly slug: string;
      readonly name: string;
      readonly aliases?: ReadonlyArray<string> | undefined;
      readonly isDefault?: boolean | undefined;
    }>;
  }>;
}

type RunState = "running" | "completed" | "error" | "interrupted";

/** Collapse a v2 run status into the four states the Now Bar shows. */
export function runState(thread: EnvironmentThreadShell): RunState | null {
  const status = thread.latestRun?.status;
  switch (status) {
    case undefined:
      return null;
    case "completed":
    case "rolled_back":
      return "completed";
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    default:
      return "running";
  }
}

/** Background work left after the run settles: monitors watch, anything else works. */
function backgroundLiveness(thread: EnvironmentThreadShell): "monitoring" | "working" | null {
  const tasks = thread.pendingBackgroundTasks;
  if (tasks.length === 0) return null;
  return tasks.every((task) => task.kind === "monitor") ? "monitoring" : "working";
}

/** The assistant's latest visible message during the current run, as a one-line status. */
export function agentStatusText(thread: EnvironmentThreadShell): string | undefined {
  const message = thread.source.latestVisibleMessage;
  const startedAt = thread.latestRun?.startedAt ?? thread.latestRun?.requestedAt;
  if (!message || message.role !== "assistant" || !startedAt) return undefined;
  if (DateTime.toEpochMillis(message.updatedAt) < Date.parse(startedAt)) return undefined;
  const text = message.text.replace(/\s+/g, " ").trim().slice(0, 240);
  return text || undefined;
}

export function threadKey(thread: EnvironmentThreadShell): string {
  return JSON.stringify([thread.environmentId, thread.id, thread.latestRun?.runId ?? "background"]);
}

export function isActiveThread(thread: EnvironmentThreadShell): boolean {
  return (
    thread.archivedAt === null &&
    (runState(thread) === "running" ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.hasActionableProposedPlan ||
      backgroundLiveness(thread) !== null)
  );
}

export function projectNowBarRows(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  connected: ReadonlySet<string>,
  unread?: { readonly since: number; readonly readTurns: Readonly<Record<string, string>> },
  catalogs?: ReadonlyMap<string, NowBarCatalog>,
  statuses?: ReadonlyMap<string, string>,
): NowBarRow[] {
  const projectsByKey = new Map(
    projects.map((p) => [JSON.stringify([p.environmentId, p.id]), p.title]),
  );
  return threads
    .filter((thread) => isActiveThread(thread) || isUnreadCompletion(thread, unread))
    .map((thread): NowBarRow => {
      const online = connected.has(thread.environmentId);
      const finished = !isActiveThread(thread) && isUnreadCompletion(thread, unread);
      const attention =
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.hasActionableProposedPlan;
      const phase = finished
        ? runState(thread) === "error"
          ? "error"
          : runState(thread) === "interrupted"
            ? "stopped"
            : "completed"
        : !online
          ? "offline"
          : attention
            ? "attention"
            : backgroundLiveness(thread) === "monitoring"
              ? "monitoring"
              : "working";
      // v2 shells carry no plan progress, so rows show no step count.
      const total = 0;
      const status = finished
        ? phase === "error"
          ? "Agent hit an error · Open to inspect"
          : phase === "stopped"
            ? "Agent stopped · Open to review"
            : "Ready to review · Unread result"
        : !online
          ? "Connection paused · Open T3 to reconnect"
          : thread.hasPendingApprovals
            ? "Approval needed · Review to continue"
            : thread.hasPendingUserInput
              ? "Your agent has a question"
              : thread.hasActionableProposedPlan
                ? "Plan ready for your review"
                : ((phase === "working" && runState(thread) === "running"
                    ? statuses?.get(threadKey(thread))
                    : undefined) ??
                  (phase === "monitoring" ? "Watching for changes" : "Agent is working"));
      const startedAt = Date.parse(
        thread.latestRun?.startedAt ?? thread.latestRun?.requestedAt ?? thread.updatedAt,
      );
      const provider = catalogs
        ?.get(thread.environmentId)
        ?.providers.find((provider) => provider.instanceId === thread.modelSelection.instanceId);
      const model =
        provider?.models.find((model) => model.slug === thread.modelSelection.model) ??
        provider?.models.find((model) => model.aliases?.includes(thread.modelSelection.model));
      return {
        key: threadKey(thread),
        provider:
          provider?.driver ??
          thread.runtime?.providerName ??
          String(thread.modelSelection.instanceId),
        model: thread.modelSelection.model,
        modelLabel: model?.name ?? thread.modelSelection.model,
        // Keep streaming message updates from changing an otherwise identical push payload.
        eventAt:
          Date.parse(
            thread.latestRun?.completedAt ?? thread.latestRun?.requestedAt ?? thread.createdAt,
          ) || 0,
        title: thread.title.slice(0, 120),
        project:
          projectsByKey.get(JSON.stringify([thread.environmentId, thread.projectId])) ?? "T3 Code",
        phase,
        kind: thread.hasPendingApprovals
          ? "approval"
          : thread.hasPendingUserInput
            ? "input"
            : thread.hasActionableProposedPlan
              ? "plan"
              : backgroundLiveness(thread) === "working"
                ? "background"
                : undefined,
        status: status.slice(0, 240),
        startedAt: Number.isFinite(startedAt) ? startedAt : 0,
        total,
        completed: 0,
        url: `t3code-nowbar://threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.id)}`,
      };
    })
    .sort((a, b) => {
      const priority = {
        attention: 0,
        working: 2,
        monitoring: 3,
        offline: 4,
        completed: 1,
        error: 1,
        stopped: 1,
      };
      return (
        priority[a.phase] - priority[b.phase] ||
        b.startedAt - a.startedAt ||
        a.key.localeCompare(b.key)
      );
    });
}

export function readIdentity(thread: EnvironmentThreadShell): string {
  return JSON.stringify([thread.environmentId, thread.id]);
}

export function isUnreadCompletion(
  thread: EnvironmentThreadShell,
  unread?: { readonly since: number; readonly readTurns: Readonly<Record<string, string>> },
): boolean {
  const run = thread.latestRun;
  const state = runState(thread);
  if (!unread || thread.archivedAt !== null || !run || state === null || state === "running")
    return false;
  const completedAt = Date.parse(run.completedAt ?? "");
  return (
    Number.isFinite(completedAt) &&
    completedAt >= unread.since &&
    unread.readTurns[readIdentity(thread)] !== run.runId
  );
}

/** Only settle work observed live on this device; cached historical work never alerts. */
export function completedNowBarRows(
  previous: ReadonlyArray<NowBarRow>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  connected: ReadonlySet<string>,
): NowBarRow[] {
  const byKey = new Map(threads.map((thread) => [threadKey(thread), thread]));
  return previous.flatMap((row) => {
    if (row.phase === "completed" || row.phase === "error" || row.phase === "stopped") return [];
    const thread = byKey.get(row.key);
    if (!thread || !connected.has(thread.environmentId) || isActiveThread(thread)) return [];
    const state = runState(thread);
    if (state === null || state === "running") return [];
    return [
      {
        ...row,
        phase:
          state === "error"
            ? ("error" as const)
            : state === "interrupted"
              ? ("stopped" as const)
              : ("completed" as const),
        status:
          state === "error"
            ? "Agent hit an error · Open to inspect"
            : state === "interrupted"
              ? "Agent stopped"
              : "Work complete · Ready to review",
      },
    ];
  });
}
