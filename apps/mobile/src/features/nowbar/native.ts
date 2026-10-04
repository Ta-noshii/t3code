import { requireOptionalNativeModule } from "expo";
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";

export interface NowBarPreferences {
  readonly enabled: boolean;
  readonly private: boolean;
  readonly results: boolean;
  readonly updates: boolean;
  readonly push: boolean;
  readonly pushLive: boolean;
  readonly custom: boolean;
  readonly expanded: boolean;
  readonly nudges: boolean;
}

interface NowBarNativeModule {
  debugShow(rows: string, custom: boolean, nudge: boolean, expanded: boolean): void;
  debugClear(): void;
  debugStatus(): { active: boolean; customAttached: boolean; promoted: boolean };
  clearRemotePush(): void;
  readState(): { since: number; readTurns: string };
  markRead(identity: string, turn: string): void;
  addListener(event: "heartbeat", listener: () => void): { remove(): void };
  addListener(
    event: "updateProgress",
    listener: (event: {
      phase: "downloading" | "verifying";
      downloaded: number;
      total: number;
    }) => void,
  ): { remove(): void };
  preferences(): NowBarPreferences;
  setPreferences(json: string): void;
  publish(rows: string): boolean;
  result(row: string): void;
  capabilities(): {
    samsung: boolean;
    sdk: number;
    notifications: boolean;
    promoted: boolean;
    active: boolean;
  };
  openSettings(): void;
  canInstallUpdates(): boolean;
  installUpdate(
    url: string,
    sha256: string,
    versionCode: number,
  ): Promise<"permission" | "installer">;
}

export const nowBarNative =
  Platform.OS === "android" ? requireOptionalNativeModule<NowBarNativeModule>("T3NowBar") : null;
let preferences = nowBarNative?.preferences() ?? {
  enabled: false,
  private: false,
  results: true,
  updates: true,
  push: false,
  pushLive: true,
  custom: true,
  expanded: false,
  nudges: true,
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => preferences;

export function useNowBarPreferences() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function getNowBarPreferences() {
  return preferences;
}
export function saveNowBarPreferences(patch: Partial<NowBarPreferences>) {
  nowBarNative?.setPreferences(JSON.stringify(patch));
  preferences = { ...preferences, ...patch };
  for (const listener of listeners) listener();
}
