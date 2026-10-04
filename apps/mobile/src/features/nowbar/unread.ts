import { useCallback, useSyncExternalStore } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { AppState } from "react-native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { nowBarNative } from "./native";
import { isUnreadCompletion, readIdentity } from "./model";

const persisted = nowBarNative?.readState();
let state = {
  since: persisted?.since ?? Date.now(),
  readTurns: JSON.parse(persisted?.readTurns ?? "{}") as Record<string, string>,
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => state;
export function useNowBarUnread() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** A backgrounded or covered thread is not a read receipt. */
export function useReadNowBarThread(thread: EnvironmentThreadShell | null, contentLoaded: boolean) {
  useFocusEffect(
    useCallback(() => {
      const read = () => {
        if (
          !thread ||
          !contentLoaded ||
          AppState.currentState !== "active" ||
          !isUnreadCompletion(thread, state)
        )
          return;
        const identity = readIdentity(thread);
        const turn = thread.latestRun!.runId;
        nowBarNative?.markRead(identity, turn);
        state = { ...state, readTurns: { ...state.readTurns, [identity]: turn } };
        for (const listener of listeners) listener();
      };
      read();
      const subscription = AppState.addEventListener("change", read);
      return () => subscription.remove();
    }, [thread, contentLoaded]),
  );
}
