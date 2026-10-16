import { describe, expect, it } from "vite-plus/test";
import { parseSuggestedReplies } from "./suggestedReplies.ts";

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
