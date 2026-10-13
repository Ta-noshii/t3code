import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SecretPromptHttp from "./SecretPromptHttp.ts";
import { runSecretPrompt } from "./secretPromptCli.ts";
import * as SecretRequests from "./SecretRequests.ts";

const threadId = ThreadId.make("thread-owner");
const providerInstanceId = ProviderInstanceId.make("codex");

/**
 * Serves the real route on a loopback port with a registry that knows one
 * shell token, and runs the real CLI against it.
 */
const withRoute = <A, E>(
  body: (input: {
    readonly prompt: (args: Array<string>, signal?: AbortSignal) => Effect.Effect<CliResult>;
    readonly asked: Array<SecretRequests.SecretPromptInput>;
    readonly answer: Deferred.Deferred<SecretRequests.SecretPromptOutcome>;
    readonly withdrawn: Deferred.Deferred<void>;
    readonly shown: Deferred.Deferred<void>;
  }) => Effect.Effect<A, E>,
  token = "Bearer shell-good",
) =>
  Effect.gen(function* () {
    const asked: Array<SecretRequests.SecretPromptInput> = [];
    const answer = yield* Deferred.make<SecretRequests.SecretPromptOutcome>();
    const withdrawn = yield* Deferred.make<void>();
    const shown = yield* Deferred.make<void>();
    const layerFakes = Layer.mergeAll(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolveShell: (raw) =>
          Effect.succeed(
            raw === "shell-good"
              ? ({ thread: { threadId, providerInstanceId } } as never)
              : undefined,
          ),
      }),
      Layer.mock(SecretRequests.SecretRequests)({
        prompt: (input) =>
          Effect.sync(() => {
            asked.push(input);
            return {
              turnItemId: TurnItemId.make("turn-item:secret-prompt:1"),
              outcome: Deferred.succeed(shown, undefined).pipe(
                Effect.andThen(Deferred.await(answer)),
              ),
              withdraw: Deferred.succeed(withdrawn, undefined).pipe(Effect.asVoid),
            };
          }),
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(SecretPromptHttp.layer, { disableListenLog: true }).pipe(
        Layer.provide(layerFakes),
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const address = Context.get(services, HttpServer.HttpServer).address;
    assert.isTrue("port" in address);
    const url = "port" in address ? `http://127.0.0.1:${address.port}` : "";
    const prompt = (args: Array<string>, signal?: AbortSignal) =>
      Effect.promise(() => {
        let stdout = "";
        let stderr = "";
        return runSecretPrompt({
          args,
          env: { T3CODE_AGENT_SHELL_URL: url, T3CODE_AGENT_SHELL_AUTHORIZATION: token },
          stdout: {
            write: (chunk, callback) => {
              stdout += chunk;
              callback();
            },
          },
          stderr: { write: (chunk) => (stderr += chunk) },
          ...(signal === undefined ? {} : { signal }),
        }).then((exitCode) => ({ exitCode, stdout, stderr }));
      });
    return yield* body({ prompt, asked, answer, withdrawn, shown });
  }).pipe(Effect.scoped);

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

it.effect("shows the card in the thread the credential names and returns the answer", () =>
  withRoute(({ prompt, asked, answer, withdrawn, shown }) =>
    Effect.gen(function* () {
      const running = yield* Effect.forkChild(
        prompt(["--title", "sudo password", "--description", "pacman -S rg", "--kind", "sudo"]),
      );
      yield* Deferred.await(shown);
      yield* Deferred.succeed(answer, { status: "saved", value: "hunter2" });
      assert.deepEqual(yield* Fiber.join(running), {
        exitCode: 0,
        stdout: "hunter2",
        stderr: "",
      });
      assert.deepEqual(asked, [
        {
          threadId,
          providerInstanceId,
          title: "sudo password",
          description: "pacman -S rg",
          shellPrompt: { kind: "sudo", multiline: false },
        },
      ]);
      // Closing the response after the answer is a no-op withdraw.
      yield* Deferred.await(withdrawn);
    }),
  ),
);

it.effect("withdraws the card when the command goes away", () =>
  withRoute(({ prompt, withdrawn, shown }) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const running = yield* Effect.forkChild(prompt(["--title", "token"], controller.signal));
      yield* Deferred.await(shown);
      controller.abort();
      yield* Deferred.await(withdrawn);
      assert.equal((yield* Fiber.join(running)).exitCode, 1);
    }),
  ),
);

it.effect("refuses a credential it did not issue without showing anything", () =>
  withRoute(
    ({ prompt, asked }) =>
      Effect.gen(function* () {
        const result = yield* prompt(["--title", "token"]);
        assert.equal(result.exitCode, 3);
        assert.include(result.stderr, "no longer valid");
        assert.deepEqual(asked, []);
      }),
    `Bearer ${threadId}`,
  ),
);
