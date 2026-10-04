import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectService from "../project/ProjectService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  ThreadTransferServiceV2,
  decodeTransferData,
  layer as threadTransferLayer,
} from "./ThreadTransferService.ts";

const SOURCE_ID = ThreadId.make("thread-source");
const COPY_ID = ThreadId.make("thread-copy");
const SOURCE_PROJECT = ProjectId.make("project-on-source");
const TARGET_PROJECT = ProjectId.make("project-on-target");
const claude = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId: claude, model: "claude-opus-5-5" };
const at = DateTime.makeUnsafe("2026-09-23T10:00:00.000Z");
const run = (id: string, status: string) => ({ id: RunId.make(id), status });
const item = (id: string, role: "user" | "assistant", text: string, streaming = false) => ({
  id: TurnItemId.make(id),
  threadId: SOURCE_ID,
  startedAt: at,
  updatedAt: at,
  ...(role === "user"
    ? { type: "user_message", text, attachments: [] }
    : { type: "assistant_message", text, streaming }),
});
// What the thread shows, inherited fork history first.
const timeline = [
  item("i1", "user", "Look at [parser.ts](t3-context://v1/mention/ctx_1)"),
  item("i2", "assistant", "It drops trailing commas."),
  item("i3", "assistant", "Still typing", true),
].map((turnItem, position) => ({
  position,
  visibility: position === 0 ? "inherited" : "local",
  sourceThreadId: SOURCE_ID,
  sourceItemId: turnItem.id,
  item: turnItem,
}));
const sourceProviderThread = {
  id: ProviderThreadId.make("provider-thread-source"),
  providerInstanceId: claude,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("claudeAgent"),
    nativeId: "session-1",
    strength: "strong",
  },
};

const sourceRecords = (runs: ReadonlyArray<ReturnType<typeof run>>) => ({
  thread: {
    id: SOURCE_ID,
    projectId: SOURCE_PROJECT,
    title: "Fix the parser",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: "/srv/worktrees/parser",
    activeProviderThreadId: sourceProviderThread.id,
    deletedAt: null,
  },
  runs,
  providerThreads: [sourceProviderThread],
});

interface Harness {
  readonly records?: ReturnType<typeof sourceRecords>;
  readonly exported?: unknown;
  readonly importFails?: boolean;
  readonly writes?: Array<ReadonlyArray<OrchestrationV2DomainEvent>>;
  readonly exportCalls?: Array<{ cwd: string | null }>;
  readonly importCalls?: Array<{ cwd: string; data: unknown }>;
}

const provide =
  (harness: Harness) =>
  <A, E>(effect: Effect.Effect<A, E, ThreadTransferServiceV2>) =>
    effect.pipe(
      Effect.provide(
        threadTransferLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadRecords: () =>
                  Effect.succeed((harness.records ?? sourceRecords([])) as never),
                getThreadShell: () => Effect.succeed(null),
                // One item per page exercises paging through the timeline.
                getTimelinePage: (_threadId, options) =>
                  Effect.sync(() => {
                    const start = (options.afterPosition ?? -1) + 1;
                    return {
                      items: timeline.slice(start, start + 1),
                      totalItems: timeline.length,
                      hasMore: start + 1 < timeline.length,
                    } as never;
                  }),
              }),
              Layer.mock(ProjectService.ProjectService)({
                getById: (projectId) =>
                  Effect.succeedSome({
                    id: projectId,
                    workspaceRoot: projectId === TARGET_PROJECT ? "/home/me/parser" : "/srv/parser",
                  } as never),
              }),
              Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                get: () =>
                  Effect.succeed({
                    instanceId: claude,
                    driver: ProviderDriverKind.make("claudeAgent"),
                    exportNativeThread: (input: { cwd: string | null }) =>
                      Effect.sync(() => {
                        harness.exportCalls?.push({ cwd: input.cwd });
                        return harness.exported === undefined
                          ? null
                          : { format: "claude-session-v1", data: harness.exported };
                      }),
                    importNativeThread: (input: { cwd: string; data: unknown }) =>
                      harness.importFails
                        ? Effect.die("import failed")
                        : Effect.sync(() => {
                            harness.importCalls?.push({ cwd: input.cwd, data: input.data });
                            return {
                              nativeThreadId: "session-copy",
                              conversationHeadId: "message-last",
                            };
                          }),
                  } as never),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                write: (input) =>
                  Effect.sync(() => {
                    harness.writes?.push(input.events);
                    return [];
                  }),
              }),
              IdAllocator.layer,
            ),
          ),
        ),
      ),
    );

const importInput = (conversation: { driver: string; format: string; data: string } | null) => ({
  threadId: COPY_ID,
  projectId: TARGET_PROJECT,
  title: "Fix the parser",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  messages: [
    { role: "user" as const, text: "Look at parser.ts", createdAt: "2026-09-23T10:00:00.000Z" },
    {
      role: "assistant" as const,
      text: "It drops trailing commas.",
      createdAt: "2026-09-23T10:01:00.000Z",
    },
  ],
  conversation,
});

describe("ThreadTransferService", () => {
  it.effect("exports the visible conversation with the provider session", () => {
    const exportCalls: Array<{ cwd: string | null }> = [];
    const session = { sessionId: "session-1", transcripts: [] };
    return Effect.gen(function* () {
      const transfer = yield* ThreadTransferServiceV2;
      const result = yield* transfer.exportThread({ threadId: SOURCE_ID });

      expect(result.messages).toEqual([
        { role: "user", text: "Look at parser.ts", createdAt: "2026-09-23T10:00:00.000Z" },
        {
          role: "assistant",
          text: "It drops trailing commas.",
          createdAt: "2026-09-23T10:00:00.000Z",
        },
      ]);
      expect(result.conversation).toMatchObject({
        driver: "claudeAgent",
        format: "claude-session-v1",
      });
      expect(decodeTransferData(result.conversation!.data)).toEqual(session);
      // Claude finds the session under the directory the thread ran in.
      expect(exportCalls).toEqual([{ cwd: "/srv/worktrees/parser" }]);
    }).pipe(
      provide({
        records: sourceRecords([run("run-1", "interrupted"), run("run-2", "rolled_back")]),
        exported: session,
        exportCalls,
      }),
    );
  });

  it.effect("refuses to export while a turn is running", () =>
    Effect.gen(function* () {
      const transfer = yield* ThreadTransferServiceV2;
      const error = yield* Effect.flip(transfer.exportThread({ threadId: SOURCE_ID }));
      expect(error.message).toContain("Wait for the current turn");
    }).pipe(provide({ records: sourceRecords([run("run-1", "running")]) })),
  );

  it.effect("imports into the target project root with the provider copy bound", () => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    const importCalls: Array<{ cwd: string; data: unknown }> = [];
    return Effect.gen(function* () {
      const transfer = yield* ThreadTransferServiceV2;
      const exported = yield* transfer.exportThread({ threadId: SOURCE_ID });
      const result = yield* transfer.importThread({
        ...importInput(exported.conversation),
        messages: exported.messages,
      });

      expect(result).toEqual({ threadId: COPY_ID, nativeHistory: true });
      expect(importCalls).toEqual([{ cwd: "/home/me/parser", data: [1, 2] }]);
      const events = writes[0] ?? [];
      expect(events.map((event) => event.type)).toEqual([
        "thread.created",
        "message.updated",
        "turn-item.updated",
        "message.updated",
        "turn-item.updated",
        "provider-thread.updated",
      ]);
      const created = events.find((event) => event.type === "thread.created");
      const providerThread = events.find((event) => event.type === "provider-thread.updated");
      expect(created?.payload).toMatchObject({
        id: COPY_ID,
        projectId: TARGET_PROJECT,
        branch: null,
        worktreePath: null,
        historyOrigin: "v1_import",
        activeProviderThreadId: providerThread?.payload.id,
      });
      expect(providerThread?.payload).toMatchObject({
        appThreadId: COPY_ID,
        providerInstanceId: claude,
        nativeThreadRef: { driver: "claudeAgent", nativeId: "session-copy", strength: "strong" },
        // The first turn resumes the imported session instead of starting it.
        nativeConversationHeadRef: { nativeId: "message-last", strength: "weak" },
      });
    }).pipe(
      provide({
        records: sourceRecords([run("run-1", "completed")]),
        exported: [1, 2],
        writes,
        importCalls,
      }),
    );
  });

  it.effect("keeps the history when the provider session cannot be imported", () => {
    const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
    return Effect.gen(function* () {
      const transfer = yield* ThreadTransferServiceV2;
      const withoutSession = yield* transfer.importThread(importInput(null));
      expect(withoutSession.nativeHistory).toBe(false);

      const failedImport = yield* transfer.importThread(
        importInput({ driver: "claudeAgent", format: "claude-session-v1", data: "not gzip" }),
      );
      expect(failedImport.nativeHistory).toBe(false);

      for (const events of writes) {
        expect(events.map((event) => event.type)).not.toContain("provider-thread.updated");
        expect(events.find((event) => event.type === "thread.created")?.payload).toMatchObject({
          activeProviderThreadId: null,
          historyOrigin: "v1_import",
        });
      }
    }).pipe(provide({ writes, importFails: true }));
  });
});
