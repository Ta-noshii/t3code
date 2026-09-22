import {
  CommandId,
  MessageId,
  OrchestrationForkThreadError,
  type OrchestrationForkThreadInput,
  type OrchestrationForkThreadResult,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const forkError = (message: string, cause?: unknown) =>
  new OrchestrationForkThreadError({ message, ...(cause !== undefined ? { cause } : {}) });

/**
 * Provider turns that begin at or after `cut`. Every user message opens a turn except a
 * steer, which lands inside the running turn: replies on both sides of it share a turn id.
 */
export function countProviderTurnsFrom(
  messages: ReadonlyArray<OrchestrationMessage>,
  cut: number,
): number {
  const replyTurnId = (from: number, step: 1 | -1) => {
    for (let index = from; index >= 0 && index < messages.length; index += step) {
      const message = messages[index]!;
      if (message.role === "user") return null;
      if (message.role === "assistant") return message.turnId;
    }
    return null;
  };
  let turns = 0;
  for (let index = cut; index < messages.length; index += 1) {
    if (messages[index]!.role !== "user") continue;
    const before = replyTurnId(index - 1, -1);
    const steer = before !== null && before === replyTurnId(index + 1, 1);
    if (!steer) turns += 1;
  }
  return turns;
}

/**
 * Forks a thread the way an agent session import lands: the provider copy is bound
 * before the thread exists, then the thread is created with the retained messages as
 * imported history. The target resumes the provider copy on its first turn, so the
 * source thread and its files are never touched.
 */
export const forkThread = Effect.fn("forkThread")(function* (input: OrchestrationForkThreadInput) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const crypto = yield* Crypto.Crypto;
  const newCommandId = crypto.randomUUIDv4.pipe(Effect.map(CommandId.make), Effect.orDie);

  const source = yield* snapshots
    .getThreadDetailById(input.sourceThreadId, { activityKinds: [] })
    .pipe(
      Effect.mapError((cause) => forkError("Failed to read the thread to fork.", cause)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(forkError("The thread to fork no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );
  if (source.deletedAt !== null) {
    return yield* forkError("The thread to fork was deleted.");
  }
  if (source.session?.status === "running" || source.session?.status === "starting") {
    return yield* forkError("Wait for the current turn to finish before forking.");
  }
  const cut =
    input.beforeMessageId === null
      ? source.messages.length
      : source.messages.findIndex((message) => message.id === input.beforeMessageId);
  if (cut < 0) {
    return yield* forkError("The message to fork from is no longer in the thread.");
  }

  const retained = source.messages.slice(0, cut).flatMap((message) => {
    if (message.streaming || (message.role !== "user" && message.role !== "assistant")) return [];
    // Imported history carries no context records, so links collapse to their labels.
    const text = replaceComposerContextReferences(message.text, (occurrence) => occurrence.label);
    const body =
      text.trim().length > 0 ? text : (message.attachments?.length ?? 0) > 0 ? "[attachments]" : "";
    return body.length > 0
      ? [{ role: message.role, text: body, createdAt: message.createdAt }]
      : [];
  });
  const droppedTurns = countProviderTurnsFrom(source.messages, cut);

  const nativeHistory =
    retained.length > 0 &&
    (yield* providerService
      .forkConversation({
        sourceThreadId: source.id,
        targetThreadId: input.threadId,
        numTurns: droppedTurns,
        firstDroppedPrompt: source.messages[cut]?.text,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not fork the provider conversation", {
            threadId: source.id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      ));

  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* engine
    .dispatch({
      type: "thread.create",
      commandId: yield* newCommandId,
      threadId: input.threadId,
      projectId: source.projectId,
      title: input.title,
      modelSelection: source.modelSelection,
      runtimeMode: source.runtimeMode,
      interactionMode: source.interactionMode,
      branch: source.branch,
      worktreePath: source.worktreePath,
      createdAt,
      historyImport: true,
    })
    .pipe(Effect.mapError((cause) => forkError("Failed to create the forked thread.", cause)));

  if (retained.length > 0) {
    yield* engine
      .dispatch({
        type: "thread.history.import",
        commandId: yield* newCommandId,
        threadId: input.threadId,
        messages: retained.map((message, index) => ({
          messageId: MessageId.make(`fork:${input.threadId}:${String(index).padStart(6, "0")}`),
          ...message,
        })),
      })
      .pipe(Effect.mapError((cause) => forkError("Failed to copy the conversation.", cause)));
    // History import settles the thread; a fork is work the user is about to continue.
    yield* engine
      .dispatch({
        type: "thread.unsettle",
        commandId: yield* newCommandId,
        threadId: input.threadId,
        reason: "user",
      })
      .pipe(Effect.ignore);
  }

  return { threadId: input.threadId, nativeHistory } satisfies OrchestrationForkThreadResult;
});
