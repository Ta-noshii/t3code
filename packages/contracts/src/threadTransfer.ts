import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/**
 * Copying a thread to another environment. The source exports the visible
 * conversation and, when its provider can, the provider's own session. The
 * target imports both into a new thread. Servers advertise the pair with the
 * `threadTransfer` environment capability.
 */
export const THREAD_TRANSFER_WS_METHODS = {
  exportThread: "orchestration.exportThread",
  importThread: "orchestration.importThread",
} as const;

/** One visible message carried between environments. */
export const ThreadTransferMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type ThreadTransferMessage = typeof ThreadTransferMessage.Type;

/**
 * A provider's own conversation state, so the agent on the other machine
 * resumes with its full context instead of a transcript. `data` is opaque to
 * everything but the provider driver named by `driver`.
 */
export const ThreadTransferConversation = Schema.Struct({
  driver: TrimmedNonEmptyString,
  format: TrimmedNonEmptyString,
  /** Gzipped JSON, base64 encoded. */
  data: Schema.String,
});
export type ThreadTransferConversation = typeof ThreadTransferConversation.Type;

export const ThreadTransferExportInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadTransferExportInput = typeof ThreadTransferExportInput.Type;

export const ThreadTransferExportResult = Schema.Struct({
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  messages: Schema.Array(ThreadTransferMessage),
  /** Null when the provider has no session it can export. */
  conversation: Schema.NullOr(ThreadTransferConversation),
});
export type ThreadTransferExportResult = typeof ThreadTransferExportResult.Type;

export const ThreadTransferImportInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  messages: Schema.Array(ThreadTransferMessage),
  conversation: Schema.NullOr(ThreadTransferConversation),
});
export type ThreadTransferImportInput = typeof ThreadTransferImportInput.Type;

export const ThreadTransferImportResult = Schema.Struct({
  threadId: ThreadId,
  /**
   * The provider session came along, so the agent remembers the conversation.
   * When false the thread holds the messages as imported history, and the
   * first turn hands them to the agent as context.
   */
  nativeHistory: Schema.Boolean,
});
export type ThreadTransferImportResult = typeof ThreadTransferImportResult.Type;

export class ThreadTransferError extends Schema.TaggedError<ThreadTransferError>()(
  "ThreadTransferError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
