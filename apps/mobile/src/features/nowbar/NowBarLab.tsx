import * as Notifications from "expo-notifications";
import { useEffect, useState } from "react";
import { Alert, AppState, Modal, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useServerConfigs } from "../../state/entities";
import { debugModel, debugRow, debugStates, type DebugState } from "./debug";
import { nowBarNative } from "./native";

async function postDebugState(
  id: DebugState,
  all: boolean,
  progress: number,
  custom: boolean,
  nudge: boolean,
  expanded: boolean,
  model: ReturnType<typeof debugModel>,
) {
  if (!(await Notifications.requestPermissionsAsync()).granted)
    throw new Error("Allow notifications in Android settings first.");
  const now = Date.now();
  const rows = all
    ? debugStates.map((state) => debugRow(state.id, now, progress))
    : [debugRow(id, now, progress)];
  nowBarNative?.debugShow(
    JSON.stringify(
      rows.map((row) => ({
        ...row,
        ...model,
      })),
    ),
    custom,
    nudge,
    expanded,
  );
}

export function NowBarLab({ onClose }: { onClose: () => void }) {
  const catalogs = useServerConfigs();
  const [selected, setSelected] = useState<DebugState>("progress");
  const [custom, setCustom] = useState(true);
  const [steps, setSteps] = useState(3);
  const [expanded, setExpanded] = useState(false);
  const [brand, setBrand] = useState("OpenAI");
  const [status, setStatus] = useState(() => nowBarNative?.debugStatus());
  const refresh = () => setStatus(nowBarNative?.debugStatus());
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setStatus(nowBarNative?.debugStatus());
    });
    return () => subscription.remove();
  }, []);
  const show = async (
    id: DebugState,
    all = false,
    progress = steps,
    useCustom = custom,
    nudge = false,
    large = expanded,
    provider = brand,
  ) => {
    try {
      await postDebugState(
        id,
        all,
        progress,
        useCustom,
        nudge,
        large,
        debugModel(catalogs.values(), provider),
      );
      setSelected(id);
      refresh();
    } catch (error) {
      Alert.alert(
        "Now Bar Lab",
        error instanceof Error ? error.message : "Could not show test notification.",
      );
    }
  };
  const button = (label: string, onPress: () => void, active = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        borderRadius: 14,
        paddingVertical: 14,
        paddingHorizontal: 16,
        backgroundColor: active ? "#38383D" : "#222225",
        flexGrow: 1,
      }}
    >
      <Text style={{ color: "#F4EFFF", fontWeight: "600", textAlign: "center" }}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#141416", paddingTop: 52, paddingBottom: 24 }}>
        <View
          style={{
            paddingHorizontal: 22,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text style={{ color: "#F4EFFF", fontSize: 26, fontWeight: "700" }}>Now Bar Lab</Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={{ padding: 12 }}>
            <Text style={{ color: "#C2A7FF" }}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 22, gap: 18 }}>
          <Text style={{ color: "#B8AEC9", lineHeight: 22 }}>
            Tap any state, then lock your phone to inspect its real notification. These are isolated
            test cards; they never run an agent or change unread threads.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {button(
              "Samsung custom",
              () => {
                setCustom(true);
                void show(selected, false, steps, true);
              },
              custom,
            )}
            {button(
              "Standard",
              () => {
                setCustom(false);
                void show(selected, false, steps, false);
              },
              !custom,
            )}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {debugStates.map((state) => (
              <View key={state.id} style={{ width: "48%", flexGrow: 1 }}>
                {button(
                  state.label,
                  () => {
                    void show(state.id);
                  },
                  selected === state.id,
                )}
              </View>
            ))}
          </View>
          <View style={{ padding: 18, borderRadius: 18, backgroundColor: "#202023", gap: 14 }}>
            <Text style={{ color: "#D7C5F7", fontWeight: "700" }}>
              Interactive plan · {steps}/8 steps
            </Text>
            <View style={{ flexDirection: "row", gap: 4 }}>
              {Array.from({ length: 8 }, (_, index) => (
                <View
                  key={index}
                  style={{
                    flex: 1,
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: index < steps ? "#B696FF" : "#453A57",
                  }}
                />
              ))}
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {button("− Step", () => {
                const next = Math.max(0, steps - 1);
                setSteps(next);
                void show("progress", false, next);
              })}
              {button("+ Step", () => {
                const next = Math.min(8, steps + 1);
                setSteps(next);
                void show("progress", false, next);
              })}
            </View>
          </View>
          {button("Load all states · Next state on notification", () => {
            void show("working", true);
          })}
          <View style={{ flexDirection: "row", gap: 8 }}>
            {button(
              "Compact",
              () => {
                setExpanded(false);
                void show(selected, false, steps, custom, false, false);
              },
              !expanded,
            )}
            {button(
              "Expanded layout",
              () => {
                setExpanded(true);
                void show(selected, false, steps, custom, false, true);
              },
              expanded,
            )}
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {button(
              "OpenAI",
              () => {
                setBrand("OpenAI");
                void show(selected, false, steps, custom, false, expanded, "OpenAI");
              },
              brand === "OpenAI",
            )}
            {button(
              "Claude",
              () => {
                setBrand("Claude");
                void show(selected, false, steps, custom, false, expanded, "Claude");
              },
              brand === "Claude",
            )}
          </View>
          {button("Nudge selected state", () => {
            void show(selected, false, steps, custom, true);
          })}
          {button("Test attention nudge", () => {
            void show("input", false, steps, custom, true);
          })}
          {button("Test completion nudge", () => {
            void show("completed", false, steps, custom, true);
          })}
          <Text style={{ color: "#AAAAB0", fontSize: 12 }}>
            Expanded layout forces the larger test layout. Normal notifications let Samsung choose
            the size. Nudges use Android's alert channel and respect your pop-up and Do Not Disturb
            settings.
          </Text>
          {button("Clear test notification", () => {
            nowBarNative?.debugClear();
            refresh();
          })}
          <View style={{ borderRadius: 18, padding: 18, backgroundColor: "#202023", gap: 8 }}>
            <Text style={{ color: "#E9DCF9", fontWeight: "700" }}>Device diagnostics</Text>
            <Text style={{ color: "#B8AEC9" }}>
              Test posted: {status?.active ? "Yes" : "No"}
              {"\n"}Custom components attached: {status?.customAttached ? "Yes" : "No"}
              {"\n"}Android promotion flag: {status?.promoted ? "Yes" : "No"}
            </Text>
            <Text style={{ color: "#91859F", fontSize: 12 }}>
              Attached confirms the layout reached the notification. Only looking at your lock
              screen confirms Samsung rendered it. Tests clear automatically after ten minutes.
            </Text>
            {button("Refresh diagnostics", refresh)}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
