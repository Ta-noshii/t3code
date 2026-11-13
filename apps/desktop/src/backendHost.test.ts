// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Runs the real host process against a fake server.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, describe, it } from "@effect/vitest";

import type { BackendHostLaunch, BackendHostRecord } from "./backendHost.ts";

const HOST_SCRIPT = NodePath.join(import.meta.dirname, "backendHost.ts");

// Echoes telemetry into control lines, reports an active turn, and logs browser events to a file.
const FAKE_SERVER = `
const fs = require("node:fs");
const net = require("node:net");
const pipe = (fd) => new net.Socket({ fd, readable: true, writable: true });
const bootstrap = fs.readFileSync(3, "utf8");
fs.writeFileSync(process.env.FAKE_DIR + "/bootstrap", bootstrap);
const control = pipe(5);
const commands = pipe(7);
commands.write(JSON.stringify({ type: "turn", threadId: "thread-1", active: true }) + "\\n");
commands.write(JSON.stringify({ type: "turn", threadId: "thread-2", active: true }) + "\\n");
commands.write(JSON.stringify({ type: "turn", threadId: "thread-2", active: false }) + "\\n");
let pending = "";
pipe(4).on("data", (chunk) => {
  pending += chunk;
  const lines = pending.split("\\n");
  pending = lines.pop();
  for (const line of lines) {
    const hello = JSON.parse(line);
    control.write(JSON.stringify({ type: "setDiagnosticsDemand", demand: hello.demand }) + "\\n");
  }
});
pipe(6).on("data", (chunk) => {
  fs.appendFileSync(process.env.FAKE_DIR + "/browser", chunk);
});
process.stdout.write("server ready\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;

interface Client {
  readonly lines: string[];
  readonly next: (tag: string) => Promise<string>;
  readonly send: (line: string) => void;
  readonly close: () => Promise<void>;
  readonly closed: Promise<void>;
}

const connect = (socketPath: string) =>
  new Promise<Client>((resolve, reject) => {
    const socket = NodeNet.createConnection(socketPath);
    const lines: string[] = [];
    const waiters: Array<{ tag: string; resolve: (payload: string) => void }> = [];
    let pending = "";
    const closed = new Promise<void>((done) => socket.on("close", () => done()));
    socket.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line);
        const space = line.indexOf(" ");
        const tag = line.slice(0, space);
        const index = waiters.findIndex((waiter) => waiter.tag === tag);
        if (index !== -1) waiters.splice(index, 1)[0]!.resolve(line.slice(space + 1));
      }
    });
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        lines,
        closed,
        next: (tag) => {
          const seen = lines.findIndex((line) => line.startsWith(`${tag} `));
          if (seen !== -1) {
            const [line] = lines.splice(seen, 1);
            return Promise.resolve(line!.slice(tag.length + 1));
          }
          return new Promise((resolvePayload) => waiters.push({ tag, resolve: resolvePayload }));
        },
        send: (line) => socket.write(`${line}\n`),
        close: () => {
          socket.end();
          return closed;
        },
      }),
    );
  });

/** Resolves once the file's text passes `predicate`, re-reading whenever its directory changes. */
const waitForFile = (path: string, predicate: (text: string) => boolean) =>
  new Promise<string>((resolve) => {
    const read = () => (NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : "");
    const check = () => {
      const text = read();
      if (!predicate(text)) return;
      watcher.close();
      resolve(text);
    };
    const watcher = NodeFS.watch(NodePath.dirname(path), check);
    check();
  });

const startHost = (dir: string, hostEnv: Record<string, string> = {}) => {
  const serverScript = NodePath.join(dir, "server.cjs");
  NodeFS.writeFileSync(serverScript, FAKE_SERVER);
  const launch: BackendHostLaunch = {
    socketPath: NodePath.join(dir, "host.sock"),
    recordPath: NodePath.join(dir, "host.json"),
    stateDir: dir,
    logPath: NodePath.join(dir, "host.log"),
    runtimeKey: "runtime-a",
    runtimeDir: dir,
    appVersion: "0.0.0-test",
    port: 4321,
    bootstrapSecret: "secret",
    bootstrapLine: JSON.stringify({ port: 4321 }),
    server: {
      command: process.execPath,
      args: [serverScript],
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", FAKE_DIR: dir },
    },
  };
  const host = NodeChildProcess.spawn(process.execPath, [HOST_SCRIPT, "--host"], {
    stdio: ["pipe", "inherit", "inherit"],
    env: { ...process.env, ...hostEnv },
  });
  host.stdin.end(JSON.stringify(launch));
  const exited = new Promise<number | null>((resolve) => host.on("exit", (code) => resolve(code)));
  return { launch, host, exited };
};

describe("backendHost", () => {
  it("keeps the server across app disconnects and replays its state to the next app", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-backend-host-"));
    const { launch, host, exited } = startHost(dir);
    try {
      // The host writes its record once its socket listens.
      const record = JSON.parse(
        await waitForFile(launch.recordPath, (text) => text.length > 0),
      ) as BackendHostRecord;
      const first = await connect(launch.socketPath);
      const hello = JSON.parse(await first.next("hello")) as { serverPid: number };
      assert.strictEqual(record.hostPid, host.pid);
      assert.strictEqual(record.serverPid, hello.serverPid);
      assert.strictEqual(record.bootstrapSecret, "secret");
      assert.strictEqual(
        await waitForFile(NodePath.join(dir, "bootstrap"), (text) => text.endsWith("\n")),
        `${launch.bootstrapLine}\n`,
      );

      first.send(`t ${JSON.stringify({ demand: "high" })}`);
      assert.include(await first.next("c"), '"demand":"high"');
      first.send(`b ${JSON.stringify({ type: "attached", threadId: "thread-1", tabId: "tab-1" })}`);
      await waitForFile(NodePath.join(dir, "browser"), (text) => text.includes("attached"));
      await first.close();

      // The app went away: its tab is released and the server keeps running.
      const browser = await waitForFile(NodePath.join(dir, "browser"), (text) =>
        text.includes("detached"),
      );
      assert.include(browser, '{"type":"detached","threadId":"thread-1","tabId":"tab-1"}');
      assert.isTrue(NodeFS.existsSync(`/proc/${hello.serverPid}`));

      const second = await connect(launch.socketPath);
      const secondHello = JSON.parse(await second.next("hello")) as { serverPid: number };
      assert.strictEqual(secondHello.serverPid, hello.serverPid);
      assert.include(await second.next("c"), '"demand":"high"');
      const turn = await second.next("k");
      assert.include(turn, '"threadId":"thread-1"');
      assert.notInclude(second.lines.join("\n"), "thread-2");

      second.send("stop");
      assert.deepStrictEqual(JSON.parse(await second.next("x")), { code: 0, signal: null });
      assert.strictEqual(await exited, 0);
      assert.isFalse(NodeFS.existsSync(launch.recordPath));
    } finally {
      if (host.exitCode === null) host.kill("SIGTERM");
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops the server once no app is connected and no thread is busy", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-backend-host-"));
    const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "statev2.sqlite"));
    db.exec(`
      CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT);
      CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT);
      INSERT INTO orchestration_v2_projection_runs VALUES ('done', 'completed');
    `);
    db.close();
    const { launch, host, exited } = startHost(dir, { T3CODE_BACKEND_HOST_IDLE_CHECK_MS: "20" });
    try {
      assert.strictEqual(await exited, 0);
      assert.include(NodeFS.readFileSync(launch.logPath, "utf8"), "no app and no busy threads");
    } finally {
      if (host.exitCode === null) host.kill("SIGTERM");
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
