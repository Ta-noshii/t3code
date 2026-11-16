import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

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
  const queued = projection.runs
    .filter((run) => run.status === "queued")
    .toSorted(
      (left, right) =>
        (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );
  const completions = queued.filter((run) => automaticCompletionMessageIds.has(run.userMessageId));
  const messages = queued.filter((run) => !automaticCompletionMessageIds.has(run.userMessageId));
  // Completions and messages each keep their queue order and interleave by request time,
  // so neither kind can hold the other back while more of it keeps arriving.
  const ordered: Array<OrchestrationV2Run> = [];
  let completionIndex = 0;
  let messageIndex = 0;
  for (;;) {
    const completion = completions[completionIndex];
    const message = messages[messageIndex];
    if (completion === undefined || message === undefined) {
      return [...ordered, ...completions.slice(completionIndex), ...messages.slice(messageIndex)];
    }
    if (
      DateTime.toEpochMillis(completion.requestedAt) <= DateTime.toEpochMillis(message.requestedAt)
    ) {
      ordered.push(completion);
      completionIndex += 1;
    } else {
      ordered.push(message);
      messageIndex += 1;
    }
  }
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
