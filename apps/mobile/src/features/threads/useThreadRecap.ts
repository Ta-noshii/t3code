import { shouldRecapThread } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

// App-lifetime state, keyed by environment and thread (and run for recaps). A thread
// with no last-seen entry counts from its latest run's completion instead.
const lastSeenAtByThread = new Map<string, number>();
const requestedRecapKeys = new Set<string>();
const dismissedRecapKeys = new Set<string>();
// Each run is recapped once; the answer outlives the query cache so a later visit never
// starts another recap for the same run.
const recapByKey = new Map<string, string | null>();

export interface ThreadRecapInput {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  /** The thread's detail has loaded, so `completedRun` and `idle` describe it. */
  readonly ready: boolean;
  /** The thread's latest run, when it completed. */
  readonly completedRun: { readonly runId: RunId; readonly completedAt: string | null } | null;
  /** No turn running and nothing waiting on the user. */
  readonly idle: boolean;
  readonly supported: boolean;
}

/**
 * The "while you were away" recap: coming back to a finished thread after five minutes
 * or more asks the provider for a one-line summary of where it stands. Leaving is
 * backgrounding the app or moving to another screen. Each run is recapped at most once,
 * and a dismissed recap stays dismissed.
 */
export function useThreadRecap(input: ThreadRecapInput): {
  readonly recap: string | null;
  readonly dismiss: () => void;
} {
  const { environmentId, threadId, ready, completedRun, idle, supported } = input;
  const focused = useIsFocused();
  const threadKey = environmentId && threadId ? `${environmentId}:${threadId}` : null;
  const recapKey = threadKey && completedRun ? `${threadKey}:${completedRun.runId}` : null;
  const [requested, setRequested] = useState(
    () => recapKey !== null && requestedRecapKeys.has(recapKey),
  );
  const [dismissed, setDismissed] = useState(
    () => recapKey !== null && dismissedRecapKeys.has(recapKey),
  );
  const [shownKey, setShownKey] = useState(recapKey);
  if (shownKey !== recapKey) {
    setShownKey(recapKey);
    setRequested(recapKey !== null && requestedRecapKeys.has(recapKey));
    setDismissed(recapKey !== null && dismissedRecapKeys.has(recapKey));
  }

  // The listeners below read the latest state without re-subscribing, so a run finishing
  // while the app is in the background does not count as the user leaving.
  const completedAt = completedRun?.completedAt ?? null;
  const latest = useRef({ ready, recapKey, completedAt, idle, focused });

  const checkReturn = useCallback(() => {
    const state = latest.current;
    // Until the detail loads nothing can be checked, and marking the thread seen now would
    // erase the time away.
    if (
      threadKey === null ||
      !state.ready ||
      !state.focused ||
      AppState.currentState !== "active"
    ) {
      return;
    }
    if (
      supported &&
      state.recapKey !== null &&
      !requestedRecapKeys.has(state.recapKey) &&
      shouldRecapThread({
        now: Date.now(),
        lastSeenAt: lastSeenAtByThread.get(threadKey),
        completedAt: state.completedAt,
        idle: state.idle,
      })
    ) {
      requestedRecapKeys.add(state.recapKey);
      setRequested(true);
    }
    lastSeenAtByThread.set(threadKey, Date.now());
  }, [threadKey, supported]);

  // Opening the thread, coming back to its screen, its detail loading, or its latest run
  // changing is a look at it.
  useEffect(() => {
    const wasFocused = latest.current.focused;
    latest.current = { ready, recapKey, completedAt, idle, focused };
    if (focused) {
      checkReturn();
    } else if (wasFocused && threadKey !== null && ready) {
      lastSeenAtByThread.set(threadKey, Date.now());
    }
  }, [checkReturn, ready, recapKey, completedAt, idle, focused, threadKey]);

  // Leaving is navigating away or backgrounding the app.
  useEffect(() => {
    if (threadKey === null) return;
    const markLeft = () => {
      if (latest.current.ready && latest.current.focused) {
        lastSeenAtByThread.set(threadKey, Date.now());
      }
    };
    const markSeen = () => {
      if (AppState.currentState === "active") markLeft();
    };
    // Coarse on purpose: it only has to tell five minutes away from a glance elsewhere.
    const interval = setInterval(markSeen, 30_000);
    const subscription = AppState.addEventListener("change", (state) =>
      state === "active" ? checkReturn() : markLeft(),
    );
    return () => {
      markLeft();
      clearInterval(interval);
      subscription.remove();
    };
  }, [threadKey, checkReturn]);

  const cached = recapKey === null ? undefined : recapByKey.get(recapKey);
  const result = useEnvironmentQuery(
    requested &&
      !dismissed &&
      cached === undefined &&
      environmentId &&
      threadId &&
      completedRun !== null
      ? orchestrationEnvironment.threadRecap({
          environmentId,
          input: { threadId, runId: completedRun.runId },
        })
      : null,
  );
  const fetched = result.data
    ? result.data.available
      ? result.data.recap?.trim() || null
      : null
    : undefined;
  useEffect(() => {
    if (recapKey !== null && fetched !== undefined) recapByKey.set(recapKey, fetched);
  }, [recapKey, fetched]);

  const dismiss = useCallback(() => {
    if (recapKey !== null) dismissedRecapKeys.add(recapKey);
    setDismissed(true);
  }, [recapKey]);

  const recap = cached ?? fetched ?? null;
  return { recap: !dismissed && requested ? recap : null, dismiss };
}
