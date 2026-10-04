import Constants from "expo-constants";
import { useSyncExternalStore } from "react";
import { Alert, AppState } from "react-native";
import { nowBarNative } from "./native";
import { parseNowBarRelease, RELEASE_ROOT, type NowBarRelease } from "./update-manifest";

export type NowBarUpdateState =
  | { readonly phase: "idle" }
  | { readonly phase: "checking" }
  | { readonly phase: "available"; readonly release: NowBarRelease }
  | { readonly phase: "permission"; readonly release: NowBarRelease }
  | {
      readonly phase: "downloading";
      readonly release: NowBarRelease;
      readonly downloaded: number;
      readonly total: number;
    }
  | { readonly phase: "verifying"; readonly release: NowBarRelease }
  | { readonly phase: "installer"; readonly release: NowBarRelease }
  | { readonly phase: "error"; readonly release: NowBarRelease; readonly message: string };

let state = { phase: "idle" } as NowBarUpdateState;
// The dialog can be hidden while a download keeps going; Settings reopens it.
let dialogOpen = false;
let lastCheck = 0;
let offered = 0;
const listeners = new Set<() => void>();
let snapshot: { state: NowBarUpdateState; dialogOpen: boolean } = { state, dialogOpen };

function set(next: NowBarUpdateState, open = dialogOpen) {
  state = next;
  dialogOpen = open && next.phase !== "idle" && next.phase !== "checking";
  snapshot = { state, dialogOpen };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = () => snapshot;

export function useNowBarUpdate() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const busy = () =>
  state.phase === "checking" || state.phase === "downloading" || state.phase === "verifying";

nowBarNative?.addListener("updateProgress", (event) => {
  if (state.phase !== "downloading" && state.phase !== "verifying") return;
  const { release } = state;
  if (event.phase === "verifying") set({ phase: "verifying", release });
  else set({ phase: "downloading", release, downloaded: event.downloaded, total: event.total });
});

// Android sends the user to "Install unknown apps"; carry on once they come back
// with the permission granted instead of making them find the button again.
AppState.addEventListener("change", (appState) => {
  if (appState === "active" && state.phase === "permission" && nowBarNative?.canInstallUpdates())
    void installNowBarUpdate();
});

export async function installNowBarUpdate(): Promise<void> {
  if (!nowBarNative || busy() || state.phase === "idle" || state.phase === "checking") return;
  const { release } = state;
  set({ phase: "downloading", release, downloaded: 0, total: 0 }, true);
  try {
    const result = await nowBarNative.installUpdate(
      release.url,
      release.sha256,
      release.versionCode,
    );
    set({ phase: result === "permission" ? "permission" : "installer", release });
  } catch (error) {
    set({
      phase: "error",
      release,
      message: error instanceof Error ? error.message : "Please try again.",
    });
  }
}

export function openNowBarUpdateDialog() {
  set(state, true);
}

/** Hides the dialog. Settled states reset; a running download keeps going. */
export function closeNowBarUpdateDialog() {
  if (busy()) set(state, false);
  else set({ phase: "idle" }, false);
}

export async function checkNowBarUpdate(manual: boolean): Promise<void> {
  if (!nowBarNative) return;
  if (state.phase !== "idle") {
    // A release is already on offer or downloading; show it again.
    if (manual && state.phase !== "checking") openNowBarUpdateDialog();
    return;
  }
  if (!manual && Date.now() - lastCheck < 6 * 60 * 60 * 1000) return;
  lastCheck = Date.now();
  set({ phase: "checking" });
  try {
    const response = await fetch(`${RELEASE_ROOT}latest/download/update.json`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? "The first signed release is not available yet."
          : "Could not check for updates.",
      );
    const release = parseNowBarRelease(
      await response.json(),
      Constants.expoConfig?.android?.versionCode ?? 0,
    );
    if (!release) {
      set({ phase: "idle" });
      if (manual) Alert.alert("You're up to date", "You have the latest T3 Code Now Bar release.");
      return;
    }
    if (!manual && offered === release.versionCode) {
      set({ phase: "idle" });
      return;
    }
    offered = release.versionCode;
    set({ phase: "available", release }, true);
  } catch (error) {
    set({ phase: "idle" });
    if (manual)
      Alert.alert(
        "Update check",
        error instanceof Error ? error.message : "Could not reach GitHub.",
      );
  }
}
