// Runs before the CLI graph loads, so it uses Node built-ins and plain JSON.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off globalFetch:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ORCHESTRATION_PROTOCOL_HEADER, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";

/** The local server, found the way `t3 pair` finds it. */
export interface DiscoveredServer {
  readonly baseDir: string;
  readonly origin: string;
}

const PROBE_TIMEOUT_MS = 2_500;

/** `T3CODE_HOME` when set, otherwise `~/.t3`, with `~` expanded. */
export function resolveT3Home(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.T3CODE_HOME?.trim();
  if (!raw) return NodePath.join(NodeOS.homedir(), ".t3");
  if (raw === "~") return NodeOS.homedir();
  if (raw.startsWith("~/")) return NodePath.join(NodeOS.homedir(), raw.slice(2));
  return NodePath.resolve(raw);
}

export function barConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return NodePath.join(xdg ? xdg : NodePath.join(NodeOS.homedir(), ".config"), "t3-bar");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function probe(origin: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/.well-known/t3/environment", origin), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { environmentId?: unknown };
    return typeof body === "object" && body !== null && typeof body.environmentId === "string";
  } catch {
    return false;
  }
}

/**
 * Reads `server-runtime.json` under the T3 home (the installed server, then a
 * dev server) and returns the first one whose process is alive and answers
 * the environment probe. Re-read on every connect, since the port can change.
 */
export async function discoverServer(baseDir = resolveT3Home()): Promise<DiscoveredServer | null> {
  for (const variant of ["userdata", "dev"]) {
    let state: { pid?: unknown; origin?: unknown };
    try {
      state = JSON.parse(
        await NodeFS.promises.readFile(
          NodePath.join(baseDir, variant, "server-runtime.json"),
          "utf8",
        ),
      );
    } catch {
      continue;
    }
    if (typeof state.pid !== "number" || typeof state.origin !== "string") continue;
    if (!isProcessAlive(state.pid)) continue;
    if (await probe(state.origin)) return { baseDir, origin: state.origin };
  }
  return null;
}

// --- Token file ---------------------------------------------------------------

export function readStoredToken(dir = barConfigDir()): string | null {
  try {
    const token = NodeFS.readFileSync(NodePath.join(dir, "token"), "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Writes the token with mode 0600 in a 0700 directory, replacing any old one. */
export function storeToken(token: string, dir = barConfigDir()): void {
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(dir, 0o700);
  const path = NodePath.join(dir, "token");
  const temp = `${path}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, `${token}\n`, { mode: 0o600 });
  NodeFS.chmodSync(temp, 0o600);
  NodeFS.renameSync(temp, path);
}

// --- WebSocket ticket -----------------------------------------------------------

export type TicketResult =
  | { readonly type: "ticket"; readonly ticket: string }
  | { readonly type: "unauthorized"; readonly status: number }
  | { readonly type: "unreachable"; readonly message: string };

/** Trades the session token for a one-use WebSocket ticket. */
export async function fetchWebSocketTicket(origin: string, token: string): Promise<TicketResult> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/websocket-ticket", origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS * 2),
    });
  } catch (error) {
    return { type: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 401 || response.status === 403) {
    return { type: "unauthorized", status: response.status };
  }
  if (!response.ok) {
    return { type: "unreachable", message: `Ticket request failed with ${response.status}` };
  }
  const body = (await response.json().catch(() => null)) as { ticket?: unknown } | null;
  if (typeof body?.ticket !== "string") {
    return { type: "unreachable", message: "Ticket response had no ticket" };
  }
  return { type: "ticket", ticket: body.ticket };
}

export function webSocketUrl(origin: string, ticket: string): string {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
}
