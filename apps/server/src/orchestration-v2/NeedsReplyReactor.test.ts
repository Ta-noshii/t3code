import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { needsReplyRequestFor } from "./NeedsReplyReactor.ts";

const assistantMessage = (fields: { text: string; streaming?: boolean; runId?: string | null }) =>
  ({
    type: "turn-item.updated",
    threadId: "thread:a",
    payload: {
      type: "assistant_message",
      id: "item:1",
      runId: fields.runId === undefined ? "run:1" : fields.runId,
      text: fields.text,
      streaming: fields.streaming ?? false,
    },
  }) as unknown as OrchestrationV2DomainEvent;

describe("needsReplyRequestFor", () => {
  it("marks the message's run when it ends with a needs-reply block", () => {
    expect(
      needsReplyRequestFor(
        assistantMessage({ text: "Which one?\n\n```t3-needs-reply\nPick a target\n```" }),
      ),
    ).toEqual({ itemId: "item:1", runId: "run:1", note: "Pick a target" });
  });

  it("waits for the message to finish streaming", () => {
    expect(
      needsReplyRequestFor(
        assistantMessage({ text: "Which?\n```t3-needs-reply\nPick\n```", streaming: true }),
      ),
    ).toBeNull();
  });

  it("ignores messages without the block and messages outside a run", () => {
    expect(needsReplyRequestFor(assistantMessage({ text: "All done." }))).toBeNull();
    expect(
      needsReplyRequestFor(
        assistantMessage({ text: "Which?\n```t3-needs-reply\nPick\n```", runId: null }),
      ),
    ).toBeNull();
  });
});
