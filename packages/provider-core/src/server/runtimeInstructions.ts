const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: one link_pull_request per PR, full URL, every stack layer, as your next call. Host tools do not link for you. If linking fails, say so. Skip PRs you only read or review, and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. Never wait with sleep, loops, gh --watch, Monitor, or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch.
</pull_request_linking>`;

const SUGGESTED_REPLIES_INSTRUCTIONS = `<suggested_replies>
When you hand the turn back and the user's next message is likely one of a few short answers (yes or no, a pick between options you laid out, the obvious next step), you may end your message with a fenced code block whose info string is t3-replies, one reply per line, at most four, each under 80 characters and worded as the user would type it. T3 Code hides the block and shows each line as a button that sends that reply. Put nothing after the block, and leave it out when no short answer fits.
</suggested_replies>`;

/** Omit model and effort when the harness manages them dynamically. */
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
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio in your response using Markdown image syntax with absolute file paths. Link any other file you produce using its absolute path so the user can open it in T3 Code's files viewer.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${SUGGESTED_REPLIES_INSTRUCTIONS}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
