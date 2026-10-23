import {
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import {
  agentProgressFinished,
  agentProgressPending,
  isAgentProgressComplete,
} from "@t3tools/shared/agentProgress";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { dispatchFailure, newCommandId, unavailable } from "../../threadAccess.ts";
import { ProgressToolkit } from "./tools.ts";

// Lineage is immutable and delegation chains are short; the cap only guards a corrupt cycle.
const MAX_OWNER_HOPS = 32;

/**
 * The tracker belongs to the topmost thread reached through subagent links, so
 * every delegate_task child reports to the orchestrator the user is watching.
 * A fork is its own conversation and keeps its own tracker.
 */
const resolveTrackerOwner = Effect.fn("mcp.progress.resolveTrackerOwner")(function* (
  callerThreadId: ThreadId,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shellOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
  const caller = yield* shellOf(callerThreadId);
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  let owner: OrchestrationV2ThreadShell = caller;
  for (let hop = 0; hop < MAX_OWNER_HOPS; hop += 1) {
    const parentId: ThreadId | null =
      owner.lineage.relationshipToParent === "subagent" ? owner.lineage.parentThreadId : null;
    if (parentId === null) break;
    const parent: OrchestrationV2ThreadShell | null = yield* shellOf(parentId);
    if (parent === null || parent.deletedAt !== null) break;
    owner = parent;
  }
  return owner.id;
});

export const layer = McpToolAccess.toLayer(ProgressToolkit, {
  // The caller must be a live thread; the owner is then found by lineage alone.
  // writesThreads would hold the parent to the caller's runtime mode, which a
  // delegated child at a lower mode would fail.
  progress_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "progress_update");
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const ownerId = yield* resolveTrackerOwner(thread.threadId);
      yield* threads
        .dispatch({
          type: "thread.progress.update",
          commandId: yield* newCommandId(),
          threadId: ownerId,
          update: input,
        })
        .pipe(Effect.mapError(dispatchFailure));
      const progress = (yield* threads.getThreadShell(ownerId).pipe(Effect.mapError(unavailable)))
        ?.progressSummary;
      const owner = ownerId === thread.threadId ? "" : " on the orchestrating thread";
      if (progress == null) {
        return {
          title: null,
          total: 0,
          done: 0,
          failed: 0,
          skipped: 0,
          running: 0,
          pending: 0,
          threadId: ownerId,
          message: `No progress tracker${owner}.`,
        };
      }
      const failed = progress.failed > 0 ? `, ${progress.failed} failed` : "";
      return {
        title: progress.title,
        total: progress.total,
        done: progress.done,
        failed: progress.failed,
        skipped: progress.skipped,
        running: progress.running,
        pending: agentProgressPending(progress),
        threadId: ownerId,
        message: isAgentProgressComplete(progress)
          ? `All finished, ${progress.total}/${progress.total}${failed}${owner}.`
          : `${agentProgressFinished(progress)}/${progress.total} finished${failed}, ${progress.running} running${owner}.`,
      };
    }),
  ),
});
