import { useState, type MouseEvent } from "react";

import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Replies the agent offered at the end of its message. A click sends the
 * reply; Shift+click puts it in the composer instead so it can be edited.
 */
export function SuggestedReplies({
  replies,
  onSend,
  onInsert,
}: {
  readonly replies: ReadonlyArray<string>;
  readonly onSend: (text: string) => Promise<void>;
  readonly onInsert: (text: string) => void;
}) {
  const [sending, setSending] = useState(false);

  const choose = (event: MouseEvent<HTMLButtonElement>, reply: string) => {
    if (event.shiftKey) {
      onInsert(reply);
      return;
    }
    setSending(true);
    onSend(reply).catch((error: unknown) => {
      setSending(false);
      toastManager.add({
        type: "error",
        title: "Reply not sent",
        description: error instanceof Error ? error.message : "Try again from the composer.",
      });
    });
  };

  return (
    <div
      className="mt-2 flex flex-wrap gap-1.5"
      role="group"
      aria-label="Suggested replies"
      data-scroll-anchor-ignore
    >
      {replies.map((reply) => (
        <Button
          key={reply}
          type="button"
          variant="outline"
          size="sm"
          className="max-w-full"
          disabled={sending}
          title={`${reply}\nShift+click to edit before sending`}
          onClick={(event) => choose(event, reply)}
        >
          <span className="truncate">{reply}</span>
        </Button>
      ))}
    </div>
  );
}
