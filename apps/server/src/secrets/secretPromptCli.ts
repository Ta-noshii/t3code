// A fast path before the CLI graph loads, so it uses Node's http client and
// plain JSON rather than Effect services.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off
import * as NodeHttp from "node:http";

/**
 * `t3 secret prompt` - asks the user for a secret through a card in the
 * thread whose agent shell runs it, and prints the answer.
 *
 * Exit codes: 0 saved (value on stdout, no newline added), 1 declined, timed
 * out, withdrawn or stopped, 2 bad arguments, 3 T3 cannot show the card here
 * (not an agent shell, server unreachable, no running turn). Callers fall back
 * to another prompt on 3. Ending the process withdraws the card.
 */

const SECRET_PROMPT_ROUTE = "/api/agent-shell/secret-prompt";
const URL_ENV = "T3CODE_AGENT_SHELL_URL";
const AUTHORIZATION_ENV = "T3CODE_AGENT_SHELL_AUTHORIZATION";
/** How long the server may take to put the card in the thread. */
const DEFAULT_SHOWN_TIMEOUT_MS = 2_500;

export const SECRET_PROMPT_USAGE =
  "Usage: t3 secret prompt --title TITLE [--description TEXT] [--kind sudo|secret] [--multiline]\n";

export interface SecretPromptArgs {
  readonly title: string;
  readonly description?: string;
  readonly kind: "sudo" | "secret";
  readonly multiline: boolean;
}

/** Parses the arguments after `secret prompt`; `--flag value` and `--flag=value` both work. */
export function parseSecretPromptArgs(
  args: ReadonlyArray<string>,
): SecretPromptArgs | { readonly error: string } {
  let title: string | undefined;
  let description: string | undefined;
  let kind: "sudo" | "secret" = "secret";
  let multiline = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.indexOf("=");
    const name = arg.startsWith("--") && equals > 0 ? arg.slice(0, equals) : arg;
    const takeValue = () => {
      if (equals > 0 && arg.startsWith("--")) return arg.slice(equals + 1);
      index += 1;
      return args[index];
    };
    switch (name) {
      case "--title":
        title = takeValue();
        break;
      case "--description":
        description = takeValue();
        break;
      case "--kind": {
        const value = takeValue();
        if (value !== "sudo" && value !== "secret") return { error: "--kind is sudo or secret." };
        kind = value;
        break;
      }
      case "--multiline":
        multiline = true;
        break;
      default:
        return { error: `Unknown argument: ${arg}` };
    }
  }
  if (title === undefined || title.trim().length === 0) return { error: "--title is required." };
  return { title, ...(description === undefined ? {} : { description }), kind, multiline };
}

export interface SecretPromptRunOptions {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: { write(chunk: string, callback: () => void): unknown };
  readonly stderr: { write(chunk: string): unknown };
  /** Aborting closes the connection, which withdraws the card. */
  readonly signal?: AbortSignal;
  readonly shownTimeoutMs?: number;
}

type ServerLine =
  | { readonly status: "shown" }
  | { readonly status: "saved"; readonly value: string }
  | { readonly status: "declined" | "cancelled" | "timed_out" }
  | { readonly status: "error"; readonly error: string };

const parseLine = (line: string): ServerLine | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && "status" in value
      ? (value as ServerLine)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Runs one prompt and resolves with the exit code; the value goes only to `stdout`. */
export function runSecretPrompt(options: SecretPromptRunOptions): Promise<number> {
  const parsed = parseSecretPromptArgs(options.args);
  if ("error" in parsed) {
    options.stderr.write(`${parsed.error}\n${SECRET_PROMPT_USAGE}`);
    return Promise.resolve(2);
  }
  const base = options.env[URL_ENV]?.trim();
  const authorization = options.env[AUTHORIZATION_ENV]?.trim();
  if (!base || !authorization) {
    options.stderr.write("t3 secret prompt: not running in a T3 agent shell.\n");
    return Promise.resolve(3);
  }
  let url: URL;
  try {
    url = new URL(SECRET_PROMPT_ROUTE, base);
  } catch {
    options.stderr.write(`t3 secret prompt: ${URL_ENV} is not a URL.\n`);
    return Promise.resolve(3);
  }
  const body = JSON.stringify({
    title: parsed.title,
    ...(parsed.description === undefined ? {} : { description: parsed.description }),
    kind: parsed.kind,
    multiline: parsed.multiline,
  });

  return new Promise((resolve) => {
    let settled = false;
    let shown = false;
    const finish = (code: number, message?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(shownTimer);
      options.signal?.removeEventListener("abort", onAbort);
      request.destroy();
      if (message !== undefined) options.stderr.write(`t3 secret prompt: ${message}\n`);
      resolve(code);
    };
    const onAbort = () => finish(1);
    const request = NodeHttp.request(url, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    });
    const shownTimer = setTimeout(
      () => finish(3, "T3 did not show the prompt in time."),
      options.shownTimeoutMs ?? DEFAULT_SHOWN_TIMEOUT_MS,
    );
    if (options.signal?.aborted) {
      finish(1);
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    request.on("error", () =>
      finish(3, shown ? "lost the connection to T3." : "could not reach T3."),
    );
    request.on("response", (response) => {
      response.setEncoding("utf8");
      let buffered = "";
      const handle = (line: ServerLine | undefined) => {
        if (line === undefined) return finish(3, "T3 sent an unexpected reply.");
        switch (line.status) {
          case "shown":
            shown = true;
            clearTimeout(shownTimer);
            return;
          case "saved":
            settled = true;
            clearTimeout(shownTimer);
            options.signal?.removeEventListener("abort", onAbort);
            request.destroy();
            options.stdout.write(line.value, () => resolve(0));
            return;
          case "declined":
          case "cancelled":
          case "timed_out":
            return finish(1);
          case "error":
            return finish(response.statusCode === 400 ? 2 : 3, line.error);
        }
      };
      response.on("data", (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (settled) return;
          if (line.trim().length > 0) handle(parseLine(line));
        }
      });
      response.on("end", () =>
        finish(3, shown ? "lost the connection to T3." : "T3 closed the request."),
      );
      response.on("error", () => finish(3, "lost the connection to T3."));
    });
    request.end(body);
  });
}

const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
const PARENT_CHECK_INTERVAL_MS = 1_000;

/** `t3 secret ...` before the CLI graph loads. Ends the process with the prompt's exit code. */
export async function runSecretCliFastPath(args: ReadonlyArray<string>): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand !== "prompt") {
    process.stderr.write(SECRET_PROMPT_USAGE);
    process.exitCode = 2;
    return;
  }
  const controller = new AbortController();
  let exitOverride: number | undefined;
  const onSignal = (signal: keyof typeof SIGNAL_EXIT_CODES) => () => {
    exitOverride = SIGNAL_EXIT_CODES[signal];
    controller.abort();
  };
  const handlers = Object.keys(SIGNAL_EXIT_CODES).map((signal) => {
    const handler = onSignal(signal as keyof typeof SIGNAL_EXIT_CODES);
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  // A caller that dies without signalling leaves this process to its init;
  // the card must not outlive the caller.
  const parent = process.ppid;
  const parentWatch = setInterval(() => {
    if (process.ppid !== parent) controller.abort();
  }, PARENT_CHECK_INTERVAL_MS);
  const code = await runSecretPrompt({
    args: rest,
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
    signal: controller.signal,
  });
  clearInterval(parentWatch);
  for (const [signal, handler] of handlers) process.off(signal, handler);
  process.exitCode = exitOverride ?? code;
}
