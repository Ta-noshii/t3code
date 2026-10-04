import type {
  ChatAttachment,
  MessageId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

type Projection = OrchestrationV2ThreadProjection;
type Run = Projection["runs"][number];
type Message = Projection["messages"][number];
type ProviderSession = Projection["providerSessions"][number];

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["preparing", "starting", "running", "waiting"]);
const MERGE_BACK_RUN_STATUSES = new Set<Run["status"]>(["waiting", "completed"]);
const MERGE_BACK_BLOCKING_RUN_STATUSES = new Set<Run["status"]>([
  "preparing",
  "starting",
  "running",
]);

export interface QueuedThreadRun {
  readonly run: Run;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /** Editing replaces this message's content, so its id and context travel with the row. */
  readonly messageId: Message["id"];
  readonly context?: Message["context"];
}

export interface ThreadQueueWorkflowState {
  readonly activeRun: Run | null;
  readonly queuedRuns: ReadonlyArray<QueuedThreadRun>;
  readonly isHeld: boolean;
  readonly canReorder: boolean;
  readonly canPromoteToSteer: boolean;
}

export function resolveActiveThreadRun(projection: Pick<Projection, "runs">): Run | null {
  return projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
}

/**
 * A successfully finished provider turn remains in `waiting` while its
 * checkpoint is captured. Keep that newest turn available for merge-back
 * instead of falling through to an older fully checkpointed run.
 */
export function resolveLatestMergeBackRun(projection: Projection): Run | null {
  const latestProviderFinishedRun = projection.runs.reduce<Run | null>(
    (latest, run) =>
      MERGE_BACK_RUN_STATUSES.has(run.status) && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  if (latestProviderFinishedRun === null) return null;

  const hasNewerActiveRun = projection.runs.some(
    (run) =>
      run.ordinal > latestProviderFinishedRun.ordinal &&
      MERGE_BACK_BLOCKING_RUN_STATUSES.has(run.status),
  );
  return hasNewerActiveRun ? null : latestProviderFinishedRun;
}

function resolveThreadProviderSession(projection: Projection): ProviderSession | null {
  const activeRun = resolveActiveThreadRun(projection);
  const providerThreadId = activeRun?.providerThreadId ?? projection.thread.activeProviderThreadId;
  const activeProviderThread =
    providerThreadId === null
      ? null
      : (projection.providerThreads.find((thread) => thread.id === providerThreadId) ?? null);
  const attachedProviderThread =
    activeProviderThread ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    ) ??
    null;
  const sessionId = attachedProviderThread?.providerSessionId ?? null;
  if (sessionId !== null) {
    return projection.providerSessions.find((session) => session.id === sessionId) ?? null;
  }
  return (
    projection.providerSessions.findLast(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? null
  );
}

export function threadSupportsProviderHandoff(projection: Projection | null | undefined): boolean {
  if (projection == null) return false;
  const session = resolveThreadProviderSession(projection);
  if (session !== null) {
    return session.capabilities.sessions.supportsProviderSwitchingViaHandoff;
  }
  if (resolveActiveThreadRun(projection) !== null) return false;
  if (projection.thread.historyOrigin === "v1_import" || projection.runs.length === 0) return true;

  // Detaching a stopped session removes it from the projection, but its native
  // provider thread remains available for the next turn's portable handoff.
  return projection.providerThreads.some(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.appThreadId === projection.thread.id &&
      thread.providerInstanceId === projection.thread.modelSelection.instanceId &&
      thread.nativeThreadRef !== null,
  );
}

/** Automatic completion/notification runs are not messages in the user's queue. */
export function getUserQueuedThreadRuns(
  projection: Pick<Projection, "runs" | "messages">,
): ReadonlyArray<Run> {
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter(
        (message) =>
          message.delegatedCompletion !== undefined || message.notification !== undefined,
      )
      .map((message) => message.id),
  );
  return projection.runs.filter(
    (run) => run.status === "queued" && !automaticCompletionMessageIds.has(run.userMessageId),
  );
}

export function deriveThreadQueueWorkflowState(projection: Projection): ThreadQueueWorkflowState {
  const activeRun = resolveActiveThreadRun(projection);
  const session = resolveThreadProviderSession(projection);
  const capabilities = session?.capabilities.turns;
  const hasSteerableProviderTurn =
    activeRun?.status === "running" &&
    activeRun.activeAttemptId !== null &&
    projection.providerTurns.some(
      (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
    );
  const queuedRuns = copySorted(
    getUserQueuedThreadRuns(projection),
    (left, right) =>
      (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
      left.ordinal - right.ordinal,
  ).map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return {
      run,
      text: message?.text ?? "Queued message",
      attachments: message?.attachments ?? [],
      messageId: run.userMessageId,
      ...(message?.context ? { context: message.context } : {}),
    };
  });

  return {
    activeRun,
    queuedRuns,
    isHeld: projection.runs.some((run) => run.status === "queued" && run.queueHeld === true),
    canReorder: capabilities?.supportsQueuedMessages === true,
    canPromoteToSteer:
      hasSteerableProviderTurn &&
      (capabilities?.supportsActiveSteering === true ||
        capabilities?.supportsSteeringByInterruptRestart === true),
  };
}

export function canForkProjectedAssistantItem(input: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly capabilities?: OrchestrationV2ProviderCapabilities | undefined;
}): boolean {
  const item = input.projectedItem.item;
  if (item.type !== "assistant_message" || item.runId === null || item.status !== "completed") {
    return false;
  }
  return providerCanForkRun(input.capabilities);
}

/**
 * Whether a run of this provider can be forked, natively or by handing the new
 * thread a transcript of the conversation.
 */
export function providerCanForkRun(
  capabilities: OrchestrationV2ProviderCapabilities | undefined,
): boolean {
  if (capabilities === undefined) {
    // Historical and inherited rows may outlive their provider-session record.
    // Keep the portable server-side fallback available when capability evidence
    // is absent; a known incapable provider is rejected below.
    return true;
  }
  const canForkNatively =
    capabilities.threads.canForkThread &&
    capabilities.threads.canForkFromTurn &&
    capabilities.identity.nativeThreadIds === "strong";
  return canForkNatively || capabilities.context.supportsFullThreadHandoff;
}

type UserMessageItem = Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>;
type ConversationItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "user_message" | "assistant_message" }
>;

export type EditInNewThreadPlan =
  | {
      /** Fork the thread that ran `runId` at the end of that run. */
      readonly type: "fork";
      readonly sourceThreadId: ThreadId;
      readonly runId: RunId;
      readonly message: UserMessageItem;
    }
  | {
      /**
       * No run precedes the message: it is the first one, or everything before it was
       * imported from before runs existed. The new thread starts empty and carries
       * `earlierMessages` as a transcript.
       */
      readonly type: "fresh";
      readonly earlierMessages: ReadonlyArray<ConversationItem>;
      readonly message: UserMessageItem;
    }
  | {
      /** The run before the message is in history the client has not loaded yet. */
      readonly type: "history_not_loaded";
    };

/**
 * "Edit in new thread" on a user message: the new thread holds the conversation up to
 * just before that message, and the message goes back into its composer. The cut is the
 * end of the run that answered the previous message, which may belong to a parent thread
 * when the row is inherited. A steer shares its run with the prompt before it, so it
 * cannot be cut out on its own and returns null.
 */
export function planEditInNewThread(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  messageId: MessageId,
  options: { readonly hasEarlierHistory: boolean },
): EditInNewThreadPlan | null {
  const index = visibleTurnItems.findIndex(
    (row) => row.item.type === "user_message" && row.item.messageId === messageId,
  );
  const message = visibleTurnItems[index]?.item;
  if (message?.type !== "user_message") return null;
  if (message.inputIntent === "steer" || message.inputIntent === "promoted_queued_to_steer") {
    return null;
  }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const row = visibleTurnItems[cursor]!;
    if (row.item.runId !== null && row.item.runId !== message.runId) {
      return { type: "fork", sourceThreadId: row.sourceThreadId, runId: row.item.runId, message };
    }
  }
  if (options.hasEarlierHistory) return { type: "history_not_loaded" };
  return {
    type: "fresh",
    earlierMessages: visibleTurnItems
      .slice(0, index)
      .flatMap((row) =>
        row.item.type === "user_message" || row.item.type === "assistant_message" ? [row.item] : [],
      ),
    message,
  };
}

/**
 * Earlier messages as Markdown, attached to a new thread whose provider has no copy of
 * them. Context links collapse to their labels, since the transcript has no records.
 */
export function buildEarlierConversationTranscript(input: {
  readonly title: string;
  readonly messages: ReadonlyArray<ConversationItem>;
}): string {
  const sections = input.messages.flatMap((message) => {
    const text = replaceComposerContextReferences(
      message.text,
      (reference) => reference.label,
    ).trim();
    const attachments = (message.attachments ?? []).map((attachment) => attachment.name);
    const body = [text, attachments.length > 0 ? `(Attached: ${attachments.join(", ")})` : ""]
      .filter((part) => part.length > 0)
      .join("\n\n");
    if (body.length === 0) return [];
    return [`## ${message.type === "user_message" ? "User" : "Assistant"}\n\n${body}`];
  });
  return [
    "# Earlier conversation",
    `This thread continues "${input.title}". Below is the conversation before it, oldest first. Treat it as context you already have; the request to act on follows this file.`,
    ...sections,
  ].join("\n\n");
}

export function canDetachThreadProviderSession(projection: Projection): boolean {
  const session = resolveThreadProviderSession(projection);
  return session !== null && session.status !== "stopped" && session.status !== "error";
}
