import { useAuth } from "@clerk/expo";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useEffect, useState } from "react";
import { Alert, Platform } from "react-native";
import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import {
  clearAndroidAgentNotifications,
  configureAndroidAgentNotifications,
} from "../agent-awareness/androidNotifications";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { nowBarNative, saveNowBarPreferences, useNowBarPreferences } from "./native";

export const hasHostPush =
  Platform.OS === "android" &&
  Constants.expoConfig?.extra?.nowbar?.pushTransport === "host" &&
  Constants.expoConfig?.extra?.nowbar?.firebaseConfigured === true;

export function HostPushCoordinator() {
  const { isLoaded, userId } = useAuth();
  const preferences = useNowBarPreferences();
  useEffect(() => {
    if (!hasHostPush || !isLoaded) return;
    let cancelled = false;
    if (!userId || !preferences.push) {
      clearAndroidAgentNotifications();
      nowBarNative?.clearRemotePush();
    } else
      void loadOrCreateAgentAwarenessDeviceId()
        .then((deviceId) => {
          if (!cancelled)
            configureAndroidAgentNotifications(deviceId, userId, preferences.pushLive);
        })
        .catch(() => console.warn("[nowbar] Could not configure the push receiver"));
    return () => {
      cancelled = true;
    };
  }, [isLoaded, userId, preferences.push, preferences.pushLive]);
  return null;
}

// Outside the component: React Compiler skips a component with a try block.
async function exportPushDevice(userId: string, pushLive: boolean) {
  try {
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) throw new Error("Allow notifications in Android settings first.");
    const token = await Notifications.getDevicePushTokenAsync();
    if (typeof token.data !== "string" || !token.data)
      throw new Error("Firebase did not issue a device token.");
    const deviceId = await loadOrCreateAgentAwarenessDeviceId();
    configureAndroidAgentNotifications(deviceId, userId, pushLive);
    saveNowBarPreferences({ push: true });
    const file = new File(Paths.cache, "t3-nowbar-device.json");
    file.write(
      JSON.stringify({
        token: token.data,
        deviceId,
        userId,
        packageName: Constants.expoConfig?.android?.package,
        unreadSince: nowBarNative?.readState().since,
      }),
    );
    try {
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/json",
        dialogTitle: "Pair this phone with the misc push sender",
      });
    } finally {
      if (file.exists) file.delete();
    }
  } catch (error) {
    Alert.alert(
      "Remote notifications",
      error instanceof Error ? error.message : "Could not prepare push setup.",
    );
  }
}

export function HostPushSettings({ userId }: { readonly userId: string | null }) {
  const preferences = useNowBarPreferences();
  const [busy, setBusy] = useState(false);
  const exportDevice = async () => {
    if (!userId) return;
    setBusy(true);
    await exportPushDevice(userId, preferences.pushLive);
    setBusy(false);
  };
  return (
    <>
      <SettingsSwitchRow
        icon="bell.badge"
        label="Device Notifications"
        subtitle={
          preferences.push
            ? "Receiver enabled · Pair misc with the setup file"
            : "Receive updates from misc while the app is closed"
        }
        value={preferences.push}
        disabled={busy || !userId}
        onValueChange={(enabled) => {
          if (enabled) void exportDevice();
          else saveNowBarPreferences({ push: false });
        }}
      />
      <SettingsSwitchRow
        icon="bolt.circle"
        label="Ongoing Agent Activity"
        subtitle="Show activity delivered by your private push sender"
        value={preferences.push && preferences.pushLive}
        disabled={!preferences.push || busy}
        onValueChange={(pushLive) => saveNowBarPreferences({ pushLive })}
      />
      <SettingsRow
        icon="arrow.up"
        label="Share push setup with misc"
        disabled={busy || !userId}
        onPress={() => {
          void exportDevice();
        }}
      />
    </>
  );
}
