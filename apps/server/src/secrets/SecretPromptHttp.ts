/**
 * SecretPromptHttp - the local route behind `t3 secret prompt`.
 *
 * A process in an agent's shell presents the shell credential its provider
 * session carries (`T3CODE_AGENT_SHELL_AUTHORIZATION`); the credential names
 * the thread, so a caller cannot pick one. The response is NDJSON: a `shown`
 * line once the card is in the thread, then one line with the outcome. The
 * value travels only in that last line. Closing the connection withdraws the
 * card.
 *
 * @module SecretPromptHttp
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SecretRequests from "./SecretRequests.ts";

export const SECRET_PROMPT_ROUTE = "/api/agent-shell/secret-prompt";

const SecretPromptBody = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  kind: Schema.optional(Schema.Literals(["sudo", "secret"])),
  multiline: Schema.optional(Schema.Boolean),
});
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(SecretPromptBody));
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const MAX_BODY_BYTES = 16 * 1024;

const isLoopbackAddress = (address: string | undefined) =>
  address !== undefined && (address === "::1" || address.startsWith("127."));

const jsonError = (status: number, error: string) =>
  HttpServerResponse.text(`${encodeLine({ status: "error", error })}\n`, {
    status,
    contentType: "application/x-ndjson",
    headers: { "cache-control": "no-store" },
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const secretRequests = yield* SecretRequests.SecretRequests;

  // Agent shells run on this host. A proxy that forwards from loopback still
  // has to present the credential.
  if (!isLoopbackAddress(deriveAuthClientMetadata({ request }).ipAddress)) {
    return jsonError(403, "Secret prompts are only accepted from this machine.");
  }
  const authorization = request.headers.authorization;
  const token =
    authorization?.startsWith("Bearer ") === true
      ? authorization.slice("Bearer ".length).trim()
      : "";
  const scope = yield* registry.resolveShell(token);
  if (scope === undefined) {
    return jsonError(401, "This shell's T3 credential is missing or no longer valid.");
  }
  const text = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  if (text.length > MAX_BODY_BYTES) return jsonError(413, "The prompt is too long.");
  const body = yield* decodeBody(text).pipe(Effect.option);
  if (Option.isNone(body)) return jsonError(400, "The prompt needs a title.");

  const prompt = yield* secretRequests
    .prompt({
      threadId: scope.thread.threadId,
      providerInstanceId: scope.thread.providerInstanceId,
      title: body.value.title.trim() || "Secret",
      description: body.value.description?.trim() ?? "",
      shellPrompt: {
        kind: body.value.kind ?? "secret",
        multiline: body.value.multiline ?? false,
      },
    })
    .pipe(Effect.option);
  if (Option.isNone(prompt)) {
    return jsonError(409, "The thread has no running turn to show the prompt in.");
  }
  const { outcome, withdraw } = prompt.value;
  const lines = Stream.make(`${encodeLine({ status: "shown" })}\n`).pipe(
    Stream.concat(Stream.fromEffect(Effect.map(outcome, (result) => `${encodeLine(result)}\n`))),
    // Runs when the outcome line is written and when the caller hangs up first.
    Stream.ensuring(withdraw),
    Stream.encodeText,
  );
  return HttpServerResponse.stream(lines, {
    contentType: "application/x-ndjson",
    headers: { "cache-control": "no-store" },
  });
}).pipe(Effect.withSpan("SecretPromptHttp.prompt"));

export const layer = HttpRouter.add("POST", SECRET_PROMPT_ROUTE, handler);
