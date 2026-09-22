import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { countProviderTurnsFrom, forkThread } from "./forkThread.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

const SOURCE_ID = ThreadId.make("thread-source");
const FORK_ID = ThreadId.make("thread-fork");

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  turnId: string | null = null,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: turnId === null ? null : TurnId.make(turnId),
  streaming: false,
  createdAt: "2026-09-22T10:00:00.000Z",
  updatedAt: "2026-09-22T10:00:00.000Z",
});

const source = {
  id: SOURCE_ID,
  projectId: ProjectId.make("project-1"),
  title: "Fix the parser",
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "fix/parser",
  worktreePath: "/tmp/worktrees/parser",
  deletedAt: null,
  session: null,
  messages: [
    message("m1", "user", "Look at [parser.ts](t3-context://v1/mention/ctx_1)"),
    message("m2", "assistant", "It drops trailing commas."),
    message("m3", "user", "Fix it"),
    message("m4", "assistant", "Done."),
  ],
} as unknown as OrchestrationThread;

const run = (beforeMessageId: MessageId | null, nativeFork: boolean) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationCommand> = [];
    const forks: Array<{ numTurns: number }> = [];
    const result = yield* forkThread({
      sourceThreadId: SOURCE_ID,
      threadId: FORK_ID,
      beforeMessageId,
      title: source.title,
    }).pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getThreadDetailById: () => Effect.succeed(Option.some(source)),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
        streamDomainEvents: Stream.empty,
      } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(ProviderService, {
        forkConversation: (input: { numTurns: number }) =>
          Effect.sync(() => {
            forks.push({ numTurns: input.numTurns });
            return nativeFork;
          }),
      } as unknown as ProviderService["Service"]),
      Effect.provide(NodeServices.layer),
    );
    return { result, dispatched, forks };
  });

describe("forkThread", () => {
  it.effect("copies the messages before the fork point into a thread in the same workspace", () =>
    Effect.gen(function* () {
      const { result, dispatched, forks } = yield* run(MessageId.make("m3"), true);

      expect(result).toEqual({ threadId: FORK_ID, nativeHistory: true });
      // The provider drops the one user turn at and after the fork point.
      expect(forks).toEqual([{ numTurns: 1 }]);
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.history.import",
        "thread.unsettle",
      ]);
      expect(dispatched[0]).toMatchObject({
        threadId: FORK_ID,
        projectId: source.projectId,
        branch: "fix/parser",
        worktreePath: "/tmp/worktrees/parser",
        historyImport: true,
      });
      const imported = dispatched[1];
      expect(imported?.type === "thread.history.import" ? imported.messages : []).toMatchObject([
        { role: "user", text: "Look at parser.ts" },
        { role: "assistant", text: "It drops trailing commas." },
      ]);
    }),
  );

  it.effect("reports copied history the provider cannot resume", () =>
    Effect.gen(function* () {
      const { result, forks } = yield* run(null, false);

      expect(result.nativeHistory).toBe(false);
      expect(forks).toEqual([{ numTurns: 0 }]);
    }),
  );

  it.effect("forks before the first message into an empty thread", () =>
    Effect.gen(function* () {
      const { result, dispatched, forks } = yield* run(MessageId.make("m1"), true);

      expect(result.nativeHistory).toBe(false);
      expect(forks).toEqual([]);
      expect(dispatched.map((command) => command.type)).toEqual(["thread.create"]);
    }),
  );

  it("counts a steer as part of the turn it joined", () => {
    const messages = [
      message("u1", "user", "first"),
      message("a1", "assistant", "on it", "t1"),
      message("s1", "user", "also this"),
      message("a1b", "assistant", "done", "t1"),
      message("u2", "user", "second"),
      // Interrupted before replying: still a provider turn.
      message("u3", "user", "third"),
      message("a3", "assistant", "ok", "t3"),
    ];
    expect(countProviderTurnsFrom(messages, 0)).toBe(3);
    expect(countProviderTurnsFrom(messages, 2)).toBe(2);
    expect(countProviderTurnsFrom(messages, 4)).toBe(2);
  });
});
