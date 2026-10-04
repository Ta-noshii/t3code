import type { ModelSelection, ServerProvider, ThreadTransferMessage } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import type { ChatMessage } from "../types";

/**
 * A chat's finished user and assistant messages in the shape servers exchange.
 * Context links collapse to their labels and attachments to their names, since
 * neither exists on the other machine.
 */
export function chatCopyMessages(messages: ReadonlyArray<ChatMessage>): ThreadTransferMessage[] {
  return messages.flatMap((message) => {
    if (message.streaming || (message.role !== "user" && message.role !== "assistant")) return [];
    const text = replaceComposerContextReferences(
      message.text,
      (reference) => reference.label,
    ).trim();
    const attachments = (message.attachments ?? []).map((attachment) => attachment.name);
    const body = [text, attachments.length > 0 ? `(Attached: ${attachments.join(", ")})` : ""]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (body.length === 0) return [];
    return [{ role: message.role, text: body, createdAt: message.createdAt }];
  });
}

/**
 * The model a copy uses on another environment. Instance ids are per machine,
 * so the source's instance is kept only when the target has it with the same
 * driver; otherwise the target's first usable instance of that driver. Null
 * when the target has none.
 */
export function resolveCopyModelSelection(input: {
  source: ModelSelection;
  sourceProviders: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
  targetProviders: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "driver" | "enabled" | "installed">
  >;
}): ModelSelection | null {
  const driver = input.sourceProviders.find(
    (provider) => provider.instanceId === input.source.instanceId,
  )?.driver;
  const usable = input.targetProviders.filter(
    (provider) => provider.enabled && provider.installed && provider.driver === driver,
  );
  const target =
    usable.find((provider) => provider.instanceId === input.source.instanceId) ?? usable[0];
  return target ? { ...input.source, instanceId: target.instanceId } : null;
}

const TAKE_OVER_REQUEST =
  "Don't run tools or change files yet. Reply with a short summary of where we left off and what was about to happen next, then wait for my next message.";

/**
 * First message of a copy on a server that holds the earlier conversation as
 * imported history but could not take the agent's session. The server hands
 * the history to the agent with this message.
 */
export function buildCopySummaryPrompt(input: { title: string; copiedFrom: string }): string {
  return `This chat was copied from "${input.title}" on ${input.copiedFrom}, another machine. Your earlier session could not come with it, so the conversation so far is included above as context. File paths and the working tree here may differ from ${input.copiedFrom}. ${TAKE_OVER_REQUEST}`;
}

/**
 * First message of a copy on a server without the import RPC. It carries the
 * conversation and asks the agent to take it over, so the copy is ready
 * without the user resending anything. The oldest messages drop out when the
 * whole conversation would pass `maxChars`.
 */
export function buildCopyHandoffMessage(input: {
  title: string;
  messages: ReadonlyArray<Pick<ThreadTransferMessage, "role" | "text">>;
  copiedFrom: string;
  maxChars: number;
}): string {
  const intro = `This chat was copied from "${input.title}" on ${input.copiedFrom}, another machine. Your earlier session could not come with it, so the conversation so far is below, oldest first. File paths and the working tree here may differ from ${input.copiedFrom}.`;
  const outro = `# Your task now\n\nRead the conversation above and take it over as your own. ${TAKE_OVER_REQUEST}`;
  const sections = input.messages.map(
    (message) => `## ${message.role === "user" ? "User" : "Assistant"}\n\n${message.text}`,
  );
  const budget = input.maxChars - intro.length - outro.length - 200;
  const kept: string[] = [];
  let used = 0;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index]!;
    if (used + section.length + 2 > budget) break;
    kept.unshift(section);
    used += section.length + 2;
  }
  const dropped = sections.length - kept.length;
  return [
    intro,
    "# Earlier conversation",
    ...(dropped > 0
      ? [`(The ${dropped} oldest messages were left out to fit the message size limit.)`]
      : []),
    ...kept,
    outro,
  ].join("\n\n");
}
