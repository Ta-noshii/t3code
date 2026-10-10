/**
 * `/review`, as Codex's own `codex review` command takes it. A turn whose text
 * is a review command runs Codex's built-in reviewer (`review/start`) with its
 * own prompt instead of sending the text to the model.
 *
 *   /review                      staged, unstaged and untracked changes
 *   /review --uncommitted        the same
 *   /review --base <branch>      the current branch against <branch>
 *   /review --commit <sha>       one commit; `--title <text>` may follow
 *   /review <instructions>       a free-form review
 */
export type CodexReviewTarget =
  | { readonly type: "uncommittedChanges" }
  | { readonly type: "baseBranch"; readonly branch: string }
  | { readonly type: "commit"; readonly sha: string; readonly title?: string }
  | { readonly type: "custom"; readonly instructions: string };

const REVIEW_COMMAND = /^\/review(?:\s+([\s\S]*))?$/u;
const FLAG_VALUE = /^(\S+)(?:\s+([\s\S]*))?$/u;

/** The review a message asks for, or null when it is not a `/review` command. */
export function parseCodexReviewCommand(text: string): CodexReviewTarget | null {
  const match = REVIEW_COMMAND.exec(text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  if (argument === "" || argument === "--uncommitted") return { type: "uncommittedChanges" };
  if (argument.startsWith("--base ")) {
    const branch = FLAG_VALUE.exec(argument.slice("--base ".length).trim());
    if (branch !== null && branch[2] === undefined) {
      return { type: "baseBranch", branch: branch[1]! };
    }
  }
  if (argument.startsWith("--commit ")) {
    const commit = FLAG_VALUE.exec(argument.slice("--commit ".length).trim());
    if (commit !== null) {
      const rest = commit[2]?.trim();
      if (rest === undefined) return { type: "commit", sha: commit[1]! };
      if (rest.startsWith("--title ")) {
        const title = rest.slice("--title ".length).trim();
        return title === ""
          ? { type: "commit", sha: commit[1]! }
          : { type: "commit", sha: commit[1]!, title };
      }
    }
  }
  return { type: "custom", instructions: argument };
}

/** The `/review` text for a target; parsing it gives the target back. */
export function formatCodexReviewCommand(target: CodexReviewTarget): string {
  switch (target.type) {
    case "uncommittedChanges":
      return "/review";
    case "baseBranch":
      return `/review --base ${target.branch}`;
    case "commit":
      return target.title === undefined
        ? `/review --commit ${target.sha}`
        : `/review --commit ${target.sha} --title ${target.title}`;
    case "custom":
      return `/review ${target.instructions}`;
  }
}

/** A short label for what a review looks at, such as "commit 7a123a0". */
export function codexReviewTargetLabel(target: CodexReviewTarget): string {
  switch (target.type) {
    case "uncommittedChanges":
      return "uncommitted changes";
    case "baseBranch":
      return `changes against ${target.branch}`;
    case "commit":
      return `commit ${target.sha.slice(0, 7)}`;
    case "custom":
      return "custom review";
  }
}

/** The review a subagent runs, when it is a Codex child started with `/review`. */
export function subagentCodexReview(subagent: {
  readonly driver: string;
  readonly prompt: string;
}): CodexReviewTarget | null {
  return subagent.driver === "codex" ? parseCodexReviewCommand(subagent.prompt) : null;
}
