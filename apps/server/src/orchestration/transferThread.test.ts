import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  ProviderService,
  type ProviderConversationExport,
} from "../provider/Services/ProviderService.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { decodeTransferData, exportThread, importThread } from "./transferThread.ts";

const SOURCE_ID = ThreadId.make("thread-source");
const CLONE_ID = ThreadId.make("thread-clone");
const TARGET_PROJECT = ProjectId.make("project-on-target");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: null,
  streaming: false,
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:00.000Z",
});

const source = {
  id: SOURCE_ID,
  projectId: ProjectId.make("project-on-source"),
  title: "Fix the parser",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "fix/parser",
  worktreePath: "/srv/worktrees/parser",
  deletedAt: null,
  session: null,
  messages: [
    message("m1", "user", "Look at [parser.ts](t3-context://v1/mention/ctx_1)"),
    message("m2", "assistant", "It drops trailing commas."),
  ],
} as unknown as OrchestrationThread;

const services =
  (options: {
    readonly exported?: ProviderConversationExport | null;
    readonly importAccepts?: boolean;
    readonly dispatched?: Array<OrchestrationCommand>;
    readonly imports?: Array<{ cwd: string; data: unknown }>;
  }) =>
  <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | ProjectionSnapshotQuery.ProjectionSnapshotQuery
      | OrchestrationEngine.OrchestrationEngineService
      | ProviderService
      | Crypto.Crypto
    >,
  ) =>
    effect.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getThreadDetailById: () => Effect.succeed(Option.some(source)),
        getProjectShellById: () =>
          Effect.succeed(Option.some({ id: TARGET_PROJECT, workspaceRoot: "/home/me/parser" })),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            options.dispatched?.push(command);
            return { sequence: options.dispatched?.length ?? 0 };
          }),
        streamDomainEvents: Stream.empty,
      } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(ProviderService, {
        exportConversation: () => Effect.succeed(options.exported ?? null),
        importConversation: (input: { cwd: string; conversation: ProviderConversationExport }) =>
          Effect.sync(() => {
            options.imports?.push({ cwd: input.cwd, data: input.conversation.data });
            return options.importAccepts ?? true;
          }),
      } as unknown as ProviderService["Service"]),
      Effect.provide(NodeServices.layer),
    );

describe("transferThread", () => {
  it.effect("exports the visible history with the provider conversation", () =>
    Effect.gen(function* () {
      const session = { sessionId: "abc", transcripts: [] };
      const result = yield* exportThread({ threadId: SOURCE_ID }).pipe(
        services({
          exported: { driver: "claudeAgent", format: "claude-session-v1", data: session },
        }),
      );

      expect(result.messages).toMatchObject([
        { role: "user", text: "Look at parser.ts" },
        { role: "assistant", text: "It drops trailing commas." },
      ]);
      expect(result.conversation).toMatchObject({
        driver: "claudeAgent",
        format: "claude-session-v1",
      });
      expect(decodeTransferData(result.conversation!.data)).toEqual(session);
    }),
  );

  it.effect("imports into the target project root with the provider copy bound", () =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      const imports: Array<{ cwd: string; data: unknown }> = [];
      const exported = yield* exportThread({ threadId: SOURCE_ID }).pipe(
        services({
          exported: { driver: "claudeAgent", format: "claude-session-v1", data: [1, 2] },
        }),
      );
      const result = yield* importThread({
        threadId: CLONE_ID,
        projectId: TARGET_PROJECT,
        title: exported.title,
        modelSelection: exported.modelSelection,
        runtimeMode: exported.runtimeMode,
        interactionMode: exported.interactionMode,
        messages: exported.messages,
        conversation: exported.conversation,
      }).pipe(services({ dispatched, imports }));

      expect(result).toEqual({ threadId: CLONE_ID, nativeHistory: true });
      expect(imports).toEqual([{ cwd: "/home/me/parser", data: [1, 2] }]);
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.history.import",
        "thread.unsettle",
      ]);
      expect(dispatched[0]).toMatchObject({
        threadId: CLONE_ID,
        projectId: TARGET_PROJECT,
        branch: null,
        worktreePath: null,
        historyImport: true,
      });
    }),
  );

  it.effect("reports copied history the target provider cannot resume", () =>
    Effect.gen(function* () {
      const result = yield* importThread({
        threadId: CLONE_ID,
        projectId: TARGET_PROJECT,
        title: "Fix the parser",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        messages: [{ role: "user", text: "hi", createdAt: "2026-09-23T10:00:00.000Z" }],
        conversation: null,
      }).pipe(services({ dispatched: [] }));

      expect(result.nativeHistory).toBe(false);
    }),
  );
});
