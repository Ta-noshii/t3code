import { useNavigation } from "@react-navigation/native";
import type { CanvasSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useCanvasEvents } from "../../state/canvas";
import { canvasRouteParams } from "./canvasRoutes";

/**
 * Offers the canvas an agent opens with `canvas_open` in this thread, above
 * the composer. It never navigates by itself, so a reply in progress is not
 * interrupted.
 */
export function CanvasFocusNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigation = useNavigation();
  const [canvas, setCanvas] = useState<CanvasSummary | null>(null);
  useCanvasEvents(props.environmentId, (event) => {
    if (event.type === "focus" && event.threadId === props.threadId) setCanvas(event.canvas);
  });
  if (canvas === null) return null;
  const open = () => {
    setCanvas(null);
    navigation.navigate("Canvas", canvasRouteParams(props.environmentId, canvas));
  };
  return (
    <Animated.View
      className="shrink-0 px-4 pb-3"
      entering={FadeInDown.duration(220)}
      exiting={FadeOut.duration(140)}
    >
      <View className="flex-row items-center gap-3 rounded-[20px] border-continuous bg-card py-2 pl-4 pr-2">
        <SymbolView
          name="scribble.variable"
          size={18}
          tintColorClassName="accent-icon"
          type="monochrome"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open canvas ${canvas.title}`}
          onPress={open}
          className="min-w-0 flex-1 active:opacity-60"
        >
          <Text className="text-xs text-foreground-muted">The agent opened a canvas</Text>
          <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
            {canvas.title}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={open}
          className="rounded-full bg-primary px-3.5 py-1.5 active:opacity-70"
        >
          <Text className="text-sm font-t3-bold text-primary-foreground">Open</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => setCanvas(null)}
          className="p-1.5 active:opacity-60"
        >
          <SymbolView
            name="xmark"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      </View>
    </Animated.View>
  );
}
