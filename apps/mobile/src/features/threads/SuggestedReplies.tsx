import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

/**
 * Replies the agent offered at the end of its message. A tap sends the reply;
 * a long press puts it in the composer so it can be edited first.
 */
export function SuggestedReplies(props: {
  readonly replies: ReadonlyArray<string>;
  readonly onSend: (text: string) => Promise<unknown>;
  readonly onInsert: (text: string) => void;
}) {
  const [sending, setSending] = useState(false);

  return (
    <View
      className="mt-2 flex-row flex-wrap gap-2"
      accessibilityRole="toolbar"
      accessibilityLabel="Suggested replies"
    >
      {props.replies.map((reply) => (
        <Pressable
          key={reply}
          accessibilityRole="button"
          accessibilityLabel={reply}
          accessibilityHint="Sends this reply. Long press to edit it in the composer first."
          disabled={sending}
          className="max-w-full min-h-9 justify-center rounded-full border border-border bg-card px-3.5 active:opacity-65"
          style={sending ? { opacity: 0.5 } : null}
          onPress={() => {
            void Haptics.selectionAsync();
            setSending(true);
            props.onSend(reply).then(
              (messageId) => {
                if (messageId === null) setSending(false);
              },
              () => setSending(false),
            );
          }}
          onLongPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            props.onInsert(reply);
          }}
        >
          <Text className="font-t3-medium text-sm text-foreground" numberOfLines={2}>
            {reply}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
