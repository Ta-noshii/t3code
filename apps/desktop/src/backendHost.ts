// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - A standalone daemon with no Effect runtime.
/**
 * Owns the desktop's local server and its fds 3-7 so the server outlives the app. The app talks to
 * it over a unix socket, one `<tag> <payload>` line per message (tags at `host`). `--launch` re-spawns
 * the host in its own session and systemd scope, then exits, so the host is never the app's child.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { countBusyThreads } from "./backend/busyThreads.ts";

export interface BackendHostLaunch {
  readonly socketPath: string;
  readonly recordPath: string;
  /** Where the server keeps statev2.sqlite; the host reads it to tell when threads are idle. */
  readonly stateDir: string;
  readonly logPath: string;
  readonly runtimeKey: string;
  readonly runtimeDir: string;
  readonly appVersion: string;
  readonly port: number;
  readonly bootstrapSecret: string;
  readonly bootstrapLine: string;
  readonly server: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Record<string, string>;
  };
}

export interface BackendHostRecord {
  readonly version: 1;
  readonly hostPid: number;
  readonly serverPid: number;
  readonly socketPath: string;
  readonly runtimeKey: string;
  readonly runtimeDir: string;
  readonly appVersion: string;
  readonly port: number;
  readonly bootstrapSecret: string;
  readonly startedAt: string;
}

const TERMINATE_GRACE_MS = 5_000;
// With no app connected, the server stops after this many idle checks in a row.
const IDLE_CHECK_MS = Number(process.env.T3CODE_BACKEND_HOST_IDLE_CHECK_MS) || 30_000;
const IDLE_CHECKS_TO_STOP = 2;
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;

const readStdin = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });

const hasSystemdRun = (): boolean => {
  try {
    NodeChildProcess.execFileSync("systemd-run", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** First stage: put the host in its own session and scope, hand it the launch JSON, and exit. */
const launch = async () => {
  const launchJson = await readStdin();
  const launchConfig = JSON.parse(launchJson) as BackendHostLaunch;
  const self = [__filename, "--host"];
  const scopeUnit = `t3code-backend-${process.pid}-${Date.now()}`;
  const [command, args] = hasSystemdRun()
    ? ([
        "systemd-run",
        [
          "--user",
          "--scope",
          "--collect",
          "--quiet",
          `--unit=${scopeUnit}`,
          "--",
          process.execPath,
          ...self,
        ],
      ] as const)
    : ([process.execPath, self] as const);
  NodeFS.mkdirSync(NodePath.dirname(launchConfig.logPath), { recursive: true });
  const log = NodeFS.openSync(launchConfig.logPath, "a", 0o600);
  const child = NodeChildProcess.spawn(command, args, {
    detached: true,
    stdio: ["pipe", log, log],
    env: process.env,
    cwd: launchConfig.server.cwd,
  });
  child.on("error", (error) => {
    process.stderr.write(`backend host launch failed: ${error.message}\n`);
    process.exit(1);
  });
  if (child.stdin === null) process.exit(1);
  child.stdin.end(launchJson, () => {
    child.unref();
    process.exit(0);
  });
};

const writeRecord = (path: string, record: BackendHostRecord) => {
  const temporary = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, path);
};

const removeOwnRecord = (path: string) => {
  try {
    const record = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Partial<BackendHostRecord>;
    if (record.hostPid === process.pid) NodeFS.rmSync(path, { force: true });
  } catch {}
};

/** Splits a byte stream into complete lines. */
const lineSplitter = (onLine: (line: string) => void) => {
  let pending = "";
  return (chunk: Buffer | string) => {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = pending.indexOf("\n");
    while (index !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.length > 0) onLine(line);
      index = pending.indexOf("\n");
    }
  };
};

const parseJson = (line: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const host = async () => {
  const launchConfig = JSON.parse(await readStdin()) as BackendHostLaunch;
  process.on("SIGHUP", () => {});
  process.on("SIGPIPE", () => {});

  let logBytes = 0;
  try {
    logBytes = NodeFS.statSync(launchConfig.logPath).size;
  } catch {}
  const writeLog = (text: string) => {
    if (logBytes > LOG_LIMIT_BYTES) return;
    logBytes += Buffer.byteLength(text);
    try {
      NodeFS.appendFileSync(launchConfig.logPath, text);
    } catch {}
  };
  writeLog(`[${new Date().toISOString()}] backend host ${process.pid} starting\n`);

  const server = NodeChildProcess.spawn(launchConfig.server.command, launchConfig.server.args, {
    cwd: launchConfig.server.cwd,
    env: launchConfig.server.env,
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  const fd = (index: number) => server.stdio[index] as NodeNet.Socket;
  const bootstrapPipe = fd(3);
  const telemetryIn = fd(4);
  const telemetryControl = fd(5);
  const browserIn = fd(6);
  const browserCommands = fd(7);
  for (const pipe of [bootstrapPipe, telemetryIn, browserIn]) pipe.on("error", () => {});
  bootstrapPipe.end(`${launchConfig.bootstrapLine}\n`);

  // From the app: `t` telemetry (fd 4), `b` browser event (fd 6), `stop`. To the app: `hello`,
  // `c` telemetry control (fd 5), `k` browser command (fd 7), `o`/`e` base64 output, `x` exit.
  let client: NodeNet.Socket | undefined;
  const sendToClient = (line: string) => {
    if (client && !client.destroyed) client.write(`${line}\n`);
  };

  // State the server sent that a newly connected app must see again.
  const lastControl = new Map<string, string>();
  const activeTurns = new Map<string, string>();
  // Tabs the connected app attached; released when it goes away.
  const attachedTabs = new Map<string, { threadId: string; tabId: string }>();

  telemetryControl.on(
    "data",
    lineSplitter((line) => {
      const message = parseJson(line);
      if (message?.type === "setDiagnosticsDemand" || message?.type === "setHostPowerIntervals") {
        lastControl.set(message.type, line);
      }
      sendToClient(`c ${line}`);
    }),
  );
  browserCommands.on(
    "data",
    lineSplitter((line) => {
      const message = parseJson(line);
      if (message?.type === "turn" && typeof message.threadId === "string") {
        if (message.active === true) activeTurns.set(message.threadId, line);
        else activeTurns.delete(message.threadId);
      }
      sendToClient(`k ${line}`);
    }),
  );
  server.stdout?.on("data", (chunk: Buffer) => {
    if (client) sendToClient(`o ${chunk.toString("base64")}`);
    else writeLog(chunk.toString("utf8"));
  });
  server.stderr?.on("data", (chunk: Buffer) => {
    if (client) sendToClient(`e ${chunk.toString("base64")}`);
    else writeLog(chunk.toString("utf8"));
  });

  const forwardBrowserEvent = (line: string) => {
    const message = parseJson(line);
    if (message && typeof message.threadId === "string" && typeof message.tabId === "string") {
      const key = `${message.threadId}\u0000${message.tabId}`;
      if (message.type === "attached") {
        attachedTabs.set(key, { threadId: message.threadId, tabId: message.tabId });
      } else if (message.type === "detached") {
        attachedTabs.delete(key);
      }
    }
    browserIn.write(`${line}\n`);
  };

  const releaseClientTabs = () => {
    for (const tab of attachedTabs.values()) {
      browserIn.write(`${JSON.stringify({ type: "detached", ...tab })}\n`);
    }
    attachedTabs.clear();
  };

  let stopping = false;
  const stopServer = () => {
    if (stopping) return;
    stopping = true;
    writeLog(`[${new Date().toISOString()}] stopping server ${server.pid}\n`);
    server.kill("SIGTERM");
    setTimeout(() => server.kill("SIGKILL"), TERMINATE_GRACE_MS).unref();
  };
  process.on("SIGTERM", stopServer);

  // Without an app the server only stays up to finish what threads were doing.
  let idleChecks = 0;
  setInterval(() => {
    const busy = client === undefined ? countBusyThreads(launchConfig.stateDir) : undefined;
    idleChecks = busy === 0 ? idleChecks + 1 : 0;
    if (idleChecks < IDLE_CHECKS_TO_STOP) return;
    writeLog(`[${new Date().toISOString()}] no app and no busy threads\n`);
    stopServer();
  }, IDLE_CHECK_MS).unref();
  process.on("SIGINT", stopServer);

  const detachClient = (socket: NodeNet.Socket) => {
    if (client !== socket) return;
    client = undefined;
    releaseClientTabs();
    writeLog(`[${new Date().toISOString()}] app disconnected\n`);
  };

  NodeFS.rmSync(launchConfig.socketPath, { force: true });
  const listener = NodeNet.createServer((socket) => {
    if (client) {
      const previous = client;
      detachClient(previous);
      previous.destroy();
    }
    client = socket;
    socket.on("error", () => {});
    socket.on("close", () => detachClient(socket));
    socket.on(
      "data",
      lineSplitter((line) => {
        const space = line.indexOf(" ");
        const tag = space === -1 ? line : line.slice(0, space);
        const payload = space === -1 ? "" : line.slice(space + 1);
        if (client !== socket) return;
        if (tag === "t") telemetryIn.write(`${payload}\n`);
        else if (tag === "b") forwardBrowserEvent(payload);
        else if (tag === "stop") stopServer();
      }),
    );
    writeLog(`[${new Date().toISOString()}] app connected\n`);
    sendToClient(
      `hello ${JSON.stringify({
        hostPid: process.pid,
        serverPid: server.pid,
        runtimeKey: launchConfig.runtimeKey,
        appVersion: launchConfig.appVersion,
      })}`,
    );
    for (const line of lastControl.values()) sendToClient(`c ${line}`);
    for (const line of activeTurns.values()) sendToClient(`k ${line}`);
  });
  listener.on("error", (error) => {
    writeLog(`backend host socket failed: ${error.message}\n`);
    stopServer();
  });
  listener.listen(launchConfig.socketPath, () => {
    try {
      NodeFS.chmodSync(launchConfig.socketPath, 0o600);
    } catch {}
    writeRecord(launchConfig.recordPath, {
      version: 1,
      hostPid: process.pid,
      serverPid: server.pid ?? -1,
      socketPath: launchConfig.socketPath,
      runtimeKey: launchConfig.runtimeKey,
      runtimeDir: launchConfig.runtimeDir,
      appVersion: launchConfig.appVersion,
      port: launchConfig.port,
      bootstrapSecret: launchConfig.bootstrapSecret,
      startedAt: new Date().toISOString(),
    });
  });

  server.on("exit", (code, signal) => {
    writeLog(`[${new Date().toISOString()}] server exited code=${code} signal=${signal}\n`);
    removeOwnRecord(launchConfig.recordPath);
    sendToClient(`x ${JSON.stringify({ code, signal })}`);
    listener.close();
    NodeFS.rmSync(launchConfig.socketPath, { force: true });
    const finish = () => process.exit(code ?? 1);
    if (client && !client.destroyed) client.end(finish);
    else finish();
    setTimeout(finish, 1_000).unref();
  });
  server.on("error", (error) => {
    writeLog(`server spawn failed: ${error.message}\n`);
    removeOwnRecord(launchConfig.recordPath);
    process.exit(1);
  });
};

if (process.argv.includes("--launch")) {
  void launch();
} else if (process.argv.includes("--host")) {
  void host();
}
