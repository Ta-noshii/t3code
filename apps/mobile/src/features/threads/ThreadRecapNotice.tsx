import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

/** The "while you were away" recap of a finished thread, docked above the composer. */
export function ThreadRecapNotice({
  recap,
  onDismiss,
}: {
  readonly recap: string;
  readonly onDismiss: () => void;
}) {
  return (
    <View className="px-4 pb-3">
      <View className="gap-1.5 rounded-[20px] border-continuous bg-card p-4">
        <View className="flex-row items-center gap-2">
          <SymbolView
            name="clock"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
          <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">
            While you were away
          </Text>
          <Pressable
            accessibilityLabel="Dismiss recap"
            accessibilityRole="button"
            hitSlop={12}
            onPress={onDismiss}
            className="p-1 active:opacity-60"
          >
            <SymbolView
              name="xmark"
              size={14}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </View>
        <Text selectable accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {recap}
        </Text>
      </View>
    </View>
  );
}
