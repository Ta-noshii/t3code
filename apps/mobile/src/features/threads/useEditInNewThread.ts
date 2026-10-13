import {
  buildEarlierConversationTranscript,
  planEditInNewThread,
} from "@t3tools/client-runtime/state/thread-workflows";
import { type EnvironmentId, type MessageId, type ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Alert } from "react-native";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import {
  createNewTaskDraft,
  setComposerDraftContext,
  setComposerDraftText,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { useSelectedThreadVisibleTurnItems } from "../../state/use-thread-detail";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { appAtomRegistry } from "../../state/atom-registry";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useAtomCommand } from "../../state/use-atom-command";
import { waitForThreadShellReady } from "./threadForkNavigation";

const ALERT_TITLE = "Edit in new thread";

/** Resolves once a newly created thread's shell has reached this client. */
export async function waitForThreadShell(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<boolean> {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return waitForThreadShellReady({
    read: () => appAtomRegistry.get(atom) !== null,
  });
}

/**
 * "Edit in new thread" on a sent user message: a new thread holds the conversation up to
 * that message, and the message goes back into its composer, unsent. When an earlier run
 * exists the thread forks at its end; otherwise a new task starts in the same workspace
 * with the earlier messages written into the prompt.
 */
export function useEditInNewThread(input: {
  readonly thread: {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  } | null;
  readonly busy: boolean;
  readonly hasEarlierHistory: boolean;
}): (messageId: MessageId) => Promise<void> {
  const { thread, busy, hasEarlierHistory } = input;
  const visibleTurnItems = useSelectedThreadVisibleTurnItems();
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun, "edit in new thread");
  const navigation = useNavigation();

  return useCallback(
    async (messageId: MessageId) => {
      if (thread === null) return;
      const environmentId = thread.environmentId;
      if (busy) {
        Alert.alert(ALERT_TITLE, "Stop the current turn before editing in a new thread.");
        return;
      }
      const plan = planEditInNewThread(visibleTurnItems, messageId, { hasEarlierHistory });
      if (!plan) return;
      if (plan.type === "history_not_loaded") {
        Alert.alert(
          ALERT_TITLE,
          "Load the earlier messages at the top of this thread, then edit this message again.",
        );
        return;
      }
      try {
        await waitForComposerDraftsLoaded();
      } catch {
        Alert.alert(ALERT_TITLE, "Drafts could not be loaded. Try again.");
        return;
      }
      const prompt = plan.message.text.trim();
      const attachmentNote =
        (plan.message.attachments?.length ?? 0) > 0
          ? " Its attachments stay in the original thread; add them again if you need them."
          : "";

      if (plan.type === "fork") {
        const targetThreadId = ThreadId.make(uuidv4());
        const result = await forkFromRun({
          environmentId,
          input: {
            sourceThreadId: plan.sourceThreadId,
            targetThreadId,
            runId: plan.runId,
            title: `${thread.title} fork`,
            creationSource: "mobile",
          },
        });
        if (result._tag !== "Success") return;
        const draftKey = scopedThreadKey(environmentId, targetThreadId);
        setComposerDraftText(draftKey, prompt);
        setComposerDraftContext(draftKey, plan.message.context);
        if (!(await waitForThreadShell(environmentId, targetThreadId))) {
          Alert.alert(
            ALERT_TITLE,
            "The new thread was created, but its data did not reach this client. Reconnect and open it from the thread list.",
          );
          return;
        }
        navigation.navigate("Thread", { environmentId, threadId: targetThreadId });
        if (attachmentNote) Alert.alert(ALERT_TITLE, attachmentNote.trim());
        return;
      }

      // Nothing before the message ran in T3 (it is the first message, or the earlier
      // history was imported), so there is no run to fork. The new task starts in the
      // same workspace and carries the earlier messages in its prompt.
      const draftKey = createNewTaskDraft({ environmentId, projectId: thread.projectId });
      updateComposerDraftSettings(draftKey, {
        workspaceSelection: {
          mode: thread.worktreePath ? "worktree" : "local",
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          startFromOrigin: false,
        },
      });
      const transcript =
        plan.earlierMessages.length > 0
          ? buildEarlierConversationTranscript({
              title: thread.title,
              messages: plan.earlierMessages,
            })
          : null;
      setComposerDraftText(
        draftKey,
        transcript === null
          ? prompt
          : prompt.length > 0
            ? `${transcript}\n\n---\n\n${prompt}`
            : transcript,
      );
      setComposerDraftContext(draftKey, plan.message.context);
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: { draftId: draftKey, title: ALERT_TITLE },
      });
      if (attachmentNote) Alert.alert(ALERT_TITLE, attachmentNote.trim());
    },
    [busy, forkFromRun, hasEarlierHistory, navigation, thread, visibleTurnItems],
  );
}
