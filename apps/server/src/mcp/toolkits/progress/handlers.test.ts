import {
  EnvironmentId,
  type OrchestrationV2AgentProgress,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { applyAgentProgressUpdate, summarizeAgentProgress } from "@t3tools/shared/agentProgress";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as ProgressHandlers from "./handlers.ts";
import { ProgressToolkit } from "./tools.ts";

const ROOT = ThreadId.make("thread-root");
const CHILD = ThreadId.make("thread-child");
const GRANDCHILD = ThreadId.make("thread-grandchild");
const FORK = ThreadId.make("thread-fork");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

function child(
  id: ThreadId,
  parentThreadId: ThreadId,
  relationshipToParent: "subagent" | "fork",
): OrchestrationV2ThreadShell {
  return {
    ...McpToolAccessTestkit.liveThreadShell(id),
    lineage: { rootThreadId: ROOT, parentThreadId, relationshipToParent },
  };
}

const invocation = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: `provider-session:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider-session:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
});

const makeHarness = Effect.fn("makeProgressToolkitHarness")(function* () {
  const shells = yield* Ref.make(
    new Map<ThreadId, OrchestrationV2ThreadShell>([
      [ROOT, McpToolAccessTestkit.liveThreadShell(ROOT)],
      [CHILD, child(CHILD, ROOT, "subagent")],
      [GRANDCHILD, child(GRANDCHILD, CHILD, "subagent")],
      [FORK, child(FORK, ROOT, "fork")],
    ]),
  );
  const progress = yield* Ref.make(new Map<ThreadId, OrchestrationV2AgentProgress | null>());
  function applyProgress(
    current: OrchestrationV2AgentProgress | null | undefined,
    command: Extract<OrchestrationV2ServerCommand, { type: "thread.progress.update" }>,
  ) {
    const result = applyAgentProgressUpdate(current, command.update, "2026-10-24T00:00:00.000Z");
    if (result._tag === "rejected") throw new Error(result.message);
    return result.progress;
  }
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.all([Ref.get(shells), Ref.get(progress)]).pipe(
        Effect.map(([byId, progressById]) => {
          const shell = byId.get(threadId);
          if (shell === undefined) return null;
          return { ...shell, progressSummary: summarizeAgentProgress(progressById.get(threadId)) };
        }),
      ),
    dispatch: (command) =>
      Effect.gen(function* () {
        yield* Ref.update(commands, (recorded) => [...recorded, command]);
        if (command.type === "thread.progress.update") {
          yield* Ref.update(progress, (byId) =>
            new Map(byId).set(command.threadId, applyProgress(byId.get(command.threadId), command)),
          );
        }
        return { sequence: 1, storedEvents: [] };
      }),
  });
  const dependencies = Layer.mergeAll(threads, Layer.succeed(Crypto.Crypto, testCrypto));
  const toolkit = yield* ProgressToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ProgressHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  const call = (
    caller: ThreadId,
    params: Parameters<typeof toolkit.handle<"progress_update">>[1],
  ) =>
    toolkit.handle("progress_update", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) =>
          chunk.at(-1)!.result as Tool.Success<(typeof ProgressToolkit.tools)["progress_update"]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(caller)),
      Effect.provide(dependencies),
    );
  const dispatchedTo = Ref.get(commands).pipe(
    Effect.map((recorded) =>
      recorded.map((command) => ("threadId" in command ? command.threadId : null)),
    ),
  );
  return { call, dispatchedTo, shells };
});

describe("progress toolkit handlers", () => {
  it.effect("sends a delegated child's and grandchild's updates to the topmost parent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.call(ROOT, {
        title: "Fix bugs",
        items: [{ id: "a" }, { id: "b" }, { id: "c" }],
      });
      const fromChild = yield* harness.call(CHILD, { items: [{ id: "a", status: "done" }] });
      const fromGrandchild = yield* harness.call(GRANDCHILD, {
        items: [{ id: "b", status: "running" }],
      });
      expect(yield* harness.dispatchedTo).toEqual([ROOT, ROOT, ROOT]);
      expect(fromChild).toMatchObject({ threadId: ROOT, total: 3, done: 1, pending: 2 });
      expect(fromGrandchild).toMatchObject({
        threadId: ROOT,
        title: "Fix bugs",
        done: 1,
        running: 1,
        pending: 1,
        message: "1/3 finished, 1 running on the orchestrating thread.",
      });
    }),
  );

  it.effect("keeps a fork's tracker on the fork", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call(FORK, { items: [{ id: "x", status: "done" }] });
      expect(yield* harness.dispatchedTo).toEqual([FORK]);
      expect(result).toMatchObject({
        threadId: FORK,
        title: "Progress",
        message: "All finished, 1/1.",
      });
    }),
  );

  it.effect("stops at a deleted parent and keeps the tracker on the last live thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Ref.update(harness.shells, (byId) => {
        const next = new Map(byId);
        next.set(ROOT, { ...byId.get(ROOT)!, deletedAt: byId.get(ROOT)!.createdAt });
        return next;
      });
      const result = yield* harness.call(GRANDCHILD, { clear: true });
      expect(yield* harness.dispatchedTo).toEqual([CHILD]);
      expect(result).toMatchObject({
        threadId: CHILD,
        total: 0,
        message: "No progress tracker on the orchestrating thread.",
      });
    }),
  );
});
