import { describe, expect, it } from "vite-plus/test";
import {
  normalizeInlineReplyLinks,
  parseInlineReplyHref,
  parseSuggestedReplies,
  stripInlineReplyLinks,
} from "./suggestedReplies.ts";

describe("parseSuggestedReplies", () => {
  it("strips a trailing block and returns its lines", () => {
    expect(
      parseSuggestedReplies(
        "Tests pass. Ship it?\n\n```t3-replies\nShip it\n- Show me the diff first\n\n```\n",
      ),
    ).toEqual({
      text: "Tests pass. Ship it?",
      replies: ["Ship it", "Show me the diff first"],
    });
  });

  it("hides an unclosed block without offering half-written replies", () => {
    expect(parseSuggestedReplies("Done.\n\n```t3-replies\nShip i")).toEqual({
      text: "Done.",
      replies: [],
    });
  });

  it("ignores a block that is not the end of the message", () => {
    const text = "Use this syntax:\n\n```t3-replies\nYes\n```\n\nThen keep writing.";
    expect(parseSuggestedReplies(text)).toEqual({ text, replies: [] });
  });

  it("leaves other trailing code blocks alone", () => {
    const text = "Run:\n\n```sh\nt3-replies --help\n```";
    expect(parseSuggestedReplies(text)).toEqual({ text, replies: [] });
  });

  it("dedupes and caps the list at four replies", () => {
    expect(
      parseSuggestedReplies("Pick one.\n~~~t3-replies\n1. A\nB\nA\nC\nD\nE\n~~~").replies,
    ).toEqual(["A", "B", "C", "D"]);
  });
});

describe("inline reply links", () => {
  it("moves the reply into the href, from the label or the title", () => {
    expect(
      normalizeInlineReplyLinks(
        'More on [the **tracklist**](t3-reply:) or [the director](t3-reply: "Who directed it?")?',
      ),
    ).toBe(
      "More on [the **tracklist**](t3-reply:the%20tracklist) or [the director](t3-reply:Who%20directed%20it%3F)?",
    );
  });

  it("leaves code spans and fenced blocks alone", () => {
    const text = "Write `[x](t3-reply:)` like this:\n\n```md\n[x](t3-reply:)\n```";
    expect(normalizeInlineReplyLinks(text)).toBe(text);
  });

  it("parses a normalized href and ignores others", () => {
    expect(parseInlineReplyHref("t3-reply:Who%20directed%20it%3F")).toBe("Who directed it?");
    expect(parseInlineReplyHref("t3-reply:")).toBeNull();
    expect(parseInlineReplyHref("https://example.com")).toBeNull();
  });

  it("strips links to their labels for copying", () => {
    expect(stripInlineReplyLinks('See [the tracklist](t3-reply: "Tell me").')).toBe(
      "See the tracklist.",
    );
  });
});
