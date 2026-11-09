/** Minimum gap between pushes that only move one thread's progress count. */
export const PROGRESS_PUSH_INTERVAL_MS = 5_000;

export interface ProgressPushRow {
  readonly key: string;
  readonly total: number;
  readonly completed: number;
  readonly status: string;
}

export type ProgressPushDecision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "send"; readonly progressKeys: ReadonlyArray<string> }
  | { readonly kind: "defer"; readonly untilMs: number };

// A row's status carries its count ("Title · 23/50"), so both fields move together.
const withoutCount = (row: ProgressPushRow) =>
  row.total > 0 ? JSON.stringify({ ...row, completed: 0, status: "" }) : JSON.stringify(row);

/**
 * Compares the rows about to be pushed with the rows last sent. Any change
 * beyond progress counts sends at once. Count-only changes send when every
 * moved thread's last count push is at least the interval old, and otherwise
 * defer to the time they may go, which the caller uses for a trailing send.
 * `progressKeys` are the threads whose count the send carries, to stamp in
 * `lastPushAt`.
 */
export function decideProgressPush(
  previous: ReadonlyArray<ProgressPushRow>,
  next: ReadonlyArray<ProgressPushRow>,
  lastPushAt: ReadonlyMap<string, number>,
  nowMs: number,
): ProgressPushDecision {
  const previousByKey = new Map(previous.map((row) => [row.key, row]));
  const progressKeys = next
    .filter((row) => {
      const before = previousByKey.get(row.key);
      return (
        row.total > 0 &&
        before !== undefined &&
        (before.completed !== row.completed || before.status !== row.status)
      );
    })
    .map((row) => row.key);
  const structural =
    previous.length !== next.length ||
    next.some((row, index) => {
      const before = previous[index];
      return before === undefined || withoutCount(before) !== withoutCount(row);
    });
  if (structural) return { kind: "send", progressKeys };
  if (progressKeys.length === 0) return { kind: "unchanged" };
  const untilMs = Math.max(
    ...progressKeys.map((key) => (lastPushAt.get(key) ?? -Infinity) + PROGRESS_PUSH_INTERVAL_MS),
  );
  return nowMs >= untilMs ? { kind: "send", progressKeys } : { kind: "defer", untilMs };
}
