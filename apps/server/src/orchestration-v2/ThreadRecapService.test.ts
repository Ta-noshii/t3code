import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadRecapService from "./ThreadRecapService.ts";

const threadId = ThreadId.make("thread-recap");
const instanceId = ProviderInstanceId.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread-recap");
const modelSelection = {
  instanceId,
  model: "claude-opus-4-6",
} as OrchestrationV2Run["modelSelection"];

const run = (ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({
    id: RunId.make(`run-${ordinal}`),
    ordinal,
    status,
    providerThreadId,
    modelSelection,
  }) as OrchestrationV2Run;

const recapLayer = (input: {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly readThreadRecap?: ProviderAdapter.ProviderAdapterV2Shape["readThreadRecap"];
}) =>
  ThreadRecapService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId } as OrchestrationV2AppThread,
              runs: input.runs,
              providerThreads: [
                {
                  id: providerThreadId,
                  providerInstanceId: instanceId,
                } as OrchestrationV2ProviderThread,
              ],
            }),
        } as unknown as ProjectionStore.ProjectionStoreV2Shape),
        Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
          get: () =>
            Effect.succeed(
              (input.readThreadRecap === undefined
                ? {}
                : {
                    readThreadRecap: input.readThreadRecap,
                  }) as ProviderAdapter.ProviderAdapterV2Shape,
            ),
          list: () => Effect.succeed([instanceId]),
        }),
        Layer.succeed(RuntimePolicy.RuntimePolicyV2, {
          resolve: () =>
            Effect.succeed({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            }),
        }),
      ),
    ),
  );

it.effect("recaps the latest completed run through the provider that owns its thread", () => {
  const requests: Array<ProviderAdapter.ProviderAdapterV2ReadThreadRecapInput> = [];
  return Effect.gen(function* () {
    const service = yield* ThreadRecapService.ThreadRecapServiceV2;
    const result = yield* service.getThreadRecap({ threadId, runId: RunId.make("run-2") });
    assert.deepEqual(result, { available: true, recap: "Shipped the fix." });
    assert.equal(requests[0]?.providerThread.id, providerThreadId);
    assert.equal(requests[0]?.cwd, "/workspace");
  }).pipe(
    Effect.provide(
      recapLayer({
        runs: [run(1, "completed"), run(2, "completed")],
        readThreadRecap: (request) =>
          Effect.sync(() => {
            requests.push(request);
            return "Shipped the fix.";
          }),
      }),
    ),
  );
});

it.effect("offers no recap for a stale or unfinished run, or a provider without recaps", () =>
  Effect.gen(function* () {
    const recap = (runs: ReadonlyArray<OrchestrationV2Run>, withRecap: boolean, runId: string) =>
      Effect.gen(function* () {
        const service = yield* ThreadRecapService.ThreadRecapServiceV2;
        return yield* service.getThreadRecap({ threadId, runId: RunId.make(runId) });
      }).pipe(
        Effect.provide(
          recapLayer({
            runs,
            ...(withRecap ? { readThreadRecap: () => Effect.die("must not recap") } : {}),
          }),
        ),
      );
    const unavailable = { available: false, recap: null };
    assert.deepEqual(
      yield* recap([run(1, "completed"), run(2, "completed")], true, "run-1"),
      unavailable,
    );
    assert.deepEqual(yield* recap([run(1, "running")], true, "run-1"), unavailable);
    assert.deepEqual(yield* recap([run(1, "completed")], false, "run-1"), unavailable);
  }),
);
