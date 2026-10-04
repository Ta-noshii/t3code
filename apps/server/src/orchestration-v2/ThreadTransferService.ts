// @effect-diagnostics nodeBuiltinImport:off - gzip of the provider session for the wire.
import * as NodeZlib from "node:zlib";

import {
  EventId,
  MessageId,
  ProviderDriverKind,
  ThreadTransferError,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type ThreadTransferConversation,
  type ThreadTransferExportInput,
  type ThreadTransferExportResult,
  type ThreadTransferImportInput,
  type ThreadTransferImportResult,
  type ThreadTransferMessage,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";

// Keeps a single RPC frame well inside what the relay carries. A larger
// provider session travels as visible history only.
const MAX_CONVERSATION_BYTES = 48 * 1024 * 1024;
const IMPORT_EVENT_PREFIX = "thread-transfer-import";
const TIMELINE_PAGE_SIZE = 500;

const transferError = (message: string, cause?: unknown) =>
  new ThreadTransferError({ message, ...(cause === undefined ? {} : { cause }) });

export function encodeTransferData(data: unknown): string {
  return NodeZlib.gzipSync(Buffer.from(JSON.stringify(data), "utf8")).toString("base64");
}

export function decodeTransferData(data: string): unknown {
  return JSON.parse(NodeZlib.gunzipSync(Buffer.from(data, "base64")).toString("utf8"));
}

function isActiveRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "preparing" || status === "starting" || status === "running" || status === "waiting"
  );
}

/**
 * The conversation as the thread shows it: user and assistant messages,
 * inherited fork history included. Context links collapse to their labels,
 * since the records they point at exist only on this machine.
 */
export function transferMessages(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<ThreadTransferMessage> {
  return items.flatMap((item) => {
    if (item.type !== "user_message" && item.type !== "assistant_message") return [];
    if (item.type === "assistant_message" && item.streaming) return [];
    const text = replaceComposerContextReferences(item.text, (reference) => reference.label);
    const hasAttachments = item.type === "user_message" && item.attachments.length > 0;
    const body = text.trim().length > 0 ? text : hasAttachments ? "[attachments]" : "";
    if (body.length === 0) return [];
    return [
      {
        role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
        text: body,
        createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
      },
    ];
  });
}

function importedMessageEvents(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly message: ThreadTransferMessage;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const suffix = String(input.index).padStart(6, "0");
  const messageId = MessageId.make(`${IMPORT_EVENT_PREFIX}:${input.threadId}:${suffix}`);
  const turnItemId = TurnItemId.make(
    `${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`,
  );
  const at = DateTime.makeUnsafe(input.message.createdAt);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: input.message.role === "user" ? "user" : "agent",
    creationSource: "server",
    id: messageId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    role: input.message.role,
    text: input.message.text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
  };
  const common = {
    id: turnItemId,
    threadId: input.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.index + 1,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const turnItem: OrchestrationV2TurnItem =
    input.message.role === "user"
      ? {
          ...common,
          createdBy: "user",
          creationSource: "server",
          type: "user_message",
          messageId,
          inputIntent: "turn_start",
          text: input.message.text,
          attachments: [],
        }
      : {
          ...common,
          type: "assistant_message",
          messageId,
          text: input.message.text,
          streaming: false,
        };
  return [
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:message:${input.threadId}:${suffix}`),
      type: "message.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: message,
    },
    {
      id: EventId.make(`${IMPORT_EVENT_PREFIX}:turn-item:${input.threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId: input.threadId,
      occurredAt: at,
      payload: turnItem,
    },
  ];
}

export interface ThreadTransferServiceV2Shape {
  /** Reads a finished thread and its provider session for a copy on another environment. */
  readonly exportThread: (
    input: ThreadTransferExportInput,
  ) => Effect.Effect<ThreadTransferExportResult, ThreadTransferError>;
  /**
   * Creates a thread from another environment's export, in the target
   * project's root since the source's worktree exists only on the source.
   * The messages land as imported history. When the selected provider can
   * take the exported session, the thread resumes a copy of it; otherwise the
   * first turn hands the agent the imported history as context.
   */
  readonly importThread: (
    input: ThreadTransferImportInput,
  ) => Effect.Effect<ThreadTransferImportResult, ThreadTransferError>;
}

export class ThreadTransferServiceV2 extends Context.Service<
  ThreadTransferServiceV2,
  ThreadTransferServiceV2Shape
>()("t3/orchestration-v2/ThreadTransferService/ThreadTransferServiceV2") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;

  const requireProject = (projectId: OrchestrationV2AppThread["projectId"]) =>
    projects.getById(projectId).pipe(
      Effect.mapError((cause) => transferError("Failed to read the project.", cause)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(transferError("The project is not on this environment.")),
          onSome: Effect.succeed,
        }),
      ),
    );

  const exportConversation = Effect.fn("ThreadTransferService.exportConversation")(function* (
    providerThread: OrchestrationV2ProviderThread,
    cwd: string,
  ) {
    const adapter = yield* providerAdapters.get(providerThread.providerInstanceId);
    if (adapter.exportNativeThread === undefined) return null;
    const exported = yield* adapter.exportNativeThread({ providerThread, cwd });
    if (exported === null) return null;
    const data = encodeTransferData(exported.data);
    if (data.length > MAX_CONVERSATION_BYTES) return null;
    return {
      driver: adapter.driver,
      format: exported.format,
      data,
    } satisfies ThreadTransferConversation;
  });

  const exportThread = Effect.fn("ThreadTransferService.exportThread")(function* (
    input: ThreadTransferExportInput,
  ) {
    const readError = (cause: unknown) => transferError("Failed to read the thread.", cause);
    const records = yield* orchestrator
      .getThreadRecords(input.threadId, ["runs", "providerThreads"])
      .pipe(Effect.mapError(readError));
    const thread = records.thread;
    if (thread.deletedAt !== null) {
      return yield* transferError("The thread was deleted.");
    }
    if (records.runs.some((run) => isActiveRunStatus(run.status))) {
      return yield* transferError("Wait for the current turn to finish before copying.");
    }
    const items: Array<OrchestrationV2TurnItem> = [];
    let afterPosition: number | undefined;
    while (true) {
      const page = yield* orchestrator
        .getTimelinePage(input.threadId, {
          view: "messages",
          limit: TIMELINE_PAGE_SIZE,
          ...(afterPosition === undefined ? {} : { afterPosition }),
        })
        .pipe(Effect.mapError(readError));
      items.push(...page.items.map((row) => row.item));
      const last = page.items.at(-1);
      if (!page.hasMore || last === undefined) break;
      afterPosition = last.position;
    }
    const messages = transferMessages(items);
    const providerThread = records.providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    const conversation =
      messages.length === 0 || providerThread === undefined
        ? null
        : yield* requireProject(thread.projectId).pipe(
            Effect.flatMap((project) =>
              exportConversation(providerThread, thread.worktreePath ?? project.workspaceRoot),
            ),
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
    } satisfies ThreadTransferExportResult;
  });

  const importConversation = Effect.fn("ThreadTransferService.importConversation")(function* (
    input: ThreadTransferImportInput,
    conversation: ThreadTransferConversation,
    cwd: string,
  ) {
    const adapter = yield* providerAdapters.get(input.modelSelection.instanceId);
    if (adapter.importNativeThread === undefined || adapter.driver !== conversation.driver) {
      return null;
    }
    const data = yield* Effect.try({
      try: () => decodeTransferData(conversation.data),
      catch: (cause) => transferError("The provider conversation is unreadable.", cause),
    });
    const imported = yield* adapter.importNativeThread({
      format: conversation.format,
      data,
      cwd,
    });
    return { driver: adapter.driver, ...imported };
  });

  const importThread = Effect.fn("ThreadTransferService.importThread")(function* (
    input: ThreadTransferImportInput,
  ) {
    const existing = yield* orchestrator
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError((cause) => transferError("Failed to read the thread.", cause)));
    if (existing !== null) {
      return yield* transferError("A thread with this id already exists here.");
    }
    const project = yield* requireProject(input.projectId);
    const conversation = input.conversation;
    const native =
      conversation === null || input.messages.length === 0
        ? null
        : yield* importConversation(input, conversation, project.workspaceRoot).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not import the provider conversation", {
                threadId: input.threadId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );

    const now = yield* DateTime.now;
    const providerThread: OrchestrationV2ProviderThread | null =
      native === null
        ? null
        : {
            id: idAllocator.derive.providerThread({
              driver: ProviderDriverKind.make(native.driver),
              providerInstanceId: input.modelSelection.instanceId,
              nativeThreadId: native.nativeThreadId,
            }),
            driver: ProviderDriverKind.make(native.driver),
            providerInstanceId: input.modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: ProviderDriverKind.make(native.driver),
              nativeId: native.nativeThreadId,
              strength: "strong",
            },
            // A driver that resumes at a message names where the copy continues.
            nativeConversationHeadRef:
              native.conversationHeadId === undefined
                ? null
                : {
                    driver: ProviderDriverKind.make(native.driver),
                    nativeId: native.conversationHeadId,
                    strength: "weak",
                  },
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            createdAt: now,
            updatedAt: now,
          };
    const appThread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "server",
      id: input.threadId,
      projectId: input.projectId,
      title: input.title,
      providerInstanceId: input.modelSelection.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      branch: null,
      worktreePath: null,
      linkedPullRequest: null,
      branchPullRequest: null,
      activeProviderThreadId: providerThread?.id ?? null,
      // Imported history is runless; this origin is what makes it count as
      // conversation for timelines, forks, and provider handoffs.
      historyOrigin: "v1_import",
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      unsettledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    yield* eventSink
      .write({
        events: [
          {
            id: EventId.make(`${IMPORT_EVENT_PREFIX}:thread:${input.threadId}:created`),
            type: "thread.created",
            threadId: input.threadId,
            providerInstanceId: input.modelSelection.instanceId,
            occurredAt: now,
            payload: appThread,
          },
          ...input.messages.flatMap((message, index) =>
            importedMessageEvents({ threadId: input.threadId, index, message }),
          ),
          ...(providerThread === null
            ? []
            : [
                {
                  id: EventId.make(`${IMPORT_EVENT_PREFIX}:provider-thread:${providerThread.id}`),
                  type: "provider-thread.updated" as const,
                  threadId: input.threadId,
                  driver: providerThread.driver,
                  providerInstanceId: input.modelSelection.instanceId,
                  occurredAt: now,
                  payload: providerThread,
                },
              ]),
        ],
      })
      .pipe(Effect.mapError((cause) => transferError("Failed to create the thread.", cause)));

    return {
      threadId: input.threadId,
      nativeHistory: providerThread !== null,
    } satisfies ThreadTransferImportResult;
  });

  return ThreadTransferServiceV2.of({ exportThread, importThread });
});

export const layer = Layer.effect(ThreadTransferServiceV2, make);
