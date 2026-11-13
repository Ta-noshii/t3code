// @effect-diagnostics nodeBuiltinImport:off - Spawns and talks to the detached backend host.
/**
 * Runs the primary local server through `backendHost` so it outlives the app and its updates.
 * Linux AppImage only: the AppImage unmounts on exit, so host and server run from a per-build copy
 * under `<T3 home>/desktop-runtimes`. A newer app keeps the running server until no thread is busy.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { DesktopBackendBootstrap, DesktopTelemetryControlMessage } from "@t3tools/contracts";

import type { BackendHostLaunch, BackendHostRecord } from "../backendHost.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import { countBusyThreads } from "./busyThreads.ts";
import type { BackendProcessExit, RunBackendProcessOptions } from "./DesktopBackendManager.ts";

/** What the primary backend config carries when it runs through the host. */
export interface HostedBackendConfig {
  readonly stateDir: string;
  readonly baseDir: string;
  readonly logDir: string;
  readonly appVersion: string;
  readonly appImagePath: string;
  /** The mounted AppImage root, which every runtime path starts with. */
  readonly appRoot: string;
  /** `backendHost.cjs` inside the mounted AppImage. */
  readonly hostScriptPath: string;
}

const RECORD_FILE = "desktop-backend-host.json";
const RUNTIMES_DIR = "desktop-runtimes";
const RUNTIME_COMPLETE_MARKER = ".t3-runtime-complete";
const HOST_START_TIMEOUT = Duration.seconds(30);
const HOST_CONNECT_INTERVAL = Duration.millis(100);
const IDLE_CHECK_INTERVAL = Duration.seconds(15);
/** Two idle checks in a row, so a thread between a turn and its queued follow-up is not cut. */
const IDLE_CHECKS_BEFORE_SWAP = 2;
const STOP_WAIT = Duration.seconds(10);

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-backend-host");

export class HostedBackendError extends Schema.TaggedError<HostedBackendError>()(
  "HostedBackendError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Desktop backend host failed: ${this.reason}`;
  }
}

/** Off with `T3CODE_DESKTOP_BACKEND_HOST=0`. */
export const isHostingSupported = (input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly appImagePath: Option.Option<string>;
}): boolean =>
  input.platform === "linux" &&
  input.isPackaged &&
  Option.isSome(input.appImagePath) &&
  process.env.T3CODE_DESKTOP_BACKEND_HOST !== "0";

/**
 * Unix socket paths are limited to 108 bytes, which a long T3 home exceeds, so the socket lives in
 * the user's runtime dir under a name derived from the state dir.
 */
export const socketPathFor = (stateDir: string) => {
  const hash = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const directory =
    runtimeDir !== undefined && runtimeDir.length > 0 && runtimeDir.length < 64
      ? runtimeDir
      : NodeOS.tmpdir();
  return NodePath.join(directory, `t3code-backend-${hash}.sock`);
};

export const recordPathFor = (stateDir: string) => NodePath.join(stateDir, RECORD_FILE);

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/** A reused pid must not pass for the host. */
const isHostProcess = (pid: number): boolean => {
  if (!isProcessAlive(pid)) return false;
  try {
    return NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("backendHost.cjs");
  } catch {
    return false;
  }
};

const readRecordSync = (stateDir: string): Option.Option<BackendHostRecord> => {
  try {
    const record = JSON.parse(
      NodeFS.readFileSync(recordPathFor(stateDir), "utf8"),
    ) as Partial<BackendHostRecord>;
    return record.version === 1 &&
      typeof record.hostPid === "number" &&
      typeof record.port === "number" &&
      typeof record.socketPath === "string" &&
      typeof record.bootstrapSecret === "string" &&
      typeof record.runtimeKey === "string"
      ? Option.some(record as BackendHostRecord)
      : Option.none();
  } catch {
    return Option.none();
  }
};

/** The host left running by an earlier app, if it is still alive. */
export const readLiveHostSync = (stateDir: string): Option.Option<BackendHostRecord> =>
  Option.filter(readRecordSync(stateDir), (record) => isHostProcess(record.hostPid));

export const readLiveHost = (stateDir: string) => Effect.sync(() => readLiveHostSync(stateDir));

/** Changes whenever the AppImage file changes, so a rebuilt AppImage of one version still swaps. */
const runtimeKeyFor = (config: HostedBackendConfig): string => {
  const stat = NodeFS.statSync(config.appImagePath);
  return `${config.appVersion}-${stat.size}-${Math.trunc(stat.mtimeMs)}`.replace(
    /[^A-Za-z0-9._-]/g,
    "_",
  );
};

const runtimesRoot = (config: HostedBackendConfig) => NodePath.join(config.baseDir, RUNTIMES_DIR);

/** Copies the mounted AppImage once per build. `cp` sees app.asar as a file; Electron's fs would not. */
const prepareRuntime = Effect.fn("desktop.hostedBackend.prepareRuntime")(function* (
  config: HostedBackendConfig,
  runtimeKey: string,
) {
  const root = runtimesRoot(config);
  const runtimeDir = NodePath.join(root, runtimeKey);
  if (NodeFS.existsSync(NodePath.join(runtimeDir, RUNTIME_COMPLETE_MARKER))) return runtimeDir;
  yield* logInfo("copying the app runtime for the backend host", { runtimeDir });
  const temporary = `${runtimeDir}.tmp-${process.pid}`;
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        NodeFS.mkdirSync(root, { recursive: true });
        NodeFS.rmSync(temporary, { recursive: true, force: true });
        NodeChildProcess.execFile(
          "cp",
          ["-a", "--reflink=auto", config.appRoot, temporary],
          { maxBuffer: 1024 * 1024 },
          (error) => (error ? reject(error) : resolve()),
        );
      }),
    catch: (cause) => new HostedBackendError({ reason: "could not copy the app runtime", cause }),
  });
  yield* Effect.sync(() => {
    NodeFS.writeFileSync(NodePath.join(temporary, RUNTIME_COMPLETE_MARKER), `${runtimeKey}\n`);
    NodeFS.rmSync(runtimeDir, { recursive: true, force: true });
    NodeFS.renameSync(temporary, runtimeDir);
  });
  return runtimeDir;
});

/** Keeps the runtime in use and the newest one; deletes the rest. */
const pruneRuntimes = (config: HostedBackendConfig, keep: ReadonlyArray<string>) =>
  Effect.sync(() => {
    const root = runtimesRoot(config);
    let entries: Array<string>;
    try {
      entries = NodeFS.readdirSync(root);
    } catch {
      return;
    }
    const keepNames = new Set(keep.map((dir) => NodePath.basename(dir)));
    for (const entry of entries) {
      if (keepNames.has(entry)) continue;
      const tmp = /\.tmp-(\d+)$/.exec(entry);
      if (tmp && isProcessAlive(Number(tmp[1]))) continue;
      NodeFS.rmSync(NodePath.join(root, entry), { recursive: true, force: true });
    }
  }).pipe(Effect.ignore);

const relocate = (value: string, from: string, to: string): string =>
  value === from || value.startsWith(`${from}/`) ? `${to}${value.slice(from.length)}` : value;

const relocateEnv = (
  env: Record<string, string | undefined>,
  from: string,
  to: string,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // PATH-like values list several paths.
    result[key] = value
      .split(":")
      .map((part) => relocate(part, from, to))
      .join(":");
  }
  return result;
};

const relocateBootstrap = (bootstrap: unknown, from: string, to: string): unknown => {
  if (typeof bootstrap === "string") return relocate(bootstrap, from, to);
  if (Array.isArray(bootstrap)) return bootstrap.map((item) => relocateBootstrap(item, from, to));
  if (typeof bootstrap === "object" && bootstrap !== null) {
    return Object.fromEntries(
      Object.entries(bootstrap).map(([key, value]) => [key, relocateBootstrap(value, from, to)]),
    );
  }
  return bootstrap;
};

const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));
const decodeControlLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);

const startHost = Effect.fn("desktop.hostedBackend.startHost")(function* (
  options: RunBackendProcessOptions & { readonly hosted: HostedBackendConfig },
  runtimeKey: string,
) {
  const { hosted } = options;
  const runtimeDir = yield* prepareRuntime(hosted, runtimeKey);
  const from = hosted.appRoot;
  const bootstrap = relocateBootstrap(options.bootstrap, from, runtimeDir);
  const bootstrapLine = yield* encodeBootstrapJson(bootstrap as typeof options.bootstrap).pipe(
    Effect.mapError(
      (cause) => new HostedBackendError({ reason: "could not encode the bootstrap", cause }),
    ),
  );
  const env = relocateEnv(
    options.extendEnv ? { ...process.env, ...options.env } : options.env,
    from,
    runtimeDir,
  );
  const launch: BackendHostLaunch = {
    socketPath: socketPathFor(hosted.stateDir),
    recordPath: recordPathFor(hosted.stateDir),
    stateDir: hosted.stateDir,
    logPath: NodePath.join(hosted.logDir, "backend-host.log"),
    runtimeKey,
    runtimeDir,
    appVersion: hosted.appVersion,
    port: options.bootstrap.port ?? 0,
    bootstrapSecret: options.bootstrap.desktopBootstrapSecret ?? "",
    bootstrapLine,
    server: {
      command: relocate(options.executablePath, from, runtimeDir),
      args: options.args.map((arg) => relocate(arg, from, runtimeDir)),
      cwd: relocate(options.cwd, from, runtimeDir),
      env,
    },
  };
  const hostExecutable = relocate(process.execPath, from, runtimeDir);
  const hostScript = relocate(hosted.hostScriptPath, from, runtimeDir);
  yield* logInfo("starting the backend host", { runtimeKey, hostExecutable });
  yield* Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const launcher = NodeChildProcess.spawn(hostExecutable, [hostScript, "--launch"], {
          cwd: launch.server.cwd,
          env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["pipe", "ignore", "ignore"],
          detached: true,
        });
        launcher.on("error", reject);
        launcher.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`launcher exited with ${code}`)),
        );
        launcher.stdin.end(JSON.stringify(launch));
      }),
    catch: (cause) => new HostedBackendError({ reason: "could not start the host", cause }),
  });
  yield* pruneRuntimes(hosted, [runtimeDir]);
});

const connectSocket = (socketPath: string) =>
  Effect.callback<NodeNet.Socket, Error>((resume) => {
    const socket = NodeNet.createConnection(socketPath);
    const onError = (error: Error) => {
      socket.destroy();
      resume(Effect.fail(error));
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resume(Effect.succeed(socket));
    });
    return Effect.sync(() => socket.destroy());
  });

const connectWithRetry = (socketPath: string, timeout: Duration.Duration) =>
  connectSocket(socketPath).pipe(
    Effect.mapError((error) => new HostedBackendError({ reason: error.message })),
    Effect.retry({ schedule: Schedule.spaced(HOST_CONNECT_INTERVAL) }),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(new HostedBackendError({ reason: "the host did not open its socket" })),
    }),
  );

/** Threads a server stop would cut: a run in flight or background work a turn left running. */
export const busyThreadCount = (stateDir: string): Option.Option<number> =>
  Option.fromNullishOr(countBusyThreads(stateDir));

interface HostHello {
  readonly hostPid: number;
  readonly serverPid: number;
  readonly runtimeKey: string;
  readonly appVersion: string;
}

/**
 * The hosted counterpart of `runBackendProcess`: returns when the server exits. Closing its scope
 * only disconnects from the host, unless `shouldDetach` is false, which stops the server first.
 */
export const runHostedBackendProcess = Effect.fn("desktop.hostedBackend.run")(function* (
  options: RunBackendProcessOptions & {
    readonly hosted: HostedBackendConfig;
    readonly shouldDetach: Effect.Effect<boolean>;
    readonly probeReadiness: (serverPid: number) => Effect.Effect<boolean>;
  },
): Effect.fn.Return<BackendProcessExit, HostedBackendError, Scope.Scope> {
  const { hosted } = options;
  const runtimeKey = yield* Effect.try({
    try: () => runtimeKeyFor(hosted),
    catch: (cause) => new HostedBackendError({ reason: "could not read the AppImage", cause }),
  });
  const socketPath = socketPathFor(hosted.stateDir);

  const live = yield* readLiveHost(hosted.stateDir);
  if (Option.isNone(live)) {
    yield* startHost(options, runtimeKey);
  } else {
    yield* logInfo("attaching to the running backend host", {
      hostPid: live.value.hostPid,
      runtimeKey: live.value.runtimeKey,
    });
  }
  const socket = yield* connectWithRetry(
    socketPath,
    Option.isNone(live) ? HOST_START_TIMEOUT : Duration.seconds(5),
  );

  const lines = yield* Queue.unbounded<string, Cause.Done>();
  const exitSignal = yield* Deferred.make<BackendProcessExit>();
  const stopRequested = yield* Ref.make(false);
  const writeLine = (line: string) =>
    Effect.sync(() => {
      if (!socket.destroyed) socket.write(`${line}\n`);
    });
  let pending = "";
  socket.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let index = pending.indexOf("\n");
    while (index !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.length > 0) Queue.offerUnsafe(lines, line);
      index = pending.indexOf("\n");
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => Queue.endUnsafe(lines));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const detach = yield* options.shouldDetach;
      if (!detach && !(yield* Deferred.isDone(exitSignal))) {
        yield* logInfo("stopping the hosted backend");
        yield* writeLine("stop");
        yield* Deferred.await(exitSignal).pipe(Effect.timeout(STOP_WAIT), Effect.ignore);
      }
      yield* Effect.sync(() => socket.destroy());
    }),
  );

  const hello = yield* Deferred.make<HostHello>();
  const telemetryControl = options.onDesktopTelemetryControl;
  const browserCommand = options.onDesktopBrowserCommand;
  const onOutput = options.onOutput ?? (() => Effect.void);
  yield* Stream.fromQueue(lines).pipe(
    Stream.runForEach((line) => {
      const space = line.indexOf(" ");
      const tag = space === -1 ? line : line.slice(0, space);
      const payload = space === -1 ? "" : line.slice(space + 1);
      switch (tag) {
        case "hello":
          return Deferred.succeed(hello, JSON.parse(payload) as HostHello);
        case "c":
          return telemetryControl === undefined
            ? Effect.void
            : decodeControlLine(payload).pipe(Effect.flatMap(telemetryControl), Effect.ignoreCause);
        case "k":
          return browserCommand?.(payload) ?? Effect.void;
        case "o":
        case "e":
          return onOutput(tag === "o" ? "stdout" : "stderr", Buffer.from(payload, "base64")).pipe(
            Effect.ignore,
          );
        case "x": {
          const exit = JSON.parse(payload) as { code: number | null; signal: string | null };
          return Deferred.succeed(exitSignal, {
            code: exit.code === null ? Option.none() : Option.some(exit.code),
            reason: exit.code === null ? `killed by ${exit.signal}` : `code=${exit.code}`,
          });
        }
        default:
          return Effect.void;
      }
    }),
    Effect.ensuring(
      Deferred.succeed(exitSignal, {
        code: Option.none(),
        reason: "lost the connection to the backend host",
      }),
    ),
    Effect.ensuring(
      telemetryControl?.({ version: 1, type: "setDiagnosticsDemand", enabled: false }) ??
        Effect.void,
    ),
    Effect.forkScoped,
  );

  const greeting = yield* Deferred.await(hello).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () => Effect.fail(new HostedBackendError({ reason: "the host did not greet" })),
    }),
  );
  yield* options.onStarted?.(greeting.serverPid) ?? Effect.void;

  const forwardLines = (stream: Stream.Stream<Uint8Array>, tag: string) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.runForEach((line) => writeLine(`${tag} ${line}`)),
      Effect.catchCause((cause) =>
        logWarning("desktop stream to the backend host stopped", {
          tag,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.forkScoped,
    );
  yield* forwardLines(options.desktopTelemetryStream, "t");
  if (options.desktopBrowserStream !== undefined) {
    yield* forwardLines(options.desktopBrowserStream, "b");
  }

  yield* options.probeReadiness(greeting.serverPid).pipe(
    Effect.repeat({ while: (ready) => !ready }),
    Effect.forkScoped,
  );

  if (greeting.runtimeKey !== runtimeKey) {
    yield* logInfo("the running server is another build; swapping once threads are idle", {
      running: greeting.runtimeKey,
      current: runtimeKey,
    });
    yield* awaitIdleThenStop(options, runtimeKey, writeLine, stopRequested).pipe(Effect.forkScoped);
  } else {
    yield* pruneRuntimes(hosted, [NodePath.join(runtimesRoot(hosted), runtimeKey)]);
  }

  const exit = yield* Deferred.await(exitSignal);
  yield* options.onExitObserved?.() ?? Effect.void;
  if (yield* Ref.get(stopRequested)) {
    return { code: Option.some(0), reason: "replaced by the app's server version", replaced: true };
  }
  return exit;
});

const awaitIdleThenStop = Effect.fn("desktop.hostedBackend.awaitIdleThenStop")(function* (
  options: RunBackendProcessOptions & { readonly hosted: HostedBackendConfig },
  runtimeKey: string,
  writeLine: (line: string) => Effect.Effect<void>,
  stopRequested: Ref.Ref<boolean>,
) {
  // Copy now, so the swap itself only restarts the server.
  yield* prepareRuntime(options.hosted, runtimeKey).pipe(
    Effect.catch((error) => logWarning("could not prepare the new runtime", { error })),
  );
  let idleChecks = 0;
  let lastBusy = -1;
  while (idleChecks < IDLE_CHECKS_BEFORE_SWAP) {
    yield* Effect.sleep(IDLE_CHECK_INTERVAL);
    const busy = busyThreadCount(options.hosted.stateDir);
    if (Option.isSome(busy) && busy.value === 0) {
      idleChecks += 1;
    } else {
      idleChecks = 0;
      const count = Option.getOrElse(busy, () => -1);
      if (count !== lastBusy) {
        yield* logInfo("server swap waits for busy threads", { busyThreads: count });
        lastBusy = count;
      }
    }
  }
  yield* logInfo("threads are idle; swapping the server");
  yield* Ref.set(stopRequested, true);
  yield* writeLine("stop");
});

/** Stops the host's server, for a quit that should not leave it running. */
export const stopLiveHost = Effect.fn("desktop.hostedBackend.stopLiveHost")(function* (
  stateDir: string,
) {
  const live = yield* readLiveHost(stateDir);
  if (Option.isNone(live)) return;
  yield* Effect.sync(() => {
    try {
      process.kill(live.value.hostPid, "SIGTERM");
    } catch {}
  });
});
