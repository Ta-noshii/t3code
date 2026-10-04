import * as Notifications from "expo-notifications";
import { useEffect, useState } from "react";
import { Alert, AppState, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { nowBarNative, saveNowBarPreferences, useNowBarPreferences } from "./native";
import { nowBarUpdateProgressLabel } from "./NowBarUpdateDialog";
import { checkNowBarUpdate, useNowBarUpdate } from "./updates";
import { NowBarLab } from "./NowBarLab";

export function NowBarSettings() {
  const preferences = useNowBarPreferences();
  const update = useNowBarUpdate();
  const [capabilities, setCapabilities] = useState(() => nowBarNative?.capabilities());
  const [busy, setBusy] = useState(false);
  const [lab, setLab] = useState(false);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setCapabilities(nowBarNative?.capabilities());
    });
    return () => subscription.remove();
  }, []);
  if (!nowBarNative) return null;
  const enable = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (enabled) {
        const permission = await Notifications.requestPermissionsAsync();
        if (!permission.granted) {
          Alert.alert(
            "Notifications are disabled",
            "Allow notifications in Android settings to use Now Bar.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open settings", onPress: () => nowBarNative?.openSettings() },
            ],
          );
          return;
        }
      }
      saveNowBarPreferences({ enabled });
      setCapabilities(nowBarNative?.capabilities());
    } catch (error) {
      Alert.alert(
        "Now Bar",
        error instanceof Error ? error.message : "Could not change notification settings.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3">
      {lab && <NowBarLab onClose={() => setLab(false)} />}
      <SettingsSection title="Samsung Now Bar">
        <SettingsSwitchRow
          icon="bell.badge"
          label="Attention nudges"
          subtitle="Alert once for approvals, questions and plans ready for review"
          value={preferences.nudges}
          onValueChange={(nudges) => saveNowBarPreferences({ nudges })}
        />
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Samsung custom components"
          subtitle="Model logo, live status and plan progress"
          value={preferences.custom}
          onValueChange={(custom) => saveNowBarPreferences({ custom })}
        />
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Expanded layout"
          subtitle="Show the status line and model name on live cards"
          value={preferences.expanded}
          disabled={!preferences.custom}
          onValueChange={(expanded) => saveNowBarPreferences({ expanded })}
        />
        <SettingsRow
          icon="gearshape"
          label="Now Bar Lab"
          value="Test every state"
          onPress={() => setLab(true)}
        />
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Live agent work"
          subtitle="Live work and unread results on your lock screen"
          value={preferences.enabled}
          disabled={busy}
          onValueChange={(value) => {
            void enable(value);
          }}
        />
        <SettingsSwitchRow
          icon="bell.badge"
          label="Completion notifications"
          subtitle="Alert once when work finishes, fails or is stopped"
          value={preferences.results}
          onValueChange={(results) => saveNowBarPreferences({ results })}
        />
        <SettingsSwitchRow
          icon={{ ios: "lock", android: "lock" }}
          label="Hide task details"
          subtitle="Keep names and plan steps off all notification surfaces"
          value={preferences.private}
          onValueChange={(value) => saveNowBarPreferences({ private: value })}
        />
        <SettingsRow
          icon="gearshape"
          label="Live notification settings"
          value={capabilities?.promoted ? "Allowed" : "Enable"}
          onPress={() => nowBarNative?.openSettings()}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Enable Live notifications for T3 Code Now Bar in Samsung settings. Start monitoring while
        the app is open; it stays connected while work is active. Use Unpin to stop monitoring
        current tasks. Completed results stay until you open the thread or dismiss the result.
        Unread tracking starts with this update on this device. Opening the app again reconnects
        after Android stops it.
      </Text>
      <SettingsSection title="Fork updates">
        <SettingsSwitchRow
          icon="arrow.down.circle"
          label="Automatic update checks"
          subtitle="Check GitHub on launch and every six hours when you return"
          value={preferences.updates}
          onValueChange={(updates) => saveNowBarPreferences({ updates })}
        />
        <SettingsRow
          icon="arrow.down.circle"
          label="Check for updates"
          value={
            nowBarUpdateProgressLabel(update.state) ??
            ("release" in update.state ? `${update.state.release.version} ready` : undefined)
          }
          onPress={() => {
            void checkNowBarUpdate(true);
          }}
        />
      </SettingsSection>
    </View>
  );
}
