import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-shell");
const codex = ProviderInstanceId.make("codex");

type RecordCommand = Extract<OrchestrationV2ServerCommand, { type: "secret_request.record" }>;

/**
 * Runs `body` against the service with a thread whose run is active. Recorded
 * cards land in the thread like the orchestrator would put them there: an
 * answered card keeps its answer.
 */
const withService = <A, E>(
  body: (input: {
    readonly service: SecretRequests.SecretRequests["Service"];
    readonly stored: Map<string, Uint8Array>;
    readonly records: Array<RecordCommand>;
  }) => Effect.Effect<A, E>,
  options: { readonly runStatus?: string } = {},
) =>
  Effect.gen(function* () {
    const stored = new Map<string, Uint8Array>();
    const records: Array<RecordCommand> = [];
    const cards = new Map<string, Record<string, unknown>>();
    const layerDependencies = Layer.mergeAll(
      NodeCrypto.layer,
      NodeServices.layer,
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
        set: (name, value) => Effect.sync(() => void stored.set(name, value)),
        create: (name, value) => Effect.sync(() => void stored.set(name, value)),
        getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes).fill(7)),
        remove: (name) => Effect.sync(() => void stored.delete(name)),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId: ProjectId.make("project-1") },
            runs: [
              {
                id: "run-1",
                ordinal: 1,
                status: options.runStatus ?? "running",
                rootNodeId: "node-root",
                providerInstanceId: codex,
              },
            ],
            turnItems: Array.from(cards.values()),
          } as never),
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type !== "secret_request.record") return {} as never;
            records.push(command);
            const existing = cards.get(command.turnItemId);
            if (existing === undefined || existing.secretStatus === "pending") {
              cards.set(command.turnItemId, {
                id: command.turnItemId,
                threadId: command.threadId,
                runId: command.runId,
                nodeId: command.nodeId,
                type: "secret_request",
                label: command.label,
                reason: command.reason,
                shellPrompt: command.shellPrompt,
                secretStatus: command.secretStatus,
              });
            }
            return {} as never;
          }),
      }),
    );
    return yield* Effect.gen(function* () {
      const service = yield* SecretRequests.SecretRequests;
      return yield* body({ service, stored, records });
    }).pipe(Effect.provide(SecretRequests.layer.pipe(Layer.provide(layerDependencies))));
  });

const sudoPrompt = {
  threadId,
  providerInstanceId: codex,
  title: "sudo password",
  description: "pacman -S ripgrep",
  shellPrompt: { kind: "sudo", multiline: false },
} as const;

it.effect("a saved answer reaches the waiting command and nothing else", () =>
  withService(({ service, stored, records }) =>
    Effect.gen(function* () {
      const { turnItemId, outcome } = yield* service.prompt(sudoPrompt);
      assert.deepInclude(records[0], {
        secretStatus: "pending",
        turnItemId,
        label: "sudo password",
        reason: "pacman -S ripgrep",
        shellPrompt: { kind: "sudo", multiline: false },
      });
      // Typed as is: a password can end in a space.
      yield* service.answer({
        threadId,
        turnItemId,
        answer: { type: "save", secret: "hunter2 " },
      });
      assert.deepEqual(yield* outcome, { status: "saved", value: "hunter2 " });
      assert.deepEqual(
        records.map((record) => record.secretStatus),
        ["pending", "saved"],
      );
      assert.notInclude(JSON.stringify(records), "hunter2");
      assert.equal(stored.size, 0);
      assert.isTrue(Option.isNone(yield* service.savedRef({ threadId, turnItemId })));
    }),
  ),
);

it.effect("a denied prompt tells the command and records only the denial", () =>
  withService(({ service, records }) =>
    Effect.gen(function* () {
      const { turnItemId, outcome } = yield* service.prompt(sudoPrompt);
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      assert.deepEqual(yield* outcome, { status: "declined" });
      assert.equal(records.at(-1)?.secretStatus, "declined");
    }),
  ),
);

it.effect("a withdrawn prompt ends its card, and a later answer is refused", () =>
  withService(({ service, records }) =>
    Effect.gen(function* () {
      const { turnItemId, withdraw } = yield* service.prompt(sudoPrompt);
      yield* withdraw;
      yield* withdraw;
      assert.deepEqual(
        records.map((record) => record.secretStatus),
        ["pending", "cancelled"],
      );
      const error = yield* service
        .answer({ threadId, turnItemId, answer: { type: "save", secret: "late" } })
        .pipe(Effect.flip);
      assert.equal(error.reason, "already_answered");
    }),
  ),
);

it.effect("an unanswered prompt times out and ends its card", () =>
  withService(({ service, records }) =>
    Effect.gen(function* () {
      const { outcome } = yield* service.prompt({ ...sudoPrompt, timeoutMs: 1_000 });
      const waiting = yield* Effect.forkChild(outcome);
      yield* TestClock.adjust(1_000);
      assert.deepEqual(yield* Fiber.join(waiting), { status: "timed_out" });
      assert.equal(records.at(-1)?.secretStatus, "cancelled");
    }),
  ),
);

it.effect("a prompt needs a running turn of the provider whose shell asked", () =>
  Effect.gen(function* () {
    const otherProvider = yield* withService(({ service }) =>
      service
        .prompt({ ...sudoPrompt, providerInstanceId: ProviderInstanceId.make("claude") })
        .pipe(Effect.flip),
    );
    assert.equal(otherProvider.reason, "no_active_run");
    const finished = yield* withService(
      ({ service }) => service.prompt(sudoPrompt).pipe(Effect.flip),
      { runStatus: "completed" },
    );
    assert.equal(finished.reason, "no_active_run");
  }),
);
