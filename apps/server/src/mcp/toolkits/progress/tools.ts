import {
  AGENT_PROGRESS_MAX_ID_LENGTH,
  AGENT_PROGRESS_MAX_ITEMS,
  AGENT_PROGRESS_MAX_LABEL_LENGTH,
  AGENT_PROGRESS_MAX_TITLE_LENGTH,
  NonNegativeInt,
  OrchestrationV2AgentProgressItemStatus,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ItemId = TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_PROGRESS_MAX_ID_LENGTH));

const ProgressUpdateTool = Tool.make("progress_update", {
  description: `Show the user a live progress bar for a list of work, such as 50 bugs to fix or 12 files to migrate. Use it for any list of about 5 or more items. Declare every item up front in one call with a title and stable ids, then mark each item running when you start it and done, failed, or skipped when it ends. Each call is applied in this order: clear, title, items, remove. Items merge by id: a new id is added at the end as pending unless you give a status, and an existing item keeps any field you leave out, so a call can send just {id, status}. Subagents you start with delegate_task can call this tool too, and their updates go to your tracker, the one on the orchestrating thread, not their own. Give each subagent the ids it owns and tell it to mark them. Because updates merge per item, concurrent and out-of-order calls from several agents are safe. A tracker holds at most ${AGENT_PROGRESS_MAX_ITEMS} items; a call that would exceed that fails and changes nothing. Pass clear: true when the work is abandoned or replaced; a finished tracker can stay.`,
  parameters: Schema.Struct({
    clear: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "Remove the existing tracker first. With title or items in the same call, starts a new one.",
      }),
    ),
    title: Schema.optional(
      TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_PROGRESS_MAX_TITLE_LENGTH)).annotate({
        description: `What the list is, ${AGENT_PROGRESS_MAX_TITLE_LENGTH} characters at most, e.g. "Fix flaky tests". Sets or renames the tracker.`,
      }),
    ),
    items: Schema.optional(
      Schema.Array(
        Schema.Struct({
          id: ItemId.annotate({
            description: `Stable id, ${AGENT_PROGRESS_MAX_ID_LENGTH} characters at most, such as an issue number or file path.`,
          }),
          label: Schema.optional(
            TrimmedString.check(Schema.isMaxLength(AGENT_PROGRESS_MAX_LABEL_LENGTH)).annotate({
              description: `Short text shown for the item, ${AGENT_PROGRESS_MAX_LABEL_LENGTH} characters at most. Defaults to the id.`,
            }),
          ),
          status: Schema.optional(
            OrchestrationV2AgentProgressItemStatus.annotate({
              description: "A new item without a status is pending.",
            }),
          ),
        }),
      )
        .check(Schema.isMaxLength(AGENT_PROGRESS_MAX_ITEMS))
        .annotate({ description: "Items to add or update, matched by id." }),
    ),
    remove: Schema.optional(
      Schema.Array(ItemId)
        .check(Schema.isMaxLength(AGENT_PROGRESS_MAX_ITEMS))
        .annotate({ description: "Ids to drop from the tracker." }),
    ),
  }),
  success: Schema.Struct({
    title: Schema.NullOr(Schema.String),
    total: NonNegativeInt,
    done: NonNegativeInt,
    failed: NonNegativeInt,
    skipped: NonNegativeInt,
    running: NonNegativeInt,
    pending: NonNegativeInt,
    threadId: ThreadId,
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Update progress")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ProgressToolkit = Toolkit.make(ProgressUpdateTool);
