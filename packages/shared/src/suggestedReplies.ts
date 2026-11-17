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

export const NEEDS_REPLY_INFO_STRING = "t3-needs-reply";
export const MAX_NEEDS_REPLY_NOTE_LENGTH = 120;

const ANY_FENCE = /^ {0,3}(`{3,}|~{3,})/;

function isClosingFence(line: string, opener: string): boolean {
  const trimmed = line.trim();
  const fenceChar = opener[0]!;
  return (
    trimmed.length >= opener.length && [...trimmed].every((character) => character === fenceChar)
  );
}

function openFencePattern(infoString: string): RegExp {
  return new RegExp(`^ {0,3}(\`{3,}|~{3,})[ \\t]*${infoString}[ \\t]*$`);
}
const OPEN_FENCES = {
  [SUGGESTED_REPLIES_INFO_STRING]: openFencePattern(SUGGESTED_REPLIES_INFO_STRING),
  [NEEDS_REPLY_INFO_STRING]: openFencePattern(NEEDS_REPLY_INFO_STRING),
} as const;
type TrailingBlockKind = keyof typeof OPEN_FENCES;

/**
 * Finds a trailing fenced block of one of the T3 kinds. `body` is null while
 * the block is still streaming (no closing fence yet).
 */
function peelTrailingBlock(
  lines: ReadonlyArray<string>,
): { kind: TrailingBlockKind; rest: number; body: ReadonlyArray<string> | null } | null {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
  if (end === 0) return null;

  // Walk up from the last line to the nearest fence line. If it opens a T3
  // block, the block is unclosed. If it closes one, the next fence above must
  // be that block's opener.
  let index = end - 1;
  while (index >= 0 && !ANY_FENCE.test(lines[index]!)) index -= 1;
  if (index < 0) return null;

  const lastFence = lines[index]!;
  for (const kind of Object.keys(OPEN_FENCES) as TrailingBlockKind[]) {
    if (OPEN_FENCES[kind].test(lastFence)) return { kind, rest: index, body: null };
  }
  if (index !== end - 1) return null;

  let openIndex = index - 1;
  while (openIndex >= 0 && !ANY_FENCE.test(lines[openIndex]!)) openIndex -= 1;
  if (openIndex < 0) return null;
  for (const kind of Object.keys(OPEN_FENCES) as TrailingBlockKind[]) {
    const opener = OPEN_FENCES[kind].exec(lines[openIndex]!);
    if (opener !== null && isClosingFence(lastFence, opener[1]!)) {
      return { kind, rest: openIndex, body: lines.slice(openIndex + 1, index) };
    }
  }
  return null;
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

export interface TrailingT3BlocksParse extends SuggestedRepliesParse {
  /**
   * Set when the message ends with a closed `t3-needs-reply` block: the agent
   * is waiting on the user. `note` is the block's text, if any.
   */
  readonly needsReply: { readonly note: string | null } | null;
}

/**
 * Strips the trailing `t3-replies` and `t3-needs-reply` blocks, in either
 * order, and returns what they hold.
 *
 * ```t3-needs-reply
 * Pick a deploy target
 * ```
 */
export function parseTrailingT3Blocks(markdown: string): TrailingT3BlocksParse {
  if (
    !markdown.includes(SUGGESTED_REPLIES_INFO_STRING) &&
    !markdown.includes(NEEDS_REPLY_INFO_STRING)
  ) {
    return { text: markdown, replies: [], needsReply: null };
  }
  let lines = markdown.split("\n");
  let replies: string[] | null = null;
  let needsReply: TrailingT3BlocksParse["needsReply"] = null;
  let peeled = false;
  for (let pass = 0; pass < 2; pass += 1) {
    const block = peelTrailingBlock(lines);
    if (block === null) break;
    if (block.kind === SUGGESTED_REPLIES_INFO_STRING) {
      if (replies !== null) break;
      replies = [];
      for (const line of block.body ?? []) {
        const reply = cleanReply(line);
        if (reply !== null && !replies.includes(reply)) replies.push(reply);
        if (replies.length === MAX_SUGGESTED_REPLIES) break;
      }
    } else {
      if (needsReply !== null) break;
      const note = (block.body ?? []).join(" ").replace(/\s+/g, " ").trim();
      needsReply =
        block.body === null
          ? null
          : { note: note.length === 0 ? null : note.slice(0, MAX_NEEDS_REPLY_NOTE_LENGTH).trimEnd() };
    }
    peeled = true;
    lines = lines.slice(0, block.rest);
  }
  if (!peeled) return { text: markdown, replies: [], needsReply: null };
  return { text: lines.join("\n").trimEnd(), replies: replies ?? [], needsReply };
}

export function parseSuggestedReplies(markdown: string): SuggestedRepliesParse {
  const { text, replies } = parseTrailingT3Blocks(markdown);
  return { text, replies };
}

/**
 * Inline replies: a markdown link with the `t3-reply:` scheme turns a phrase
 * in the message into a reply the user can send with one click.
 *
 *   Want more on [the tracklist](t3-reply:) or [who directed the video](t3-reply: "Who directed the Thriller video?")?
 *
 * An empty link sends its own label; a link title sends the title instead.
 * `normalizeInlineReplyLinks` moves the reply into the destination
 * (`t3-reply:<percent-encoded text>`) so a renderer that only reports the
 * href, like the mobile one, still knows what to send.
 */

export const INLINE_REPLY_SCHEME = "t3-reply:";

const INLINE_REPLY_LINK =
  /(`+)[^\n]*?\1|\[((?:[^[\]\n\\]|\\.)+)\]\(\s*t3-reply:([^\s)]*)(?:\s+(?:"([^"\n]*)"|'([^'\n]*)'))?\s*\)/g;

function plainLabel(label: string): string {
  return label
    .replace(/\\(.)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

function decodeReply(encoded: string): string {
  try {
    return decodeURIComponent(encoded).trim();
  } catch {
    return encoded.trim();
  }
}

/** Rewrites inline reply links outside code; `code` spans and fences are left as written. */
function rewriteInlineReplyLinks(
  markdown: string,
  rewrite: (label: string, reply: string) => string,
): string {
  if (!markdown.includes(INLINE_REPLY_SCHEME)) return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fenceMatch !== null) {
        if (fence === null) fence = fenceMatch[1]!;
        else if (isClosingFence(line, fence)) fence = null;
        return line;
      }
      if (fence !== null || !line.includes(INLINE_REPLY_SCHEME)) return line;
      return line.replace(
        INLINE_REPLY_LINK,
        (
          match,
          code: string | undefined,
          label: string,
          path: string,
          double?: string,
          single?: string,
        ) => {
          if (code !== undefined) return match;
          const reply = (double ?? single)?.trim() || decodeReply(path) || plainLabel(label);
          return reply.length === 0
            ? match
            : rewrite(label, reply.slice(0, MAX_SUGGESTED_REPLY_LENGTH));
        },
      );
    })
    .join("\n");
}

export function normalizeInlineReplyLinks(markdown: string): string {
  return rewriteInlineReplyLinks(
    markdown,
    (label, reply) => `[${label}](${INLINE_REPLY_SCHEME}${encodeURIComponent(reply)})`,
  );
}

/** Copy and plain-text views keep the label and drop the link. */
export function stripInlineReplyLinks(markdown: string): string {
  return rewriteInlineReplyLinks(markdown, (label) => label);
}

/** The reply a normalized `t3-reply:` href sends, or null for any other href. */
export function parseInlineReplyHref(href: string | null | undefined): string | null {
  if (!href?.startsWith(INLINE_REPLY_SCHEME)) return null;
  const reply = decodeReply(href.slice(INLINE_REPLY_SCHEME.length));
  return reply.length === 0 ? null : reply;
}
