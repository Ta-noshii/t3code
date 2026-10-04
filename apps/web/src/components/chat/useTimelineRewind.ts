import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildEarlierConversationTranscript,
  planEditInNewThread,
} from "@t3tools/client-runtime/state/thread-workflows";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { readLocalApi } from "../../localApi";
import { findRevertCheckpoint } from "../../session-logic";
import { type ChatMessage } from "../../types";
import { newThreadId } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useComposerDraftStore } from "../../composerDraftStore";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { readPreparedConnection } from "../../state/session";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { toastManager } from "../ui/toast";
import { recallableComposerPrompt } from "./composerPromptHistory";
import { waitForThreadShell } from "../../state/entities";
import { openRevertConfirm } from "./ChatOverlayHosts";
import { assetEnvironment } from "../../state/assets";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { addRestoredComposerAttachments, rewindToMessage } from "./chatViewSend";
import { makeThreadErrorSetter, prepareRevertedMessageAttachments } from "../ChatView.logic";
interface TimelineRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly serverProjection: ThreadStructure | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly paintOnlyDisplayedTimeline: boolean;
  readonly phase: SessionPhase;
  readonly isConnecting: boolean;
  readonly isSendBusy: boolean;
  readonly isRevertingCheckpoint: boolean;
  readonly supportsConversationRollback: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Going back in a thread's timeline: reverting to an earlier turn (restoring that message into
 * the composer), rolling back a provider checkpoint, forking a new thread from a run, and
 * editing a message in a new thread forked from just before it.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    serverProjection,
    activeThread,
    timelineMessages,
    paintOnlyDisplayedTimeline,
    phase,
    isConnecting,
    isSendBusy,
    isRevertingCheckpoint,
    supportsConversationRollback,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  } = input;
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const revertThreadCheckpoint = useOrchestrationCommand(threadEnvironment.revertCheckpoint, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });

  const onRevertToTurnCount = async (
    turnCount: number,
    messageId: MessageId,
    restoreFiles?: boolean,
  ) => {
    const localApi = readLocalApi();
    if (
      !localApi ||
      !activeThread ||
      isRevertingCheckpoint ||
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    )
      return;
    const message = timelineMessages.find((message) => message.id === messageId);
    if (!message || message.role !== "user") return;

    if (!supportsConversationRollback) {
      setThreadError(
        activeThread.id,
        "This provider does not support reverting conversation history. Start a new thread instead.",
      );
      return;
    }
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    if (restoreFiles === undefined) {
      openRevertConfirm(routeThreadKey, { turnCount, messageId });
      return;
    }

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const rewind = await rewindToMessage({
      message,
      environmentId,
      routeThreadRef,
      threadId: activeThread.id,
      turnCount,
      restoreFiles,
      // Keep the live checkpoint identity when command context refetches a bounded window.
      checkpoint: findRevertCheckpoint(serverProjection?.checkpoints ?? [], turnCount),
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      revertThreadCheckpoint,
    });
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    if (rewind.error !== null) {
      setThreadError(activeThread.id, rewind.error);
      return;
    }
    if (currentRouteThreadKeyRef.current === routeThreadKey) {
      const nextPrompt = rewind.prompt;
      promptRef.current = nextPrompt;
      composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
      requestAnimationFrame(() => {
        if (currentRouteThreadKeyRef.current === routeThreadKey) composerRef.current?.focusAtEnd();
      });
    }
  };
  const onRevertToTurnCountStable = useStableCallback(onRevertToTurnCount);
  const onConfirmRevert = (turnCount: number, messageId: MessageId, restoreFiles: boolean) => {
    void onRevertToTurnCount(turnCount, messageId, restoreFiles);
  };
  const onConfirmRevertStable = useStableCallback(onConfirmRevert);

  const onRollbackCheckpoint = async (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!activeThread || isRevertingCheckpoint) return;
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before reverting checkpoints.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
      return;
    }
    const localApi = readLocalApi();
    const confirmed =
      localApi == null
        ? window.confirm("Roll back this thread to the selected checkpoint?")
        : await localApi.dialogs.confirm(
            "Roll back this thread to the selected checkpoint?\nThis action cannot be undone.",
          );
    if (!confirmed) return;

    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(activeThread.id, null);
    const result = await revertThreadCheckpoint({
      environmentId,
      input: {
        threadId: activeThread.id,
        checkpointId: input.checkpointId,
        scopeId: input.scopeId,
      },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to revert thread state.",
      );
    }
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
  };

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);

  const onEditInNewThread = async (messageId: MessageId) => {
    if (!activeThread) return;
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      setThreadError(
        activeThread.id,
        `Reconnect ${activeEnvironmentUnavailableLabel} before editing in a new thread.`,
      );
      return;
    }
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Interrupt the current turn before editing in a new thread.");
      return;
    }
    // Read at click time: the full rows carry assistant text the transcript needs, and
    // subscribing to them would re-render the hook on every streamed token.
    const plan = planEditInNewThread(
      appAtomRegistry.get(environmentThreadDetails.visibleTurnItemsAtom(routeThreadRef)),
      messageId,
      {
        hasEarlierHistory: appAtomRegistry.get(environmentThreadDetails.historyAtom(routeThreadRef))
          .hasMoreHistory,
      },
    );
    if (!plan) return;
    if (plan.type === "history_not_loaded") {
      setThreadError(
        activeThread.id,
        "Load the earlier messages at the top of this thread, then edit this message again.",
      );
      return;
    }
    setThreadError(activeThread.id, null);
    try {
      const connection = readPreparedConnection(environmentId);
      if (!connection) throw new Error("The environment is not connected.");
      const files = await prepareRevertedMessageAttachments({
        message: plan.message,
        environmentId,
        httpBaseUrl: connection.httpBaseUrl,
        createAssetUrl: createAttachmentAssetUrl,
      });
      let target: ComposerThreadTarget;
      let targetThreadRef: ScopedThreadRef | null = null;
      let prompt = recallableComposerPrompt(plan.message.text);
      const transcriptFiles: File[] = [];
      if (plan.type === "fork") {
        const targetThreadId = newThreadId();
        targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
        const result = await forkThreadFromRun({
          environmentId,
          input: {
            sourceThreadId: plan.sourceThreadId,
            targetThreadId,
            runId: plan.runId,
            title: `${activeThread.title} fork`,
          },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) return;
          throw squashAtomCommandFailure(result);
        }
        if (!(await waitForThreadShell(targetThreadRef))) {
          throw new Error(
            "The new thread was created, but its data did not reach this client. Reconnect and open it from the sidebar.",
          );
        }
        target = targetThreadRef;
      } else {
        // Nothing before the message ran in T3 (it is the first message, or the
        // earlier history was imported), so there is no run to fork. The new thread
        // starts in the same workspace and carries the earlier messages itself.
        const draft = await handleNewThread(
          scopeProjectRef(activeThread.environmentId, activeThread.projectId),
          {
            branch: activeThread.branch,
            worktreePath: activeThread.worktreePath,
            envMode: activeThread.worktreePath ? "worktree" : "local",
            startFromOrigin: false,
          },
        );
        if (!draft) throw new Error("Could not start a new thread.");
        target = draft.draftId;
        if (plan.earlierMessages.length > 0) {
          const transcript = buildEarlierConversationTranscript({
            title: activeThread.title,
            messages: plan.earlierMessages,
          });
          const canAttachFiles =
            appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
              .capabilities.fileAttachments !== undefined;
          if (canAttachFiles) {
            transcriptFiles.push(
              new File([transcript], "earlier-conversation.md", { type: "text/markdown" }),
            );
          } else {
            prompt = prompt.length > 0 ? `${transcript}\n\n---\n\n${prompt}` : transcript;
          }
          toastManager.add({
            type: "info",
            title: "Earlier messages go with your next message",
            description: canAttachFiles
              ? `The ${plan.earlierMessages.length} earlier messages are attached as earlier-conversation.md.`
              : `The ${plan.earlierMessages.length} earlier messages were added to the prompt.`,
          });
        }
      }
      useComposerDraftStore.getState().setPrompt(target, prompt);
      addRestoredComposerAttachments(target, transcriptFiles, undefined);
      addRestoredComposerAttachments(target, files, plan.message.attachments);
      if (targetThreadRef) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(targetThreadRef),
        });
      }
    } catch (error) {
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to edit in a new thread.",
      );
    }
  };
  const onEditInNewThreadStable = useStableCallback(onEditInNewThread);
  const onTimelineRollbackCheckpoint = (input: {
    readonly checkpointId: string;
    readonly scopeId: string;
  }) => {
    if (!paintOnlyDisplayedTimeline) void onRollbackCheckpoint(input);
  };
  const onTimelineRollbackCheckpointStable = useStableCallback(onTimelineRollbackCheckpoint);
  const onRevertTimelineTurn = (targetTurnCount: number, messageId: MessageId) => {
    void onRevertToTurnCountStable(targetTurnCount, messageId);
  };
  const onRevertTimelineTurnStable = useStableCallback(onRevertTimelineTurn);
  return {
    onConfirmRevertStable,
    onForkFromRunStable,
    onEditInNewThreadStable,
    onRevertTimelineTurnStable,
    onTimelineRollbackCheckpointStable,
  };
}
