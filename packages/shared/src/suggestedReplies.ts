/**
 * Suggested replies: an assistant message may end with a fenced block whose
 * info string is `t3-replies`, one reply per line. Clients hide the block and
 * show each line as a button that sends that reply.
 *
 * ```t3-replies
 * Ship it
 * Show me the diff first
 * ```
 *
 * Only a block that is the last thing in the message counts. While the block
 * is still streaming (no closing fence yet) it is hidden but yields no
 * replies, so buttons never appear half-written.
 */

export const SUGGESTED_REPLIES_INFO_STRING = "t3-replies";
export const MAX_SUGGESTED_REPLIES = 4;
export const MAX_SUGGESTED_REPLY_LENGTH = 200;

export interface SuggestedRepliesParse {
  /** The message with the trailing block removed. */
  readonly text: string;
  readonly replies: ReadonlyArray<string>;
}

const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*t3-replies[ \t]*$/;
const ANY_FENCE = /^ {0,3}(`{3,}|~{3,})/;

function isClosingFence(line: string, opener: string): boolean {
  const trimmed = line.trim();
  const fenceChar = opener[0]!;
  return (
    trimmed.length >= opener.length && [...trimmed].every((character) => character === fenceChar)
  );
}

function cleanReply(line: string): string | null {
  const reply = line
    .trim()
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .trim();
  if (reply.length === 0) return null;
  return reply.length > MAX_SUGGESTED_REPLY_LENGTH
    ? reply.slice(0, MAX_SUGGESTED_REPLY_LENGTH).trimEnd()
    : reply;
}

export function parseSuggestedReplies(markdown: string): SuggestedRepliesParse {
  if (!markdown.includes(SUGGESTED_REPLIES_INFO_STRING)) {
    return { text: markdown, replies: [] };
  }
  const lines = markdown.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  if (end === 0) return { text: markdown, replies: [] };

  // Walk up from the last line to the nearest fence line. If it opens a
  // t3-replies block, the block is unclosed (still streaming). If it closes
  // one, the next fence above must be the t3-replies opener.
  let index = end - 1;
  while (index >= 0 && !ANY_FENCE.test(lines[index]!)) index -= 1;
  if (index < 0) return { text: markdown, replies: [] };

  const lastFence = lines[index]!;
  const openMatch = OPEN_FENCE.exec(lastFence);
  if (openMatch !== null) {
    return { text: lines.slice(0, index).join("\n").trimEnd(), replies: [] };
  }
  if (index !== end - 1) return { text: markdown, replies: [] };

  let openIndex = index - 1;
  while (openIndex >= 0 && !ANY_FENCE.test(lines[openIndex]!)) openIndex -= 1;
  if (openIndex < 0) return { text: markdown, replies: [] };
  const opener = OPEN_FENCE.exec(lines[openIndex]!);
  if (opener === null || !isClosingFence(lastFence, opener[1]!)) {
    return { text: markdown, replies: [] };
  }

  const replies: string[] = [];
  for (const line of lines.slice(openIndex + 1, index)) {
    const reply = cleanReply(line);
    if (reply !== null && !replies.includes(reply)) replies.push(reply);
    if (replies.length === MAX_SUGGESTED_REPLIES) break;
  }
  return { text: lines.slice(0, openIndex).join("\n").trimEnd(), replies };
}
