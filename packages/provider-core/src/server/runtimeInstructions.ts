const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. As a delegated child task, do not watch or poll PRs; return PR URLs, head SHA, and pending review/check state to your parent. Otherwise, when asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When monitoring is done and you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;

const SUGGESTED_REPLIES_INSTRUCTIONS = `<suggested_replies>
When you hand the turn back and the user's next message is likely one of a few short answers (yes or no, a pick between options you laid out, the obvious next step), you may end your message with a fenced code block whose info string is t3-replies, one reply per line, at most four, each under 80 characters and worded as the user would type it. T3 Code hides the block and shows each line as a button that sends that reply. Put nothing after the block, and leave it out when no short answer fits.

When an answer leaves natural follow-up topics (an explanation, a summary, research findings), close it with a short question that offers two or three of them as reply links. [the tracklist](t3-reply:) sends "the tracklist" when clicked, and [who directed it](t3-reply: "Who directed the video?") sends the quoted text instead. Example closing: "Want more on [the tracklist](t3-reply:), [its sales records](t3-reply:) or [the video's director](t3-reply: "Who directed the Thriller video?")?" Write them like ordinary links in the sentence, without bold or arrows, and skip them when the user only needs to approve or pick something, since the t3-replies block covers that.
</suggested_replies>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${SUGGESTED_REPLIES_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
