import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export function isAutomaticCompletionRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  run: OrchestrationV2Run,
): boolean {
  return projection.messages.some(
    (message) => message.id === run.userMessageId && message.delegatedCompletion !== undefined,
  );
}

export function queuedRunsInDeliveryOrder(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): ReadonlyArray<OrchestrationV2Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  return projection.runs
    .filter((run) => run.status === "queued")
    .toSorted((left, right) => {
      const deliveryPriority =
        Number(automaticCompletionMessageIds.has(right.userMessageId)) -
        Number(automaticCompletionMessageIds.has(left.userMessageId));
      return (
        deliveryPriority ||
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal
      );
    });
}

type QueuedMessageContent = Pick<
  OrchestrationV2ConversationMessage,
  "text" | "attachments" | "context"
>;

/**
 * Combines queued messages, in queue order, into the one message "Send all" steers:
 * texts joined by a blank line, and every attachment and context record kept.
 */
export function mergeQueuedMessages(messages: ReadonlyArray<QueuedMessageContent>) {
  const attachments = messages
    .flatMap((message) => message.attachments)
    .filter((attachment, index, all) => all.findIndex((a) => a.id === attachment.id) === index);
  const records = messages
    .flatMap((message) => message.context?.records ?? [])
    .filter(
      (record, index, all) => all.findIndex((r) => r.contextId === record.contextId) === index,
    );
  return {
    text: messages
      .map((message) => message.text.trim())
      .filter((text) => text.length > 0)
      .join("\n\n"),
    attachments,
    ...(records.length === 0 ? {} : { context: { version: 1 as const, records } }),
  };
}
