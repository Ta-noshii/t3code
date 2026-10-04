import type { OrchestrationV2GetThreadRecapResult, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

export class ThreadRecapError extends Schema.TaggedError<ThreadRecapError>()("ThreadRecapError", {
  threadId: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Failed to recap thread ${this.threadId}.`;
  }
}

const UNAVAILABLE: OrchestrationV2GetThreadRecapResult = { available: false, recap: null };

export interface ThreadRecapServiceV2Shape {
  /**
   * A one-line summary of where the thread stands after `runId`, from the
   * provider that owns its conversation. Unavailable when that run is not the
   * thread's latest completed one, or when the provider cannot recap.
   */
  readonly getThreadRecap: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<OrchestrationV2GetThreadRecapResult, ThreadRecapError>;
}

export class ThreadRecapServiceV2 extends Context.Service<
  ThreadRecapServiceV2,
  ThreadRecapServiceV2Shape
>()("t3/orchestration-v2/ThreadRecapService/ThreadRecapServiceV2") {}

export const layer = Layer.effect(
  ThreadRecapServiceV2,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;

    return ThreadRecapServiceV2.of({
      getThreadRecap: (input) =>
        Effect.gen(function* () {
          const records = yield* projections.getThreadRecords(input.threadId, [
            "runs",
            "providerThreads",
          ]);
          const latestRun = records.runs.reduce<(typeof records.runs)[number] | undefined>(
            (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
            undefined,
          );
          if (latestRun?.id !== input.runId || latestRun.status !== "completed") {
            return UNAVAILABLE;
          }
          const providerThread = records.providerThreads.find(
            (candidate) => candidate.id === latestRun.providerThreadId,
          );
          if (providerThread === undefined) return UNAVAILABLE;
          const adapter = yield* adapters.get(providerThread.providerInstanceId);
          if (adapter.readThreadRecap === undefined) return UNAVAILABLE;
          const policy = yield* runtimePolicy.resolve({
            thread: records.thread,
            modelSelection: latestRun.modelSelection,
          });
          const recap = yield* adapter.readThreadRecap({
            threadId: input.threadId,
            providerThread,
            modelSelection: latestRun.modelSelection,
            cwd: policy.cwd,
          });
          return { available: true, recap };
        }).pipe(
          Effect.mapError((cause) => new ThreadRecapError({ threadId: input.threadId, cause })),
        ),
    });
  }),
);
