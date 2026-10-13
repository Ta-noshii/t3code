// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { parseSecretPromptArgs, runSecretPrompt } from "./secretPromptCli.ts";

const servers: Array<NodeHttp.Server> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** A stand-in for the T3 route; `reply` gets the request and writes the NDJSON answer. */
const serve = async (
  reply: (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    body: string,
  ) => void,
) => {
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (body += chunk));
    request.on("end", () => reply(request, response, body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
};

const run = (url: string | undefined, args: Array<string>, signal?: AbortSignal) => {
  let stdout = "";
  let stderr = "";
  const code = runSecretPrompt({
    args,
    env:
      url === undefined
        ? {}
        : { T3CODE_AGENT_SHELL_URL: url, T3CODE_AGENT_SHELL_AUTHORIZATION: "Bearer shell-token" },
    stdout: {
      write: (chunk, callback) => {
        stdout += chunk;
        callback();
      },
    },
    stderr: { write: (chunk) => (stderr += chunk) },
    ...(signal === undefined ? {} : { signal }),
    shownTimeoutMs: 300,
  });
  return code.then((exitCode) => ({ exitCode, stdout, stderr }));
};

const ndjson = (response: NodeHttp.ServerResponse, ...lines: Array<object>) => {
  response.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const line of lines) response.write(`${JSON.stringify(line)}\n`);
};

describe("t3 secret prompt", () => {
  it("prints a saved value exactly and exits 0", async () => {
    let seen: Record<string, unknown> = {};
    const url = await serve((request, response, body) => {
      seen = {
        authorization: request.headers.authorization,
        body: JSON.parse(body),
        encoding: request.headers["accept-encoding"],
      };
      ndjson(response, { status: "shown" }, { status: "saved", value: "line one\nline two " });
      response.end();
    });
    const result = await run(url, [
      "--title",
      "Deploy key",
      "--description=For the staging box",
      "--multiline",
    ]);
    expect(result).toEqual({ exitCode: 0, stdout: "line one\nline two ", stderr: "" });
    expect(seen).toEqual({
      authorization: "Bearer shell-token",
      body: {
        title: "Deploy key",
        description: "For the staging box",
        kind: "secret",
        multiline: true,
      },
      // A compressed stream would hold back the shown line.
      encoding: undefined,
    });
  });

  it("exits 1 with nothing on stdout when the user denies", async () => {
    const url = await serve((_request, response) => {
      ndjson(response, { status: "shown" }, { status: "declined" });
      response.end();
    });
    expect(await run(url, ["--title", "sudo", "--kind", "sudo"])).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "",
    });
  });

  it("exits 3 at once when it is not in an agent shell or T3 is not listening", async () => {
    expect((await run(undefined, ["--title", "x"])).exitCode).toBe(3);
    const closed = await serve(() => {});
    servers[0]!.close();
    servers[0]!.closeAllConnections();
    const started = Date.now();
    const result = await run(closed, ["--title", "x"]);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("could not reach T3");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("exits 3 when the thread cannot take the card or the card never shows", async () => {
    const refused = await serve((_request, response) => {
      response.writeHead(409, { "content-type": "application/x-ndjson" });
      response.end(`${JSON.stringify({ status: "error", error: "No running turn." })}\n`);
    });
    expect(await run(refused, ["--title", "x"])).toMatchObject({
      exitCode: 3,
      stderr: "t3 secret prompt: No running turn.\n",
    });
    const silent = await serve(() => {});
    expect(await run(silent, ["--title", "x"])).toMatchObject({ exitCode: 3, stdout: "" });
  });

  it("hangs up when stopped, which is how the server withdraws the card", async () => {
    let hungUp: () => void = () => {};
    let asked: () => void = () => {};
    const closedByClient = new Promise<void>((resolve) => (hungUp = resolve));
    const shown = new Promise<void>((resolve) => (asked = resolve));
    const url = await serve((request, response) => {
      request.socket.on("close", hungUp);
      ndjson(response, { status: "shown" });
      asked();
    });
    const controller = new AbortController();
    const result = run(url, ["--title", "x"], controller.signal);
    await shown;
    controller.abort();
    expect(await result).toEqual({ exitCode: 1, stdout: "", stderr: "" });
    await closedByClient;
  });

  it("rejects bad arguments with exit 2", async () => {
    expect(parseSecretPromptArgs([])).toEqual({ error: "--title is required." });
    expect(parseSecretPromptArgs(["--title", "x", "--kind", "root"])).toEqual({
      error: "--kind is sudo or secret.",
    });
    expect((await run("http://127.0.0.1:1", ["--title", "x", "--nope"])).exitCode).toBe(2);
  });
});
