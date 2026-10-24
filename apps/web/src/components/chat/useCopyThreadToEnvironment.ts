import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ServerProvider,
  type ThreadTransferExportResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { requestConfirmDialog } from "../../confirmDialog";
import { useStableCallback } from "../../hooks/useStableCallback";
import { newMessageId, newThreadId } from "~/lib/utils";
import { waitForThreadShell } from "../../state/entities";
import type { useEnvironments } from "../../state/environments";
import { threadExportCommand, threadImportCommand } from "../../state/threadTransfer";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { ChatMessage, SessionPhase } from "../../types";
import type { CopyTargetOption } from "../BranchToolbar.logic";
import type { makeThreadErrorSetter } from "../ChatView.logic";
import {
  buildCopyHandoffMessage,
  buildCopySummaryPrompt,
  chatCopyMessages,
  resolveCopyModelSelection,
} from "../chatCopy.logic";
import { toastManager } from "../ui/toast";

type Environment = ReturnType<typeof useEnvironments>["environments"][number];

interface CopyThreadToEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly environmentById: ReadonlyMap<EnvironmentId, Environment>;
  readonly providersByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly serverConfig: EnvironmentServerConfig | null;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly isConnecting: boolean;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

/**
 * Copies a started chat into a project on another environment. The target gets the
 * provider session when both sides support thread transfer, and otherwise the
 * conversation as history the agent reads on its first turn.
 */
export function useCopyThreadToEnvironment(input: CopyThreadToEnvironmentInput) {
  const {
    environmentId,
    environmentById,
    providersByEnvironment,
    activeThread,
    serverConfig,
    timelineMessages,
    phase,
    isSendBusy,
    isConnecting,
    setThreadError,
  } = input;
  const navigate = useNavigate();
  const exportThreadFromServer = useAtomCommand(threadExportCommand, { reportFailure: false });
  const importThreadOnServer = useAtomCommand(threadImportCommand, { reportFailure: false });
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const [isCopyingThread, setIsCopyingThread] = useState(false);

  const onCopyToEnvironment = async (target: CopyTargetOption) => {
    const targetEnvironmentId = target.environmentId;
    if (!activeThread || isCopyingThread || targetEnvironmentId === environmentId) return;
    const targetEnvironment = environmentById.get(targetEnvironmentId);
    if (!targetEnvironment) return;
    const targetLabel = `${target.environmentLabel} (${target.projectLabel})`;
    const sourceLabel = environmentById.get(environmentId)?.label ?? "another machine";
    if (phase === "running" || isSendBusy || isConnecting) {
      setThreadError(activeThread.id, "Stop the current turn before copying this chat.");
      return;
    }
    const targetConfig = targetEnvironment.serverConfig;
    if (targetEnvironment.connection.phase !== "connected" || !targetConfig) {
      setThreadError(
        activeThread.id,
        `Connect ${target.environmentLabel} before copying this chat to it.`,
      );
      return;
    }
    const confirmed =
      (await requestConfirmDialog(
        [
          `Copy this chat to ${targetLabel}?`,
          `A new chat opens on ${target.environmentLabel} with this conversation in it and continues from where you are. It works in the "${target.projectLabel}" project's main folder${activeThread.worktreePath ? ", not this chat's worktree" : ""}. This chat stays here unchanged.`,
        ].join("\n"),
      )) ?? true;
    if (!confirmed) return;

    setIsCopyingThread(true);
    setThreadError(activeThread.id, null);
    try {
      // Instance ids are per machine; the copy needs the same kind of provider there.
      const modelSelection = resolveCopyModelSelection({
        source: activeThread.modelSelection,
        sourceProviders: providersByEnvironment.get(environmentId) ?? [],
        targetProviders: providersByEnvironment.get(targetEnvironmentId) ?? [],
      });
      if (modelSelection === null) {
        throw new Error(
          `${target.environmentLabel} has no enabled provider like this chat's. Turn one on there, then copy again.`,
        );
      }
      let exported: ThreadTransferExportResult | null = null;
      if (serverConfig?.environment.capabilities.threadTransfer === true) {
        const result = await exportThreadFromServer({
          environmentId,
          input: { threadId: activeThread.id },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        exported = result.value;
      }
      // An older source has no export, so the copy takes the messages this client holds.
      const messages = exported?.messages ?? chatCopyMessages(timelineMessages);
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      let nativeHistory = false;

      if (targetConfig.environment.capabilities.threadTransfer === true) {
        const importInput = {
          threadId,
          projectId: target.projectId,
          title: activeThread.title,
          modelSelection,
          runtimeMode: activeThread.runtimeMode,
          interactionMode: activeThread.interactionMode,
          messages,
          conversation: exported?.conversation ?? null,
        };
        let result = await importThreadOnServer({
          environmentId: targetEnvironmentId,
          input: importInput,
        });
        // A provider session too large for the connection still copies as history.
        if (result._tag === "Failure" && importInput.conversation !== null) {
          result = await importThreadOnServer({
            environmentId: targetEnvironmentId,
            input: { ...importInput, conversation: null },
          });
        }
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        nativeHistory = result.value.nativeHistory;
        // Without the agent's session, the target hands the agent the imported
        // history with this first turn.
        if (!nativeHistory && messages.length > 0) {
          const turn = await startThreadTurn({
            environmentId: targetEnvironmentId,
            input: {
              threadId,
              message: {
                messageId: newMessageId(),
                role: "user",
                text: buildCopySummaryPrompt({
                  title: activeThread.title,
                  copiedFrom: sourceLabel,
                }),
                attachments: [],
              },
              modelSelection,
              runtimeMode: activeThread.runtimeMode,
              interactionMode: activeThread.interactionMode,
              dispatchMode: "start",
            },
          });
          if (turn._tag === "Failure") throw squashAtomCommandFailure(turn);
        }
      } else {
        // A target without the import RPC starts the copy with a first message
        // that carries the conversation.
        const turn = await startThreadTurn({
          environmentId: targetEnvironmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: buildCopyHandoffMessage({
                title: activeThread.title,
                messages,
                copiedFrom: sourceLabel,
                maxChars: PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
              }),
              attachments: [],
            },
            modelSelection,
            runtimeMode: activeThread.runtimeMode,
            interactionMode: activeThread.interactionMode,
            bootstrap: {
              createThread: {
                projectId: target.projectId,
                title: activeThread.title,
                modelSelection,
                runtimeMode: activeThread.runtimeMode,
                interactionMode: activeThread.interactionMode,
                branch: null,
                worktreePath: null,
                createdAt,
              },
            },
          },
        });
        if (turn._tag === "Failure") throw squashAtomCommandFailure(turn);
      }

      toastManager.add({
        type: "success",
        title: `Copied to ${targetLabel}`,
        description: nativeHistory
          ? "The agent's session came along, so it remembers the whole chat."
          : "The agent is reading the earlier conversation and will reply with a summary.",
      });
      const targetThreadRef = scopeThreadRef(targetEnvironmentId, threadId);
      if (await waitForThreadShell(targetThreadRef)) {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(targetThreadRef),
        });
      }
    } catch (error) {
      setThreadError(
        activeThread.id,
        error instanceof Error ? error.message : "Failed to copy this chat.",
      );
    } finally {
      setIsCopyingThread(false);
    }
  };
  return useStableCallback((target: CopyTargetOption) => void onCopyToEnvironment(target));
}
