import * as NodeZlib from "node:zlib";

import {
  CommandId,
  MessageId,
  OrchestrationTransferThreadError,
  type OrchestrationExportThreadInput,
  type OrchestrationExportThreadResult,
  type OrchestrationImportThreadInput,
  type OrchestrationImportThreadResult,
  type OrchestrationTransferConversation,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

// Keeps a single RPC frame well inside what the relay carries. Larger provider sessions
// travel as visible history only, and the client hands the agent the transcript.
const MAX_CONVERSATION_BYTES = 48 * 1024 * 1024;

const transferError = (message: string, cause?: unknown) =>
  new OrchestrationTransferThreadError({ message, ...(cause !== undefined ? { cause } : {}) });

export function encodeTransferData(data: unknown): string {
  return NodeZlib.gzipSync(Buffer.from(JSON.stringify(data), "utf8")).toString("base64");
}

export function decodeTransferData(data: string): unknown {
  return JSON.parse(NodeZlib.gunzipSync(Buffer.from(data, "base64")).toString("utf8"));
}

/** Reads a thread and its provider conversation for cloning onto another environment. */
export const exportThread = Effect.fn("exportThread")(function* (
  input: OrchestrationExportThreadInput,
) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const thread = yield* snapshots.getThreadDetailById(input.threadId, { activityKinds: [] }).pipe(
    Effect.mapError((cause) => transferError("Failed to read the thread.", cause)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(transferError("The thread no longer exists.")),
        onSome: Effect.succeed,
      }),
    ),
  );
  if (thread.deletedAt !== null) {
    return yield* transferError("The thread was deleted.");
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return yield* transferError("Wait for the current turn to finish before cloning.");
  }

  const messages = thread.messages.flatMap((message) => {
    if (message.streaming || (message.role !== "user" && message.role !== "assistant")) return [];
    // Context records stay on this machine, so links collapse to their labels.
    const text = replaceComposerContextReferences(message.text, (occurrence) => occurrence.label);
    const body =
      text.trim().length > 0 ? text : (message.attachments?.length ?? 0) > 0 ? "[attachments]" : "";
    return body.length > 0
      ? [{ role: message.role, text: body, createdAt: message.createdAt }]
      : [];
  });

  const conversation: OrchestrationTransferConversation | null =
    messages.length === 0
      ? null
      : yield* providerService.exportConversation({ threadId: thread.id }).pipe(
          Effect.map((exported) => {
            if (!exported) return null;
            const data = encodeTransferData(exported.data);
            if (data.length > MAX_CONVERSATION_BYTES) return null;
            return { driver: exported.driver, format: exported.format, data };
          }),
          Effect.catch((cause) =>
            Effect.logWarning("Could not export the provider conversation", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );

  return {
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    messages,
    conversation,
  } satisfies OrchestrationExportThreadResult;
});

/**
 * Lands another environment's export the way a fork does: the provider copy is bound
 * before the thread exists, then the thread is created with the messages as imported
 * history. The clone starts in the project root, since the source's worktree only exists
 * on the source machine.
 */
export const importThread = Effect.fn("importThread")(function* (
  input: OrchestrationImportThreadInput,
) {
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const crypto = yield* Crypto.Crypto;
  const newCommandId = crypto.randomUUIDv4.pipe(Effect.map(CommandId.make), Effect.orDie);

  const project = yield* snapshots.getProjectShellById(input.projectId).pipe(
    Effect.mapError((cause) => transferError("Failed to read the project.", cause)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(transferError("The project is not on this environment.")),
        onSome: Effect.succeed,
      }),
    ),
  );

  const conversation = input.conversation;
  const nativeHistory =
    input.messages.length > 0 &&
    conversation !== null &&
    (yield* Effect.try({
      try: () => decodeTransferData(conversation.data),
      catch: (cause) => transferError("The provider conversation is unreadable.", cause),
    }).pipe(
      Effect.flatMap((data) =>
        providerService.importConversation({
          threadId: input.threadId,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          cwd: project.workspaceRoot,
          conversation: { driver: conversation.driver, format: conversation.format, data },
        }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Could not import the provider conversation", {
          threadId: input.threadId,
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
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: null,
      worktreePath: null,
      createdAt,
      historyImport: true,
    })
    .pipe(Effect.mapError((cause) => transferError("Failed to create the thread.", cause)));

  if (input.messages.length > 0) {
    yield* engine
      .dispatch({
        type: "thread.history.import",
        commandId: yield* newCommandId,
        threadId: input.threadId,
        messages: input.messages.map((message, index) => ({
          messageId: MessageId.make(`clone:${input.threadId}:${String(index).padStart(6, "0")}`),
          ...message,
        })),
      })
      .pipe(Effect.mapError((cause) => transferError("Failed to copy the conversation.", cause)));
    // History import settles the thread; a clone is work the user is about to continue.
    yield* engine
      .dispatch({
        type: "thread.unsettle",
        commandId: yield* newCommandId,
        threadId: input.threadId,
        reason: "user",
      })
      .pipe(Effect.ignore);
  }

  return { threadId: input.threadId, nativeHistory } satisfies OrchestrationImportThreadResult;
});
