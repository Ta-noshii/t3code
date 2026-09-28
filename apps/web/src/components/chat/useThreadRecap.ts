import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useState } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";

/** How long a thread has to be out of view before coming back to it earns a recap. */
export const THREAD_RECAP_AWAY_MS = 5 * 60_000;

// When each thread was last on screen, for this window's lifetime. A thread with no entry
// counts from its latest turn's completion instead.
const lastSeenAtByThread = new Map<string, number>();
const dismissedRecapKeys = new Set<string>();
const requestedRecapKeys = new Set<string>();

const NO_RECAP_ATOM = Atom.make(
  AsyncResult.initial<{ available: boolean; recap: string | null }>(),
);

export interface ThreadRecapInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly latestTurn: {
    readonly turnId: TurnId;
    readonly state: string;
    readonly completedAt: string | null;
  } | null;
  /** The thread is idle: no turn running and nothing waiting on the user. */
  readonly idle: boolean;
  readonly supported: boolean;
}

/** Whether a user returning now, after last seeing the thread at `lastSeenAt`, should get a recap. */
export function shouldRecapThread(input: {
  readonly now: number;
  readonly lastSeenAt: number | undefined;
  readonly completedAt: string | null;
  readonly idle: boolean;
  readonly turnState: string | undefined;
}): boolean {
  if (!input.idle || input.turnState !== "completed" || input.completedAt === null) return false;
  const since = input.lastSeenAt ?? Date.parse(input.completedAt);
  return Number.isFinite(since) && input.now - since >= THREAD_RECAP_AWAY_MS;
}

/**
 * Claude Code's "while you were away" recap: coming back to a finished thread after five
 * minutes or more asks the provider for a one-line summary of where it stands. Each turn is
 * recapped at most once, and a dismissed recap stays dismissed.
 */
export function useThreadRecap(input: ThreadRecapInput): {
  readonly recap: string | null;
  readonly dismiss: () => void;
} {
  const { environmentId, threadId, latestTurn, idle, supported } = input;
  const recapKey = threadId && latestTurn ? `${threadId}:${latestTurn.turnId}` : null;
  const [requested, setRequested] = useState(
    () => recapKey !== null && requestedRecapKeys.has(recapKey),
  );
  const [dismissed, setDismissed] = useState(
    () => recapKey !== null && dismissedRecapKeys.has(recapKey),
  );

  useEffect(() => {
    setRequested(recapKey !== null && requestedRecapKeys.has(recapKey));
    setDismissed(recapKey !== null && dismissedRecapKeys.has(recapKey));
  }, [recapKey]);

  // Record the thread as seen while it is on screen, and check for a return whenever it
  // comes back into view: opening it, or the window regaining focus.
  useEffect(() => {
    if (!threadId) return;
    const checkReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (
        supported &&
        recapKey !== null &&
        !requestedRecapKeys.has(recapKey) &&
        shouldRecapThread({
          now: Date.now(),
          lastSeenAt: lastSeenAtByThread.get(threadId),
          completedAt: latestTurn?.completedAt ?? null,
          idle,
          turnState: latestTurn?.state,
        })
      ) {
        requestedRecapKeys.add(recapKey);
        setRequested(true);
      }
      lastSeenAtByThread.set(threadId, Date.now());
    };
    const markSeen = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        lastSeenAtByThread.set(threadId, Date.now());
      }
    };
    checkReturn();
    const interval = setInterval(markSeen, 30_000);
    const onVisibility = () => (document.visibilityState === "visible" ? checkReturn() : undefined);
    const onBlur = () => lastSeenAtByThread.set(threadId, Date.now());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", checkReturn);
    window.addEventListener("blur", onBlur);
    return () => {
      lastSeenAtByThread.set(threadId, Date.now());
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", checkReturn);
      window.removeEventListener("blur", onBlur);
    };
  }, [threadId, recapKey, supported, idle, latestTurn?.completedAt, latestTurn?.state]);

  const atom =
    requested && !dismissed && environmentId && threadId && latestTurn
      ? orchestrationEnvironment.threadRecap({
          environmentId,
          input: { threadId, turnId: latestTurn.turnId },
        })
      : NO_RECAP_ATOM;
  const result = useAtomValue(atom);

  const dismiss = useCallback(() => {
    if (recapKey !== null) dismissedRecapKeys.add(recapKey);
    setDismissed(true);
  }, [recapKey]);

  const recap =
    !dismissed && result._tag === "Success" && result.value.available
      ? (result.value.recap?.trim() ?? null)
      : null;
  return { recap: recap && recap.length > 0 ? recap : null, dismiss };
}
