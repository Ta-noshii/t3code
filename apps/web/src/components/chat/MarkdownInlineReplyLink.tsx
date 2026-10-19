import { CornerDownRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

/**
 * A phrase the agent linked with `t3-reply:`. A click sends the reply as the
 * next message; Shift+click puts it in the composer to edit first.
 */
export function MarkdownInlineReplyLink({
  reply,
  onSend,
  onInsert,
  children,
}: {
  reply: string;
  onSend: (text: string) => Promise<void>;
  onInsert: (text: string) => void;
  children: ReactNode;
}) {
  const [sending, setSending] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline cursor-pointer rounded-sm text-left font-medium text-foreground underline decoration-muted-foreground/50 decoration-dotted underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60"
            disabled={sending}
            aria-description="Sends this as your next message"
            onClick={(event) => {
              if (event.shiftKey) {
                onInsert(reply);
                return;
              }
              setSending(true);
              onSend(reply).then(
                () => setSending(false),
                (error: unknown) => {
                  setSending(false);
                  toastManager.add({
                    type: "error",
                    title: "Reply not sent",
                    description:
                      error instanceof Error ? error.message : "Try again from the composer.",
                  });
                },
              );
            }}
          />
        }
      >
        <CornerDownRightIcon
          aria-hidden
          className="mr-0.5 inline size-3.5 -translate-y-px text-muted-foreground"
        />
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80">
        <span className="block">{`Send "${reply}"`}</span>
        <span className="block text-muted-foreground">Shift+click to edit it first</span>
      </TooltipPopup>
    </Tooltip>
  );
}
