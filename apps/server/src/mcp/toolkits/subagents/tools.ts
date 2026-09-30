import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../../../provider/Services/ProviderRegistry.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ProviderRegistry.ProviderRegistry,
];

/** Longest a single call waits before returning `running`. */
export const MAX_SUBAGENT_WAIT_SECONDS = 1800;
export const DEFAULT_SUBAGENT_WAIT_SECONDS = 600;

const WaitSeconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MAX_SUBAGENT_WAIT_SECONDS),
).annotate({
  description: `Seconds to wait for the subagent's turn to end before returning with status "running" (0 returns at once; default ${DEFAULT_SUBAGENT_WAIT_SECONDS}, max ${MAX_SUBAGENT_WAIT_SECONDS}). If your MCP client times out tool calls sooner, pass less and call wait_for_subagent again.`,
});

const SubagentThreadIdInput = TrimmedNonEmptyString.annotate({
  description: "The subagent's threadId, as returned by start_subagent.",
});

export class SubagentModelNotFoundError extends Schema.TaggedError<SubagentModelNotFoundError>()(
  "SubagentModelNotFoundError",
  { requested: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `No usable provider model matches "${this.requested}". ${this.detail} Call list_subagent_models to see what is available.`;
  }
}

export class SubagentThreadNotFoundError extends Schema.TaggedError<SubagentThreadNotFoundError>()(
  "SubagentThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread ${this.threadId} is not a subagent of this thread.`;
  }
}

export class SubagentNestingError extends Schema.TaggedError<SubagentNestingError>()(
  "SubagentNestingError",
  {},
) {
  override get message(): string {
    return "A subagent cannot start subagents of its own. Do the work yourself or report back to the thread that started you.";
  }
}

export class SubagentBusyError extends Schema.TaggedError<SubagentBusyError>()(
  "SubagentBusyError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Subagent ${this.threadId} is still working on its last message. Call wait_for_subagent first, or stop_subagent.`;
  }
}

export class SubagentOperationFailedError extends Schema.TaggedError<SubagentOperationFailedError>()(
  "SubagentOperationFailedError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation}.`;
  }
}

export const SubagentToolError = Schema.Union([
  McpCapabilityUnavailableError,
  SubagentModelNotFoundError,
  SubagentThreadNotFoundError,
  SubagentNestingError,
  SubagentBusyError,
  SubagentOperationFailedError,
]);
export type SubagentToolError = typeof SubagentToolError.Type;

export const SubagentStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
  "needs_user",
]);
export type SubagentStatus = typeof SubagentStatus.Type;

export const SubagentResult = Schema.Struct({
  threadId: Schema.String,
  title: Schema.String,
  provider: Schema.String.annotate({ description: "Provider instance the subagent runs on." }),
  model: Schema.String,
  status: SubagentStatus.annotate({
    description:
      "running: still working, call wait_for_subagent. completed: reply holds its answer. needs_user: it is waiting on an approval or question that only the user can answer in its thread. interrupted or error: the turn stopped early; error says why.",
  }),
  reply: Schema.NullOr(Schema.String).annotate({
    description: "The subagent's final message for its latest turn, once that turn has ended.",
  }),
  error: Schema.NullOr(Schema.String),
});
export type SubagentResult = typeof SubagentResult.Type;

export const SubagentModelEntry = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  aliases: Schema.Array(Schema.String),
  isDefault: Schema.Boolean,
});

export const SubagentProviderEntry = Schema.Struct({
  provider: Schema.String.annotate({ description: "Pass this as start_subagent's provider." }),
  driver: Schema.String,
  displayName: Schema.String,
  models: Schema.Array(SubagentModelEntry),
});

export const ListSubagentModelsResult = Schema.Struct({
  providers: Schema.Array(SubagentProviderEntry),
});
export type ListSubagentModelsResult = typeof ListSubagentModelsResult.Type;

const ListSubagentModelsTool = Tool.make("list_subagent_models", {
  description:
    "List the providers and models a subagent can run on: every provider T3 Code has installed, enabled and signed in, such as Claude, Codex, Cursor, Grok or OpenCode.",
  success: ListSubagentModelsResult,
  failure: SubagentToolError,
  dependencies,
})
  .annotate(Tool.Title, "List subagent models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StartSubagentTool = Tool.make("start_subagent", {
  description: [
    'Hand a task to an agent on any provider T3 Code runs, not only your own: for example a Codex model from a Claude thread. The subagent gets its own T3 Code thread in this project, titled "Subagent · …", where the user can watch it. The call waits for its turn to end and returns its final message; continue the conversation with message_subagent.',
    "What to know before using it:",
    "- It sees none of your conversation. The prompt must carry every file path, decision and constraint it needs.",
    "- It works on your checkout and branch. Its edits land in your working tree, so don't edit the same files while it runs, and review its changes before building on them.",
    "- You get back only its last message. Ask it to put its whole answer, with file paths and findings, in that final message.",
    '- Approvals and questions it raises go to the user in its thread; you see status "needs_user" until they answer.',
    "- It runs on the user's own account for that provider and counts against its limits.",
    "- It cannot start subagents of its own.",
    "- To run several at once, start each with waitSeconds 0, then call wait_for_subagent on each.",
  ].join("\n"),
  parameters: Schema.Struct({
    prompt: TrimmedNonEmptyString.annotate({
      description: "The complete task. The subagent starts with no other context.",
    }),
    model: TrimmedNonEmptyString.annotate({
      description:
        'Model slug, name or alias, for example "gpt-6-luna" or "luna". A unique partial match works. See list_subagent_models.',
    }),
    provider: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          'Provider instance, driver or display name, for example "codex". Needed only when several providers offer a matching model.',
      }),
    ),
    title: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Short label for the subagent's thread. Defaults to the start of the prompt.",
      }),
    ),
    waitSeconds: Schema.optional(WaitSeconds),
  }),
  success: SubagentResult,
  failure: SubagentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Start subagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const MessageSubagentTool = Tool.make("message_subagent", {
  description:
    "Send a follow-up message to a subagent you started, in its existing conversation, and wait for its reply. The subagent must have finished its previous turn.",
  parameters: Schema.Struct({
    threadId: SubagentThreadIdInput,
    prompt: TrimmedNonEmptyString,
    waitSeconds: Schema.optional(WaitSeconds),
  }),
  success: SubagentResult,
  failure: SubagentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Message subagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const WaitForSubagentTool = Tool.make("wait_for_subagent", {
  description:
    'Wait for a subagent\'s current turn to end and return its reply. Returns at once when it has already finished. Use it after a call returned status "running".',
  parameters: Schema.Struct({
    threadId: SubagentThreadIdInput,
    waitSeconds: Schema.optional(WaitSeconds),
  }),
  success: SubagentResult,
  failure: SubagentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Wait for subagent")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StopSubagentTool = Tool.make("stop_subagent", {
  description:
    "Interrupt a subagent's running turn. Its thread stays, so you can message it again.",
  parameters: Schema.Struct({ threadId: SubagentThreadIdInput }),
  success: SubagentResult,
  failure: SubagentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop subagent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const SubagentsToolkit = Toolkit.make(
  ListSubagentModelsTool,
  StartSubagentTool,
  MessageSubagentTool,
  WaitForSubagentTool,
  StopSubagentTool,
);
