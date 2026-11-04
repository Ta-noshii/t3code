import { formatAssistantCitationHref } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadQueueRowControls } from "./threadQueueControlPresentation";

describe("threadQueueControlPresentation", () => {
  it.each([
    { busy: false, isEditing: false, expected: true },
    { busy: true, isEditing: false, expected: false },
    { busy: false, isEditing: true, expected: false },
  ])(
    "gates sending a stopped thread's queued message with $busy busy and $isEditing editing",
    ({ busy, isEditing, expected }) => {
      const controls = resolveThreadQueueRowControls({
        busy,
        isEditing,
        canPromoteToSteer: false,
        canSendNow: true,
        text: "Queued message",
        attachments: [],
      });

      expect(controls.canSend).toBe(expected);
    },
  );

  it("shows an assistant quote as its quoted text", () => {
    const href = formatAssistantCitationHref({
      version: 1,
      environmentId: "environment:test" as never,
      threadId: "thread:test" as never,
      messageId: "message:assistant" as never,
      text: "Retry the sync after the lock clears.",
      start: 0,
      end: 37,
      prefix: "",
      suffix: "",
    });
    const controls = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      text: `[Assistant quote](${href}) Can we add a backoff here?`,
      attachments: [],
    });

    expect(controls.displayText).toBe(
      "Retry the sync after the lock clears. Can we add a backoff here?",
    );
  });

  it("does not steer /compact or /logout into a live turn, which run as their own turn", () => {
    const row = (text: string, canSendNow = false) =>
      resolveThreadQueueRowControls({
        busy: false,
        canPromoteToSteer: true,
        canSendNow,
        text,
        attachments: [],
      });

    expect(row(" /compact").canSend).toBe(false);
    expect(row("/logout").canSend).toBe(false);
    expect(row("/compact", true).canSend).toBe(true);
    expect(row("/compact the parser notes").canSend).toBe(true);
  });

  it("keeps the row already open in the composer from being reopened or steered", () => {
    const editing = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      isEditing: true,
      text: "Being edited",
      attachments: [],
    });

    expect(editing.isEditing).toBe(true);
    expect(editing.canEdit).toBe(false);
    expect(editing.canSend).toBe(false);
    expect(editing.canDismiss).toBe(true);
  });

  it("lets the owner cancel a guest's queued message but not rewrite it", () => {
    const guest = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canSendNow: false,
      isGuestMessage: true,
      text: "Why?",
      attachments: [],
    });

    expect(guest.canEdit).toBe(false);
    expect(guest.canDismiss).toBe(true);
  });
});
