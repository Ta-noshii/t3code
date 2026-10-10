import { describe, expect, it } from "@effect/vitest";

import {
  codexReviewTargetLabel,
  formatCodexReviewCommand,
  parseCodexReviewCommand,
  subagentCodexReview,
  type CodexReviewTarget,
} from "./codexReview.ts";

describe("parseCodexReviewCommand", () => {
  it.each<[string, CodexReviewTarget | null]>([
    ["/review", { type: "uncommittedChanges" }],
    ["  /review --uncommitted ", { type: "uncommittedChanges" }],
    ["/review --base main", { type: "baseBranch", branch: "main" }],
    ["/review --commit 7a123a0", { type: "commit", sha: "7a123a0" }],
    [
      "/review --commit 7a123a0 --title fix: adapt patches",
      { type: "commit", sha: "7a123a0", title: "fix: adapt patches" },
    ],
    ["/review focus on the auth flow", { type: "custom", instructions: "focus on the auth flow" }],
    ["/review --base main and more", { type: "custom", instructions: "--base main and more" }],
    ["/reviewer", null],
    ["please /review this", null],
  ])("parses %j", (text, expected) => {
    expect(parseCodexReviewCommand(text)).toEqual(expected);
  });

  it("round-trips every target through its command text", () => {
    const targets: ReadonlyArray<CodexReviewTarget> = [
      { type: "uncommittedChanges" },
      { type: "baseBranch", branch: "upstream/main" },
      { type: "commit", sha: "abc1234def" },
      { type: "commit", sha: "abc1234def", title: "feat: thing" },
      { type: "custom", instructions: "look at\nthe parser" },
    ];
    for (const target of targets) {
      expect(parseCodexReviewCommand(formatCodexReviewCommand(target))).toEqual(target);
    }
  });

  it("labels a commit by its short sha", () => {
    expect(codexReviewTargetLabel({ type: "commit", sha: "abc1234def" })).toBe("commit abc1234");
  });
});

describe("subagentCodexReview", () => {
  it("marks only Codex children started with /review", () => {
    expect(subagentCodexReview({ driver: "codex", prompt: "/review --base main" })).toEqual({
      type: "baseBranch",
      branch: "main",
    });
    expect(subagentCodexReview({ driver: "claudeAgent", prompt: "/review" })).toBeNull();
    expect(subagentCodexReview({ driver: "codex", prompt: "Review the diff." })).toBeNull();
  });
});
