import {
  AGENT_PROGRESS_MAX_ITEMS,
  type OrchestrationV2AgentProgress,
  type OrchestrationV2AgentProgressItemStatus,
  type OrchestrationV2AgentProgressSummary,
  type OrchestrationV2AgentProgressUpdate,
} from "@t3tools/contracts";

export type AgentProgressItem = OrchestrationV2AgentProgress["items"][number];

export const DEFAULT_AGENT_PROGRESS_TITLE = "Progress";

export type AgentProgressUpdateResult =
  | {
      readonly _tag: "applied";
      readonly progress: OrchestrationV2AgentProgress | null;
      readonly changed: boolean;
    }
  | { readonly _tag: "rejected"; readonly message: string };

function itemsEqual(left: AgentProgressItem, right: AgentProgressItem): boolean {
  return left.id === right.id && left.label === right.label && left.status === right.status;
}

/**
 * Applies one call's ops in order: clear, title, items, remove. Items merge by
 * id and keep the fields a call leaves out, so calls from concurrent
 * subagents that each touch their own ids commute.
 */
export function applyAgentProgressUpdate(
  current: OrchestrationV2AgentProgress | null | undefined,
  update: OrchestrationV2AgentProgressUpdate,
  updatedAt: string,
): AgentProgressUpdateResult {
  const base = update.clear === true ? null : (current ?? null);
  const touchesTracker =
    update.title !== undefined || (update.items !== undefined && update.items.length > 0);
  if (base === null && !touchesTracker) {
    return { _tag: "applied", progress: null, changed: (current ?? null) !== null };
  }

  const title = update.title ?? base?.title ?? DEFAULT_AGENT_PROGRESS_TITLE;
  const items = [...(base?.items ?? [])];
  const indexById = new Map(items.map((item, index) => [item.id, index]));
  for (const change of update.items ?? []) {
    const index = indexById.get(change.id);
    const existing = index === undefined ? undefined : items[index];
    const label = change.label === undefined ? existing?.label : change.label || undefined;
    const next: AgentProgressItem = {
      id: change.id,
      ...(label === undefined ? {} : { label }),
      status: change.status ?? existing?.status ?? "pending",
    };
    if (index === undefined) {
      indexById.set(change.id, items.length);
      items.push(next);
    } else {
      items[index] = next;
    }
  }
  const removed = new Set(update.remove ?? []);
  const kept = removed.size === 0 ? items : items.filter((item) => !removed.has(item.id));
  if (kept.length > AGENT_PROGRESS_MAX_ITEMS) {
    return {
      _tag: "rejected",
      message: `A progress tracker holds at most ${AGENT_PROGRESS_MAX_ITEMS} items; this call would leave ${kept.length}. Track larger groups of work per item instead.`,
    };
  }

  const changed =
    current == null ||
    update.clear === true ||
    current.title !== title ||
    current.items.length !== kept.length ||
    current.items.some((item, index) => !itemsEqual(item, kept[index]!));
  if (!changed) return { _tag: "applied", progress: current, changed: false };
  return { _tag: "applied", progress: { title, items: kept, updatedAt }, changed: true };
}

const SEGMENT_BY_STATUS = {
  pending: "p",
  running: "r",
  done: "d",
  failed: "f",
  skipped: "s",
} as const satisfies Record<OrchestrationV2AgentProgressItemStatus, string>;

const STATUS_BY_SEGMENT: Readonly<Record<string, OrchestrationV2AgentProgressItemStatus>> = {
  p: "pending",
  r: "running",
  d: "done",
  f: "failed",
  s: "skipped",
};

export function agentProgressSegmentStatus(
  segment: string,
): OrchestrationV2AgentProgressItemStatus {
  return STATUS_BY_SEGMENT[segment] ?? "pending";
}

export function summarizeAgentProgress(
  progress: OrchestrationV2AgentProgress | null | undefined,
): OrchestrationV2AgentProgressSummary | null {
  if (progress == null) return null;
  const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  let segments = "";
  for (const item of progress.items) {
    counts[item.status] += 1;
    segments += SEGMENT_BY_STATUS[item.status];
  }
  return {
    title: progress.title,
    total: progress.items.length,
    done: counts.done,
    failed: counts.failed,
    skipped: counts.skipped,
    running: counts.running,
    segments,
    updatedAt: progress.updatedAt,
  };
}

export function agentProgressPending(summary: OrchestrationV2AgentProgressSummary): number {
  return summary.total - summary.done - summary.failed - summary.skipped - summary.running;
}

/** Every item reached done, failed, or skipped. An empty tracker is not complete. */
export function isAgentProgressComplete(summary: OrchestrationV2AgentProgressSummary): boolean {
  return summary.total > 0 && summary.done + summary.failed + summary.skipped === summary.total;
}

/** Items finished either way, the numerator of `23/50`. */
export function agentProgressFinished(summary: OrchestrationV2AgentProgressSummary): number {
  return summary.done + summary.failed + summary.skipped;
}

const LIST_ORDER: Record<OrchestrationV2AgentProgressItemStatus, number> = {
  running: 0,
  failed: 1,
  pending: 2,
  done: 3,
  skipped: 4,
};

/** Running first, then failed, pending, done, skipped; item order within each. */
export function agentProgressListOrder(
  items: ReadonlyArray<AgentProgressItem>,
): ReadonlyArray<AgentProgressItem> {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        LIST_ORDER[left.item.status] - LIST_ORDER[right.item.status] || left.index - right.index,
    )
    .map(({ item }) => item);
}
