// A long-running stdio process the Omarchy bar spawns. Plain Node for stdio,
// timers and state; Effect only for the WebSocket RPC client.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";

import {
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type ServerConfigStreamEvent,
  type ServerProvider,
  type ServerSettings,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import {
  discoverServer,
  fetchWebSocketTicket,
  readStoredToken,
  resolveT3Home,
  storeToken,
  webSocketUrl,
} from "./connection.ts";
import {
  type BarOp,
  type BarRequest,
  type BarThreadState,
  NOTIFY_STATES,
  buildRequestAnswers,
  deriveBarItems,
  deriveBarRequest,
  deriveLastLine,
  deriveModelOptions,
  deriveQueued,
  deriveThreadState,
  isListedThread,
  oneLine,
  parseOp,
  resolveDefaultModel,
  toProjectRow,
  toThreadRequest,
  toThreadRow,
} from "./model.ts";

const makeClient = RpcClient.make(WsRpcGroup);
type Client = typeof makeClient extends Effect.Effect<infer C, infer _E, infer _R> ? C : never;

const EMIT_INTERVAL_MS = 150;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const SOCKET_OPEN_TIMEOUT = "10 seconds";
const PING_TIMEOUT = "15 seconds";
const SUMMARY_FETCH_TIMEOUT = "10 seconds";
/** Snapshot reads in flight at once, and how often one thread is read again. */
const SUMMARY_CONCURRENCY = 2;
const SUMMARY_MIN_INTERVAL_MS = 5_000;
/** Threads in these states get their last line and request read from a snapshot. */
const SUMMARY_STATES: ReadonlySet<BarThreadState> = new Set([
  "waiting",
  "working",
  "failed",
  "unread",
]);
/** How long a notify waits for its thread's summary before going out without it. */
const NOTIFY_GRACE_MS = 1_500;
/**
 * Set to skip the `thread.visit` that `open` sends, so a read-only check of
 * the live server leaves its threads' unread state alone.
 */
const NO_VISIT_ENV = "T3_BAR_BRIDGE_NO_VISIT";

const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
const decodeLaunchInput = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput);

const log = (message: string) => process.stderr.write(`[bar-bridge] ${message}\n`);
const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(error);
};
const newId = () => NodeCrypto.randomUUID();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The thread's first (bounded) snapshot, without staying subscribed. */
async function readThreadSnapshot(
  client: Client,
  threadId: string,
): Promise<OrchestrationV2ThreadProjection | null> {
  const first = await Effect.runPromise(
    client["orchestration.subscribeThread"]({
      threadId: threadId as OrchestrationV2ThreadShell["id"],
      acceptBoundedSnapshot: true,
    }).pipe(
      Stream.filter((item) => item.kind === "snapshot"),
      Stream.runHead,
      Effect.timeout(SUMMARY_FETCH_TIMEOUT),
    ),
  );
  return first._tag === "Some" && first.value.kind === "snapshot" ? first.value.projection : null;
}

/** Runs `fn` at most once per interval; a call inside the window runs once at its end. */
class Throttle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = false;
  private readonly fn: () => void;
  private readonly intervalMs: number;
  constructor(fn: () => void, intervalMs: number) {
    this.fn = fn;
    this.intervalMs = intervalMs;
  }
  request(): void {
    if (this.timer !== null) {
      this.pending = true;
      return;
    }
    this.fn();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.pending) {
        this.pending = false;
        this.request();
      }
    }, this.intervalMs);
  }
}

interface OpenThread {
  readonly threadId: string;
  projection: OrchestrationV2ThreadProjection | null;
  snapshotSequence: number;
  partialTimeline: boolean;
  latestLocalTurnOrdinal: number | null | undefined;
  fiber: Fiber.Fiber<unknown, unknown> | null;
}

class BarBridge {
  private status: { state: string; message: string | null } | null = null;
  private client: Client | null = null;
  private shellReady = false;
  private readonly projects = new Map<string, OrchestrationProjectShell>();
  private readonly threads = new Map<string, OrchestrationV2ThreadShell>();
  /** Request details by request id, from a thread snapshot. */
  private readonly requests = new Map<string, BarRequest>();
  /**
   * Last line and queue length per thread, read from a bounded snapshot,
   * since shell rows carry no message text. `stamp` is the shell's
   * `updatedAt` the read reflects.
   */
  private readonly summaries = new Map<
    string,
    { stamp: number; latest: string | null; queuedCount: number }
  >();
  private readonly summaryQueue = new Set<string>();
  private readonly summaryReadAt = new Map<string, number>();
  private summaryReads = 0;
  private summaryWake: ReturnType<typeof setTimeout> | null = null;
  private open: OpenThread | null = null;
  /** Last emitted state per thread; null until the first snapshot sets the baseline. */
  private previousStates: Map<string, BarThreadState> | null = null;
  private readonly heldNotifies = new Map<string, ReturnType<typeof setTimeout>>();
  private providers: ReadonlyArray<ServerProvider> = [];
  private settings: ServerSettings | null = null;
  private lastLaunchOptions = "";
  private lastThread = "";
  private lastShell = "";
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once a freshly issued token is also refused; no more issuing after that. */
  private authBroken = false;
  private readonly shellThrottle = new Throttle(() => this.flushShell(), EMIT_INTERVAL_MS);
  private readonly threadThrottle = new Throttle(() => this.flushThread(), EMIT_INTERVAL_MS);
  private readonly visit = process.env[NO_VISIT_ENV] !== "1";

  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  // --- Output ----------------------------------------------------------------

  private emit(event: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }

  private setStatus(state: string, message: string | null = null): void {
    if (this.status?.state === state && this.status.message === message) return;
    this.status = { state, message };
    this.emit({ event: "status", state, message });
  }

  private ack(id: string | undefined, extra: Record<string, unknown> = {}): void {
    if (id !== undefined) this.emit({ event: "ack", id, ...extra });
  }

  private fail(id: string | undefined, message: string): void {
    this.emit({ event: "error", ...(id === undefined ? {} : { id }), message });
  }

  private projectTitle(projectId: string): string {
    return this.projects.get(projectId)?.title ?? "";
  }

  private rowFor(shell: OrchestrationV2ThreadShell, now: number) {
    const projection = this.open?.threadId === shell.id ? this.open.projection : null;
    const summary = this.summaries.get(shell.id);
    const pendingId = shell.pendingRuntimeRequest?.id;
    return toThreadRow(
      shell,
      {
        projectTitle: this.projectTitle(shell.projectId),
        request: pendingId === undefined ? null : (this.requests.get(pendingId) ?? null),
        queuedCount:
          projection !== null ? deriveQueued(projection).length : (summary?.queuedCount ?? 0),
        latest: projection !== null ? deriveLastLine(projection) : (summary?.latest ?? null),
      },
      now,
    );
  }

  /** Sends the shell when it changed, or always for `refresh`. */
  private flushShell(force = false): void {
    if (!this.shellReady) return;
    const now = Date.now();
    const listed = [...this.threads.values()].filter(isListedThread);
    const rows = listed.map((shell) => this.rowFor(shell, now));
    const encoded = JSON.stringify({
      event: "shell",
      projects: [...this.projects.values()].map(toProjectRow),
      threads: rows,
    });
    if (force || encoded !== this.lastShell) {
      this.lastShell = encoded;
      process.stdout.write(`${encoded}\n`);
    }

    const previous = this.previousStates;
    this.previousStates = new Map(rows.map((row) => [row.id, row.state]));
    const stale = this.queueSummaries(listed, rows);
    for (const row of rows) {
      if (!NOTIFY_STATES.has(row.state)) this.releaseNotify(row.id, false);
      if (previous === null || previous.get(row.id) === row.state) continue;
      if (!NOTIFY_STATES.has(row.state)) continue;
      if (stale.has(row.id)) {
        // Give the snapshot read a moment so the notification can say what happened.
        this.holdNotify(row.id);
        continue;
      }
      this.notify(row.id, now);
    }
    this.scheduleSnoozeWake(listed, now);
  }

  private notify(threadId: string, now = Date.now()): void {
    const shell = this.threads.get(threadId);
    if (shell === undefined || !isListedThread(shell)) return;
    const row = this.rowFor(shell, now);
    if (!NOTIFY_STATES.has(row.state)) return;
    const body =
      row.state === "waiting" && row.request !== null
        ? row.request.summary
        : row.state === "failed"
          ? (row.error ?? row.lastLine)
          : row.lastLine;
    this.emit({ event: "notify", threadId, state: row.state, title: row.title, body });
  }

  private holdNotify(threadId: string): void {
    if (this.heldNotifies.has(threadId)) return;
    this.heldNotifies.set(
      threadId,
      setTimeout(() => this.releaseNotify(threadId, true), NOTIFY_GRACE_MS),
    );
  }

  private releaseNotify(threadId: string, send: boolean): void {
    const timer = this.heldNotifies.get(threadId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.heldNotifies.delete(threadId);
    if (send) this.notify(threadId);
  }

  /** Snoozes end on the clock, not on an event, so re-send the shell when the next one ends. */
  private scheduleSnoozeWake(listed: ReadonlyArray<OrchestrationV2ThreadShell>, now: number): void {
    if (this.snoozeTimer !== null) clearTimeout(this.snoozeTimer);
    this.snoozeTimer = null;
    const next = Math.min(
      ...listed
        .map((shell) => (shell.snoozedUntil ? DateTime.toEpochMillis(shell.snoozedUntil) : NaN))
        .map((at) => (Number.isFinite(at) && at > now ? at : Infinity)),
    );
    if (Number.isFinite(next)) {
      this.snoozeTimer = setTimeout(
        () => this.shellThrottle.request(),
        Math.min(next - now + 50, 2 ** 31 - 1),
      );
    }
  }

  private flushThread(): void {
    const open = this.open;
    if (open === null || open.projection === null) return;
    const shell = this.threads.get(open.threadId);
    const projection = open.projection;
    const projectId = shell?.projectId ?? projection.thread.projectId;
    const projectTitle = this.projectTitle(projectId);
    const row = shell === undefined ? null : this.rowFor(shell, Date.now());
    const request = deriveBarRequest(projection, projectTitle, shell?.pendingRuntimeRequest?.id);
    const encoded = JSON.stringify({
      event: "thread",
      id: open.threadId,
      title: shell?.title ?? projection.thread.title,
      projectTitle,
      state: row?.state ?? "idle",
      activeRunId: row?.activeRunId ?? null,
      runStartedAt: row?.runStartedAt ?? null,
      items: deriveBarItems(projection),
      queued: deriveQueued(projection),
      request: toThreadRequest(request),
    });
    // Shell changes to other threads also land here; skip a repeat of the same view.
    if (encoded === this.lastThread) return;
    this.lastThread = encoded;
    process.stdout.write(`${encoded}\n`);
  }

  private flushLaunchOptions(): void {
    if (this.settings === null) return;
    const event = {
      event: "launchOptions",
      models: deriveModelOptions(this.providers),
      defaultModel: resolveDefaultModel(this.providers, this.settings.defaultModelSelection),
    };
    const encoded = JSON.stringify(event);
    if (encoded === this.lastLaunchOptions) return;
    this.lastLaunchOptions = encoded;
    process.stdout.write(`${encoded}\n`);
  }

  // --- Server streams ---------------------------------------------------------

  private onShellItem(item: OrchestrationV2ShellStreamItem): void {
    switch (item.kind) {
      case "snapshot":
        // An enrichment snapshot only patches repository identity and carries no threads.
        if (item.resolvedRepositoryIdentityRoots !== undefined) return;
        this.projects.clear();
        this.threads.clear();
        for (const project of item.snapshot.projects) this.projects.set(project.id, project);
        for (const thread of item.snapshot.threads) this.threads.set(thread.id, thread);
        if (!this.shellReady) {
          this.shellReady = true;
          this.setStatus("connected");
        }
        break;
      case "project.updated":
        this.projects.set(item.project.id, item.project);
        break;
      case "project.removed":
        this.projects.delete(item.projectId);
        break;
      case "thread.updated":
        if (item.location === "active") this.threads.set(item.thread.id, item.thread);
        else this.threads.delete(item.thread.id);
        break;
      case "thread.removed":
        if (item.location === "active") this.threads.delete(item.threadId);
        break;
      case "synchronized":
        return;
    }
    this.shellThrottle.request();
    if (this.open !== null) this.threadThrottle.request();
  }

  private onConfigEvent(event: ServerConfigStreamEvent): void {
    switch (event.type) {
      case "snapshot":
        this.providers = event.config.providers;
        this.settings = event.config.settings;
        break;
      case "providerStatuses":
        this.providers = event.payload.providers;
        break;
      case "settingsUpdated":
        this.settings = event.payload.settings;
        break;
      default:
        return;
    }
    this.flushLaunchOptions();
  }

  private onThreadItem(open: OpenThread, item: OrchestrationV2ThreadStreamItem): void {
    if (this.open !== open) return;
    if (item.kind === "snapshot") {
      open.projection = item.projection;
      open.snapshotSequence = item.snapshotSequence;
      open.partialTimeline = item.hasMoreHistory === true || item.historyCursor != null;
      open.latestLocalTurnOrdinal = item.latestLocalTurnOrdinal;
    } else if (item.kind === "event") {
      if (item.sequence <= open.snapshotSequence) return;
      open.snapshotSequence = item.sequence;
      open.projection = applyOrchestrationV2ProjectionEvent(open.projection, item.event, {
        partialTimeline: open.partialTimeline,
        ...(open.latestLocalTurnOrdinal == null
          ? {}
          : { latestLocalTurnOrdinal: open.latestLocalTurnOrdinal }),
      });
    } else {
      return;
    }
    if (open.projection !== null) this.cacheRequestFrom(open.projection, open.threadId);
    this.threadThrottle.request();
    this.shellThrottle.request();
  }

  private cacheRequestFrom(projection: OrchestrationV2ThreadProjection, threadId: string): void {
    const shell = this.threads.get(threadId);
    const pendingId = shell?.pendingRuntimeRequest?.id;
    if (pendingId === undefined) return;
    const request = deriveBarRequest(projection, this.projectTitle(shell!.projectId), pendingId);
    if (request !== null && request.id === pendingId) this.requests.set(pendingId, request);
  }

  /**
   * Queues a snapshot read for each thread that needs attention and whose
   * summary is older than its shell row, and drops summaries of threads that
   * left the list. Returns the threads whose summary is stale.
   */
  private queueSummaries(
    listed: ReadonlyArray<OrchestrationV2ThreadShell>,
    rows: ReadonlyArray<{ readonly id: string; readonly state: BarThreadState }>,
  ): Set<string> {
    const stale = new Set<string>();
    const pendingIds = new Set<string>();
    const listedIds = new Set<string>();
    for (const [index, shell] of listed.entries()) {
      listedIds.add(shell.id);
      const pendingId = shell.pendingRuntimeRequest?.id;
      if (pendingId !== undefined) pendingIds.add(pendingId);
      if (this.open?.threadId === shell.id && this.open.projection !== null) continue;
      const missingRequest = pendingId !== undefined && !this.requests.has(pendingId);
      const summary = this.summaries.get(shell.id);
      const outdated = summary?.stamp !== DateTime.toEpochMillis(shell.updatedAt);
      if (missingRequest || (SUMMARY_STATES.has(rows[index]!.state) && outdated)) {
        stale.add(shell.id);
        this.summaryQueue.add(shell.id);
      }
    }
    for (const id of this.requests.keys()) if (!pendingIds.has(id)) this.requests.delete(id);
    for (const id of this.summaries.keys()) if (!listedIds.has(id)) this.summaries.delete(id);
    this.pumpSummaries();
    return stale;
  }

  private pumpSummaries(): void {
    if (this.summaryWake !== null) {
      clearTimeout(this.summaryWake);
      this.summaryWake = null;
    }
    const now = Date.now();
    let wakeAt = Infinity;
    for (const threadId of this.summaryQueue) {
      if (this.summaryReads >= SUMMARY_CONCURRENCY || this.client === null) return;
      const readAt = (this.summaryReadAt.get(threadId) ?? -Infinity) + SUMMARY_MIN_INTERVAL_MS;
      if (readAt > now) {
        wakeAt = Math.min(wakeAt, readAt);
        continue;
      }
      this.summaryQueue.delete(threadId);
      void this.readSummary(this.client, threadId);
    }
    if (Number.isFinite(wakeAt)) {
      this.summaryWake = setTimeout(() => this.pumpSummaries(), wakeAt - now);
    }
  }

  private async readSummary(client: Client, threadId: string): Promise<void> {
    const shell = this.threads.get(threadId);
    if (shell === undefined) return;
    this.summaryReads += 1;
    this.summaryReadAt.set(threadId, Date.now());
    try {
      const projection = await readThreadSnapshot(client, threadId);
      if (projection !== null) {
        this.summaries.set(threadId, {
          stamp: DateTime.toEpochMillis(shell.updatedAt),
          latest: deriveLastLine(projection),
          queuedCount: deriveQueued(projection).length,
        });
        this.cacheRequestFrom(projection, threadId);
        this.shellThrottle.request();
      }
    } catch (error) {
      log(`Could not read thread ${threadId}: ${errorMessage(error)}`);
    } finally {
      this.summaryReads -= 1;
      this.releaseNotify(threadId, true);
      this.pumpSummaries();
    }
  }

  private subscribeOpenThread(): void {
    const open = this.open;
    const client = this.client;
    if (open === null || client === null || open.fiber !== null) return;
    open.projection = null;
    open.snapshotSequence = -1;
    open.fiber = Effect.runFork(
      client["orchestration.subscribeThread"]({
        threadId: open.threadId as OrchestrationV2ThreadShell["id"],
        acceptBoundedSnapshot: true,
      }).pipe(
        Stream.runForEach((item) => Effect.sync(() => this.onThreadItem(open, item))),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (this.open === open) open.fiber = null;
            log(`Thread subscription ended: ${String(cause)}`);
          }),
        ),
      ),
    );
  }

  private closeThread(): void {
    const open = this.open;
    this.open = null;
    this.lastThread = "";
    if (open?.fiber) void Effect.runPromise(Fiber.interrupt(open.fiber));
  }

  // --- Connection ---------------------------------------------------------------

  async run(): Promise<never> {
    this.setStatus("connecting");
    let delay = BACKOFF_START_MS;
    for (;;) {
      const connected = await this.connectOnce();
      if (connected) delay = BACKOFF_START_MS;
      await sleep(delay);
      delay = connected ? BACKOFF_START_MS : Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }

  private async issueToken(): Promise<string | null> {
    try {
      const { issueBarToken } = await import("./issueToken.ts");
      const token = await issueBarToken(this.baseDir);
      storeToken(token);
      log("Issued a new omarchy-bar session token");
      return token;
    } catch (error) {
      this.setStatus("error", `Could not issue a session token: ${errorMessage(error)}`);
      return null;
    }
  }

  /** One discovery, auth and session cycle. Resolves true when the session got connected. */
  private async connectOnce(): Promise<boolean> {
    const server = await discoverServer(this.baseDir);
    if (server === null) {
      this.setStatus("offline");
      return false;
    }
    if (this.status?.state !== "error") this.setStatus("connecting");
    let token = readStoredToken();
    let issued = false;
    if (token === null) {
      if (this.authBroken) return false;
      token = await this.issueToken();
      issued = true;
      if (token === null) return false;
    }
    let ticket = await fetchWebSocketTicket(server.origin, token);
    if (ticket.type === "unauthorized" && !issued && !this.authBroken) {
      log(`Token refused (${ticket.status}); issuing a new one`);
      token = await this.issueToken();
      if (token === null) return false;
      ticket = await fetchWebSocketTicket(server.origin, token);
    }
    if (ticket.type === "unauthorized") {
      this.authBroken = true;
      this.setStatus("error", `The server refused the bar's session token (${ticket.status})`);
      return false;
    }
    if (ticket.type === "unreachable") {
      log(ticket.message);
      this.setStatus("offline");
      return false;
    }
    this.authBroken = false;
    return this.runSession(webSocketUrl(server.origin, ticket.ticket));
  }

  private runSession(url: string): Promise<boolean> {
    const bridge = this;
    const session = Effect.gen(function* () {
      const disconnected = yield* Deferred.make<void>();
      const hooks = RpcClient.ConnectionHooks.of({
        onConnect: Effect.void,
        onPingTimeout: Effect.sync(() => log("Server stopped answering pings")),
        onDisconnect: Deferred.succeed(disconnected, undefined).pipe(Effect.asVoid),
      });
      const layerProtocol = Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          pingTimeout: PING_TIMEOUT,
          retryTransientErrors: false,
          retryPolicy: Schedule.recurs(0),
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Socket.layerWebSocket(url, { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
              Layer.provide(Socket.layerWebSocketConstructorGlobal),
            ),
            RpcSerialization.layerJson,
            Layer.succeed(RpcClient.ConnectionHooks, hooks),
          ),
        ),
      );
      const context = yield* Layer.build(layerProtocol);
      const client = yield* makeClient.pipe(Effect.provide(context));
      bridge.onSessionStart(client);

      const ended = (name: string) => (cause: unknown) =>
        Effect.sync(() => log(`${name} stream ended: ${String(cause)}`));
      const shell = client["orchestration.subscribeShell"]({}).pipe(
        Stream.runForEach((item) => Effect.sync(() => bridge.onShellItem(item))),
        Effect.catchCause(ended("Shell")),
      );
      const config = client[WS_METHODS.subscribeServerConfig]({}).pipe(
        Stream.runForEach((event) => Effect.sync(() => bridge.onConfigEvent(event))),
        Effect.catchCause(ended("Config")),
      );
      // Either stream ending means the session is no longer trustworthy.
      yield* Effect.raceFirst(Deferred.await(disconnected), Effect.raceFirst(shell, config));
    }).pipe(Effect.scoped);

    return Effect.runPromise(
      session.pipe(
        Effect.catchCause((cause) => Effect.sync(() => log(`Session failed: ${String(cause)}`))),
      ),
    ).then(() => {
      const wasConnected = this.shellReady;
      this.onSessionEnd();
      return wasConnected;
    });
  }

  private onSessionStart(client: Client): void {
    this.client = client;
    this.shellReady = false;
    if (this.open !== null) {
      this.open.fiber = null;
      this.subscribeOpenThread();
    }
  }

  private onSessionEnd(): void {
    const wasConnected = this.shellReady;
    this.client = null;
    this.shellReady = false;
    this.lastLaunchOptions = "";
    this.lastShell = "";
    this.lastThread = "";
    if (this.open?.fiber) {
      void Effect.runPromise(Fiber.interrupt(this.open.fiber));
      this.open.fiber = null;
    }
    if (wasConnected) {
      log("Disconnected from T3");
      this.setStatus("connecting");
    }
  }

  // --- Ops ------------------------------------------------------------------------

  handleLine(line: string): void {
    if (!line.trim()) return;
    const parsed = parseOp(line);
    if (!parsed.ok) {
      this.fail(parsed.id, parsed.message);
      return;
    }
    const op = parsed.op;
    this.handleOp(op).then(
      (extra) => this.ack(op.id, extra ?? {}),
      (error: unknown) => this.fail(op.id, errorMessage(error)),
    );
  }

  private requireClient(): Client {
    if (this.client === null || !this.shellReady) throw new Error("Not connected to T3");
    return this.client;
  }

  private requireThread(threadId: string): OrchestrationV2ThreadShell {
    const shell = this.threads.get(threadId);
    if (shell === undefined) throw new Error(`Unknown thread ${threadId}`);
    return shell;
  }

  private async dispatch(command: Record<string, unknown>): Promise<void> {
    const client = this.requireClient();
    const decoded = decodeCommand({ commandId: newId(), ...command });
    await Effect.runPromise(client["orchestration.dispatchCommand"](decoded));
  }

  private activeRunId(threadId: string): string | null {
    const open = this.open?.threadId === threadId ? this.open.projection : null;
    const fromProjection = open?.runs.findLast((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    )?.id;
    return fromProjection ?? this.threads.get(threadId)?.activeRunId ?? null;
  }

  private async handleOp(op: BarOp): Promise<Record<string, unknown> | void> {
    switch (op.op) {
      case "refresh":
        if (this.shellReady) this.flushShell(true);
        return;
      case "close":
        this.closeThread();
        return;
      case "open": {
        this.requireClient();
        this.requireThread(op.threadId);
        if (this.open?.threadId !== op.threadId) {
          this.closeThread();
          this.open = {
            threadId: op.threadId,
            projection: null,
            snapshotSequence: -1,
            partialTimeline: false,
            latestLocalTurnOrdinal: undefined,
            fiber: null,
          };
          this.subscribeOpenThread();
        } else {
          this.lastThread = "";
          this.threadThrottle.request();
        }
        if (this.visit) {
          await this.dispatch({
            type: "thread.visit",
            threadId: op.threadId,
            visitedAt: new Date().toISOString(),
          });
        }
        return;
      }
      case "reply": {
        this.requireThread(op.threadId);
        const activeRunId = this.activeRunId(op.threadId);
        if (op.mode === "steer" && activeRunId === null) throw new Error("No active run to steer");
        const delivery =
          op.mode === "queue" || (op.mode === "auto" && activeRunId !== null)
            ? { dispatchMode: { type: "queue_after_active" } }
            : {
                dispatchMode: { type: "start_immediately" },
                deliveryIntent: op.mode === "steer" ? "steer" : "auto",
              };
        await this.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          threadId: op.threadId,
          messageId: newId(),
          text: op.text,
          attachments: [],
          ...delivery,
        });
        return;
      }
      case "sendAll": {
        this.requireThread(op.threadId);
        const targetRunId = this.activeRunId(op.threadId);
        if (targetRunId === null) throw new Error("No active run to send the queue into");
        await this.dispatch({
          type: "queued-messages.send-all",
          threadId: op.threadId,
          targetRunId,
        });
        return;
      }
      case "respond":
        await this.dispatch({
          type: "runtime-request.respond",
          threadId: op.threadId,
          requestId: op.requestId,
          decision: op.decision,
        });
        return;
      case "answer": {
        // Option values and multi-select live on the request item.
        const projection =
          (this.open?.threadId === op.threadId ? this.open.projection : null) ??
          (await readThreadSnapshot(this.requireClient(), op.threadId));
        const answers = buildRequestAnswers(
          projection ?? { runtimeRequests: [], turnItems: [] },
          op.requestId,
          op.answers,
        );
        await this.dispatch({
          type: "runtime-request.respond",
          threadId: op.threadId,
          requestId: op.requestId,
          answers,
        });
        return;
      }
      case "dismiss":
        await this.dispatch({
          type: "thread.user-input.dismiss",
          threadId: op.threadId,
          requestId: op.requestId,
        });
        return;
      case "stop": {
        this.requireThread(op.threadId);
        const runId = this.activeRunId(op.threadId);
        if (runId === null) throw new Error("No active run to stop");
        await this.dispatch({
          type: "run.interrupt",
          threadId: op.threadId,
          runId,
          holdQueue: true,
        });
        return;
      }
      case "settle":
        await this.dispatch({ type: "thread.settle", threadId: op.threadId });
        return;
      case "unsettle":
        await this.dispatch({ type: "thread.unsettle", threadId: op.threadId, reason: "user" });
        return;
      case "pin":
        await this.dispatch({ type: "thread.pin", threadId: op.threadId });
        return;
      case "unpin":
        await this.dispatch({ type: "thread.unpin", threadId: op.threadId });
        return;
      case "unsnooze":
        await this.dispatch({ type: "thread.unsnooze", threadId: op.threadId, reason: "user" });
        return;
      case "snooze":
        await this.dispatch({
          type: "thread.snooze",
          threadId: op.threadId,
          snoozedUntil: new Date(op.until).toISOString(),
        });
        return;
      case "launch":
        return { threadId: await this.launch(op) };
    }
  }

  private async launch(op: Extract<BarOp, { op: "launch" }>): Promise<string> {
    const client = this.requireClient();
    const project = this.projects.get(op.projectId);
    if (project === undefined) throw new Error(`Unknown project ${op.projectId}`);
    if (this.settings === null) throw new Error("Server settings have not loaded yet");
    const resolved = resolveProjectSettings(this.settings, project.id, project).settings;
    const modelSelection: ModelSelection | null =
      op.model === undefined
        ? resolveDefaultModel(this.providers, resolved.defaultModelSelection)
        : (op.model as ModelSelection);
    if (modelSelection === null) throw new Error("No usable model is configured");
    const input = decodeLaunchInput({
      commandId: newId(),
      creationSource: "web",
      projectId: project.id,
      title: oneLine(op.text, 80) || "New thread",
      generateTitle: true,
      modelSelection,
      runtimeMode: resolved.defaultRuntimeMode,
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: newId(), text: op.text, attachments: [] },
    });
    const result = await Effect.runPromise(client["orchestration.launchThread"](input));
    return result.threadId;
  }
}

/** `t3 bar-bridge`: NDJSON events on stdout, ops on stdin, logs on stderr. */
export async function runBarBridge(): Promise<void> {
  // Anything that logs through console (Effect's default logger included)
  // must not land between the NDJSON lines on stdout.
  console.log = console.info = console.debug = console.warn = console.error;
  const bridge = new BarBridge(resolveT3Home());
  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => bridge.handleLine(line));
  input.on("close", () => process.exit(0));
  process.stdout.on("error", () => process.exit(0));
  await bridge.run();
}
