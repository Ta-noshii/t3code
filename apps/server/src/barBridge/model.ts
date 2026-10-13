/**
 * Pure mapping between T3 orchestration state and the bar bridge protocol
 * (`~/.config/omarchy/plugins/tanoshii.t3code/PROTOCOL.md`): shell rows and
 * their state, the open thread's items and request, launch options, and op
 * parsing. Everything here is synchronous so it can be unit-tested without a
 * server.
 */
import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  type ServerProvider,
} from "@t3tools/contracts";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import * as DateTime from "effect/DateTime";

export type BarThreadState =
  | "waiting"
  | "working"
  | "failed"
  | "unread"
  | "idle"
  | "snoozed"
  | "settled";

/** States that earn a `notify` when a thread moves into them. */
export const NOTIFY_STATES: ReadonlySet<BarThreadState> = new Set(["waiting", "failed", "unread"]);

export interface BarRequestQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
}

export interface BarRequest {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly detail: string | null;
  readonly decisions: ReadonlyArray<ProviderApprovalDecision>;
  readonly questions: ReadonlyArray<BarRequestQuestion>;
  /** One line for the shell row and notifications; not part of the `thread` event. */
  readonly summary: string;
}

/** The `thread` event's request: everything but the row summary. */
export function toThreadRequest(request: BarRequest | null) {
  if (request === null) return null;
  const { summary: _summary, ...rest } = request;
  return rest;
}

/** The shell row's view of a pending request. */
export interface BarRowRequest {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly decisions: ReadonlyArray<ProviderApprovalDecision>;
  readonly hasQuestions: boolean;
}

export interface BarThreadRow {
  readonly id: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly title: string;
  readonly state: BarThreadState;
  readonly request: BarRowRequest | null;
  readonly lastLine: string;
  readonly updatedAt: string;
  readonly runStartedAt: string | null;
  readonly activeRunId: string | null;
  readonly queuedCount: number;
  readonly pinned: boolean;
  readonly snoozedUntil: string | null;
  readonly error: string | null;
}

export type BarItem =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string; readonly truncated?: true }
  | {
      readonly kind: "tool";
      readonly text: string;
      readonly status: "running" | "done" | "failed";
    }
  | { readonly kind: "error"; readonly text: string };

export const MAX_LAST_LINE = 200;
export const MAX_ASSISTANT_TEXT = 4000;
export const MAX_THREAD_ITEMS = 40;

const iso = (value: DateTime.Utc | null | undefined): string | null =>
  value == null ? null : DateTime.formatIso(value);

const millis = (value: DateTime.Utc | null | undefined): number | null =>
  value == null ? null : DateTime.toEpochMillis(value);

/** First non-empty line, whitespace collapsed, cut to `max` characters. */
export function oneLine(text: string | null | undefined, max = MAX_LAST_LINE): string {
  const line =
    (text ?? "")
      .split("\n")
      .map((part) => part.replace(/\s+/gu, " ").trim())
      .find((part) => part.length > 0) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const WORKING_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

type StateInput = Pick<
  OrchestrationV2ThreadShell,
  | "pendingRuntimeRequest"
  | "status"
  | "activityRunStatus"
  | "snoozedUntil"
  | "lastError"
  | "lastVisitedAt"
  | "latestRunCompletedAt"
  | "updatedAt"
  | "settledAt"
  | "settledOverride"
>;

export function isShellThreadSettled(
  shell: Pick<OrchestrationV2ThreadShell, "settledAt" | "settledOverride">,
): boolean {
  if (shell.settledOverride === "settled") return true;
  if (shell.settledOverride === "active") return false;
  return shell.settledAt !== null;
}

/** PROTOCOL.md's state rules, first match wins. */
export function deriveThreadState(shell: StateInput, nowMs: number): BarThreadState {
  if (shell.pendingRuntimeRequest !== null) return "waiting";
  if (
    WORKING_STATUSES.has(shell.status) ||
    (shell.activityRunStatus != null && WORKING_STATUSES.has(shell.activityRunStatus))
  ) {
    return "working";
  }
  const snoozedUntil = millis(shell.snoozedUntil);
  if (snoozedUntil !== null && snoozedUntil > nowMs) return "snoozed";
  const visitedAt = millis(shell.lastVisitedAt) ?? Number.NEGATIVE_INFINITY;
  const lastError = shell.lastError?.trim() ? shell.lastError : null;
  if (shell.status === "failed" || lastError !== null) {
    const failedAt = millis(shell.latestRunCompletedAt) ?? millis(shell.updatedAt) ?? 0;
    if (visitedAt < failedAt) return "failed";
  }
  const settled = isShellThreadSettled(shell);
  const completedAt = millis(shell.latestRunCompletedAt);
  if (completedAt !== null && completedAt > visitedAt && !settled) return "unread";
  if (settled) return "settled";
  return "idle";
}

export interface ShellRowExtras {
  readonly projectTitle: string;
  readonly request: BarRequest | null;
  readonly queuedCount: number;
  /**
   * The newest timeline entry from a thread snapshot (a running tool while
   * working). The shell itself carries no message text.
   */
  readonly latest: string | null;
}

export function toThreadRow(
  shell: OrchestrationV2ThreadShell,
  extras: ShellRowExtras,
  nowMs: number,
): BarThreadRow {
  const state = deriveThreadState(shell, nowMs);
  const pending = shell.pendingRuntimeRequest;
  const known =
    pending !== null && extras.request !== null && extras.request.id === pending.id
      ? extras.request
      : null;
  // Until the thread's own snapshot arrives, the shell only knows the kind.
  const request: BarRowRequest | null =
    pending === null
      ? null
      : known !== null
        ? {
            id: known.id,
            kind: known.kind,
            title: known.title,
            summary: known.summary,
            decisions: known.decisions,
            hasQuestions: known.questions.length > 0,
          }
        : {
            id: pending.id,
            kind: pending.kind,
            title: `${requestKindTitle(pending.kind)}${extras.projectTitle ? ` in ${extras.projectTitle}` : ""}`,
            summary: requestKindTitle(pending.kind),
            decisions: [],
            hasQuestions: pending.kind === "user_input",
          };
  const error = shell.lastError?.trim() ? oneLine(shell.lastError) : null;
  const lastLine =
    state === "waiting" && request !== null
      ? oneLine(request.summary)
      : state === "failed" && error !== null
        ? error
        : oneLine(extras.latest ?? shell.latestVisibleMessage?.text);
  return {
    id: shell.id,
    projectId: shell.projectId,
    projectTitle: extras.projectTitle,
    title: shell.title,
    state,
    request,
    lastLine,
    updatedAt: DateTime.formatIso(shell.updatedAt),
    runStartedAt:
      state === "working"
        ? (iso(shell.activityRunStartedAt) ?? iso(shell.latestRunStartedAt))
        : null,
    activeRunId: shell.activeRunId,
    queuedCount: extras.queuedCount,
    pinned: shell.pinnedAt != null,
    snoozedUntil: iso(shell.snoozedUntil),
    error,
  };
}

/**
 * Active, undeleted, top-level threads. Archived ones live in their own
 * snapshot list, and subagent threads report to their parent instead.
 */
export function isListedThread(shell: OrchestrationV2ThreadShell): boolean {
  return (
    shell.archivedAt === null &&
    shell.deletedAt === null &&
    shell.lineage.relationshipToParent !== "subagent"
  );
}

export function toProjectRow(project: OrchestrationProjectShell) {
  return { id: project.id, title: project.title, cwd: project.workspaceRoot };
}

// --- Requests ---------------------------------------------------------------

/** Short verb phrase for a request kind, used in titles and notification bodies. */
export function requestKindTitle(kind: string): string {
  switch (kind) {
    case "command":
      return "Run a command";
    case "file-read":
      return "Read files";
    case "file-change":
      return "Change files";
    case "mcp-elicitation":
      return "Grant app access";
    case "permission":
      return "Grant a permission";
    case "user_input":
      return "Answer a question";
    case "auth_refresh":
      return "Sign in again";
    case "dynamic_tool_call":
      return "Run a tool";
    default:
      return "Respond to a request";
  }
}

/** The web composer's choices when the provider advertises none. */
const DEFAULT_DECISIONS: ReadonlyArray<ProviderApprovalDecision> = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
];

type RequestProjection = Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">;

/**
 * A pending request of the thread: `requestId` when it is still pending,
 * otherwise the first one in the order the web composer shows them.
 */
export function deriveBarRequest(
  projection: RequestProjection,
  projectTitle: string | null,
  requestId?: string,
): BarRequest | null {
  const pending = derivePendingThreadRequests(projection);
  const wanted = (candidate: { readonly requestId: string }) => candidate.requestId === requestId;
  const preferApproval = pending.approvals.some(wanted) || !pending.userInputs.some(wanted);
  const approvals = preferApproval ? pending.approvals : [];
  const userInputs = pending.userInputs;
  const where = projectTitle ? ` in ${projectTitle}` : "";
  const approval = approvals.find(wanted) ?? approvals[0];
  if (approval !== undefined) {
    const verb =
      approval.requestKind === "mcp-elicitation" && approval.appName
        ? `${approval.appName} requests access`
        : requestKindTitle(approval.requestKind);
    const detail = approval.detail?.trim() ? approval.detail : null;
    return {
      id: approval.requestId,
      kind: approval.requestKind,
      title: `${verb}${where}`,
      detail,
      decisions: approval.options?.map((option) => option.decision) ?? DEFAULT_DECISIONS,
      questions: [],
      summary: detail ? `${verb}: ${oneLine(detail)}` : verb,
    };
  }
  const input = userInputs.find(wanted) ?? userInputs[0];
  if (input !== undefined) {
    const first = input.questions[0];
    return {
      id: input.requestId,
      kind: "user_input",
      title:
        input.questions.length === 1 && first
          ? first.header
          : `Answer ${input.questions.length} questions`,
      detail: first?.question ?? null,
      decisions: [],
      questions: input.questions.map((question) => ({
        id: question.id,
        header: question.header,
        question: question.question,
        multiSelect: question.multiSelect,
        options: question.options.map((option) => ({
          label: option.label,
          description: option.description,
        })),
      })),
      summary: first ? oneLine(first.question) : requestKindTitle("user_input"),
    };
  }
  // Auth refreshes and dynamic tool calls carry no display item.
  const others = projection.runtimeRequests.filter((request) => request.status === "pending");
  const other = others.find((request) => request.id === requestId) ?? others[0];
  if (other === undefined) return null;
  return {
    id: other.id,
    kind: other.kind,
    title: `${requestKindTitle(other.kind)}${where}`,
    detail: null,
    decisions: [],
    questions: [],
    summary: requestKindTitle(other.kind),
  };
}

/**
 * Maps the panel's answers (option labels or free text per question) to what
 * `runtime-request.respond` expects: an option's value, a list for
 * multi-select questions, a string otherwise.
 */
export function buildRequestAnswers(
  projection: RequestProjection,
  requestId: string,
  answers: Readonly<Record<string, ReadonlyArray<string>>>,
): Record<string, string | string[]> {
  const input = derivePendingThreadRequests(projection).userInputs.find(
    (candidate) => candidate.requestId === requestId,
  );
  const result: Record<string, string | string[]> = {};
  for (const [questionId, entries] of Object.entries(answers)) {
    const question = input?.questions.find((candidate) => candidate.id === questionId);
    const values = entries.map(
      (entry) =>
        question?.options.find((option) => option.label === entry)?.value ??
        question?.options.find((option) => option.label === entry)?.label ??
        entry,
    );
    result[questionId] = question?.multiSelect ? values : (values[0] ?? "");
  }
  return result;
}

// --- Thread items -----------------------------------------------------------

const basename = (path: string) =>
  path
    .replace(/[/\\]+$/u, "")
    .split(/[/\\]/u)
    .pop() ?? path;

function field(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of keys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** One line naming what a tool item did, such as `read PreviewView.tsx`. */
export function toolLine(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "command_execution":
      return oneLine(item.input) || item.title || "command";
    case "file_change": {
      const verb =
        item.changes?.[0]?.operation === "add" || item.changes?.[0]?.operation === "create"
          ? "create"
          : item.changes?.[0]?.operation === "delete"
            ? "delete"
            : "edit";
      const extra = (item.changes?.length ?? 1) > 1 ? ` +${item.changes!.length - 1}` : "";
      return `${verb} ${basename(item.fileName)}${extra}`;
    }
    case "file_search":
      return oneLine(`search ${item.pattern ?? item.title ?? ""}`);
    case "web_search":
      return oneLine(`web search ${item.patterns?.join(", ") ?? item.title ?? ""}`);
    case "subagent":
      return oneLine(`agent ${item.prompt}`);
    case "dynamic_tool": {
      const name = item.toolName ?? item.title ?? "tool";
      const path = field(item.input, ["file_path", "filePath", "path", "notebook_path"]);
      if (path !== undefined) return oneLine(`${toolVerb(name)} ${basename(path)}`);
      const arg = field(item.input, [
        "command",
        "pattern",
        "query",
        "url",
        "description",
        "prompt",
      ]);
      return oneLine(arg === undefined ? name : `${toolVerb(name)} ${arg}`);
    }
    default:
      return null;
  }
}

/** `Read` → `read`, `mcp__t3-code__preview_open` → `preview_open`. */
function toolVerb(name: string): string {
  const short = name.includes("__") ? name.split("__").pop()! : name;
  return short.length <= 24 ? short.toLowerCase() : short;
}

function toolStatus(item: OrchestrationV2TurnItem): "running" | "done" | "failed" {
  switch (item.status) {
    case "idle":
    case "pending":
    case "running":
    case "waiting":
      return "running";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "failed";
    case "completed":
      if (
        item.type === "command_execution" &&
        (item.outputIndicatesFailure === true ||
          (item.exitCode !== undefined && item.exitCode !== 0))
      ) {
        return "failed";
      }
      return "done";
  }
}

export function toBarItem(item: OrchestrationV2TurnItem): BarItem | null {
  switch (item.type) {
    case "user_message":
      return item.text.trim() ? { kind: "user", text: item.text } : null;
    case "assistant_message": {
      if (!item.text.trim()) return null;
      return item.text.length > MAX_ASSISTANT_TEXT
        ? { kind: "assistant", text: item.text.slice(0, MAX_ASSISTANT_TEXT), truncated: true }
        : { kind: "assistant", text: item.text };
    }
    case "error":
      return { kind: "error", text: oneLine(item.failure.message, 1000) };
    default: {
      const text = toolLine(item);
      return text === null ? null : { kind: "tool", text, status: toolStatus(item) };
    }
  }
}

type ItemsProjection = Pick<OrchestrationV2ThreadProjection, "visibleTurnItems" | "runs">;

/** The last visible entries, oldest first. Queued messages show under `queued` instead. */
export function deriveBarItems(projection: ItemsProjection, limit = MAX_THREAD_ITEMS): BarItem[] {
  const queuedRunIds = new Set(
    projection.runs.filter((run) => run.status === "queued").map((run) => run.id),
  );
  const items: BarItem[] = [];
  for (let index = projection.visibleTurnItems.length - 1; index >= 0; index -= 1) {
    const item = projection.visibleTurnItems[index]!.item;
    if (item.type === "user_message" && item.runId !== null && queuedRunIds.has(item.runId)) {
      continue;
    }
    const mapped = toBarItem(item);
    if (mapped === null) continue;
    items.push(mapped);
    if (items.length >= limit) break;
  }
  return items.reverse();
}

/** The newest visible entry as one line, for the shell row. */
export function deriveLastLine(projection: ItemsProjection): string | null {
  const latest = deriveBarItems(projection, 1)[0];
  return latest === undefined ? null : oneLine(latest.text);
}

export function deriveQueued(
  projection: OrchestrationV2ThreadProjection,
): Array<{ readonly id: string; readonly text: string }> {
  return deriveThreadQueueWorkflowState(projection).queuedRuns.map((queued) => ({
    id: queued.run.id,
    text: queued.text,
  }));
}

// --- Launch options ---------------------------------------------------------

export interface BarModelOption {
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
}

const isSelectableProvider = (provider: ServerProvider) =>
  provider.enabled && provider.availability !== "unavailable";

function defaultModelFor(provider: ServerProvider): string | undefined {
  return (
    provider.models.find((model) => model.isDefault && !model.isCustom)?.slug ??
    provider.models.find((model) => !model.isCustom)?.slug ??
    provider.models[0]?.slug ??
    DEFAULT_MODEL_BY_PROVIDER[provider.driver]
  );
}

/** Models of enabled, available provider instances, labelled like the web picker. */
export function deriveModelOptions(providers: ReadonlyArray<ServerProvider>): BarModelOption[] {
  const selectable = providers.filter(isSelectableProvider);
  const options = selectable.flatMap((provider) =>
    provider.models
      .filter((model) => model.isLegacy !== true)
      .map((model) => ({ provider, model })),
  );
  const nameCounts = new Map<string, number>();
  for (const { model } of options)
    nameCounts.set(model.name, (nameCounts.get(model.name) ?? 0) + 1);
  return options.map(({ provider, model }) => ({
    instanceId: provider.instanceId,
    model: model.slug,
    label:
      (nameCounts.get(model.name) ?? 0) > 1
        ? `${model.name} (${provider.displayName ?? provider.instanceId})`
        : model.name,
  }));
}

/**
 * The web's new-thread default: a configured selection when its instance is
 * still usable, otherwise the first ready instance (then any non-error one)
 * with that instance's own default model.
 */
export function resolveDefaultModel(
  providers: ReadonlyArray<ServerProvider>,
  configured: ModelSelection | null | undefined,
): ModelSelection | null {
  if (configured != null) {
    const requested = providers.find((provider) => provider.instanceId === configured.instanceId);
    if (requested !== undefined && isSelectableProvider(requested)) return configured;
  }
  const fallback =
    providers.find((provider) => isSelectableProvider(provider) && provider.status === "ready") ??
    providers.find((provider) => isSelectableProvider(provider) && provider.status !== "error");
  if (fallback === undefined) return null;
  const model = defaultModelFor(fallback);
  return model === undefined ? null : { instanceId: fallback.instanceId, model };
}

// --- Ops --------------------------------------------------------------------

export type BarOp =
  | { readonly op: "open"; readonly id?: string; readonly threadId: string }
  | { readonly op: "close"; readonly id?: string }
  | {
      readonly op: "reply";
      readonly id?: string;
      readonly threadId: string;
      readonly text: string;
      readonly mode: "auto" | "queue" | "steer";
    }
  | { readonly op: "sendAll"; readonly id?: string; readonly threadId: string }
  | {
      readonly op: "respond";
      readonly id?: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly decision: ProviderApprovalDecision;
    }
  | {
      readonly op: "answer";
      readonly id?: string;
      readonly threadId: string;
      readonly requestId: string;
      readonly answers: Readonly<Record<string, ReadonlyArray<string>>>;
    }
  | {
      readonly op: "dismiss";
      readonly id?: string;
      readonly threadId: string;
      readonly requestId: string;
    }
  | {
      readonly op: "stop" | "settle" | "unsettle" | "pin" | "unpin" | "unsnooze";
      readonly id?: string;
      readonly threadId: string;
    }
  | {
      readonly op: "snooze";
      readonly id?: string;
      readonly threadId: string;
      readonly until: string;
    }
  | {
      readonly op: "launch";
      readonly id?: string;
      readonly projectId: string;
      readonly text: string;
      readonly model?: { readonly instanceId: string; readonly model: string };
    }
  | { readonly op: "refresh"; readonly id?: string };

export type ParsedOp =
  | { readonly ok: true; readonly op: BarOp }
  | { readonly ok: false; readonly id?: string; readonly message: string };

const DECISIONS: ReadonlySet<string> = new Set([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);

const THREAD_ONLY_OPS = new Set([
  "stop",
  "settle",
  "unsettle",
  "pin",
  "unpin",
  "unsnooze",
  "sendAll",
]);

/** Parses one NDJSON line from the panel. Never throws. */
export function parseOp(line: string): ParsedOp {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, message: "Op is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "Op must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const id =
    typeof record.id === "string"
      ? record.id
      : typeof record.id === "number"
        ? String(record.id)
        : undefined;
  const withId = id === undefined ? {} : { id };
  const fail = (message: string): ParsedOp => ({ ok: false, ...withId, message });
  const str = (key: string) =>
    typeof record[key] === "string" && (record[key] as string).length > 0
      ? (record[key] as string)
      : undefined;
  const op = record.op;
  if (typeof op !== "string") return fail("Op is missing `op`");

  const threadId = str("threadId");
  const needThread = () => (threadId === undefined ? fail(`${op} needs threadId`) : null);

  switch (op) {
    case "refresh":
    case "close":
      return { ok: true, op: { op, ...withId } };
    case "open":
      return needThread() ?? { ok: true, op: { op, ...withId, threadId: threadId! } };
    case "reply": {
      const text = str("text");
      const mode = record.mode ?? "auto";
      if (needThread()) return needThread()!;
      if (text === undefined || !text.trim()) return fail("reply needs text");
      if (mode !== "auto" && mode !== "queue" && mode !== "steer") {
        return fail("reply mode is auto, queue or steer");
      }
      return { ok: true, op: { op, ...withId, threadId: threadId!, text, mode } };
    }
    case "respond": {
      const requestId = str("requestId");
      const decision = str("decision");
      if (needThread()) return needThread()!;
      if (requestId === undefined) return fail("respond needs requestId");
      if (decision === undefined || !DECISIONS.has(decision)) {
        return fail("respond needs a decision the server accepts");
      }
      return {
        ok: true,
        op: {
          op,
          ...withId,
          threadId: threadId!,
          requestId,
          decision: decision as ProviderApprovalDecision,
        },
      };
    }
    case "answer": {
      const requestId = str("requestId");
      if (needThread()) return needThread()!;
      if (requestId === undefined) return fail("answer needs requestId");
      const answers = record.answers;
      if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
        return fail("answer needs answers as an object");
      }
      const normalized: Record<string, ReadonlyArray<string>> = {};
      for (const [key, value] of Object.entries(answers)) {
        if (typeof value === "string") normalized[key] = [value];
        else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
          normalized[key] = value;
        } else return fail(`answer for ${key} must be a string or a list of strings`);
      }
      return {
        ok: true,
        op: { op, ...withId, threadId: threadId!, requestId, answers: normalized },
      };
    }
    case "dismiss": {
      const requestId = str("requestId");
      if (needThread()) return needThread()!;
      if (requestId === undefined) return fail("dismiss needs requestId");
      return { ok: true, op: { op, ...withId, threadId: threadId!, requestId } };
    }
    case "snooze": {
      const until = str("until");
      if (needThread()) return needThread()!;
      if (until === undefined || Number.isNaN(Date.parse(until))) {
        return fail("snooze needs until as an ISO time");
      }
      return { ok: true, op: { op, ...withId, threadId: threadId!, until } };
    }
    case "launch": {
      const projectId = str("projectId");
      const text = str("text");
      if (projectId === undefined) return fail("launch needs projectId");
      if (text === undefined || !text.trim()) return fail("launch needs text");
      const model = record.model;
      if (model !== undefined && model !== null) {
        const selection = model as Record<string, unknown>;
        if (typeof selection.instanceId !== "string" || typeof selection.model !== "string") {
          return fail("launch model needs instanceId and model");
        }
        return {
          ok: true,
          op: {
            op,
            ...withId,
            projectId,
            text,
            model: { instanceId: selection.instanceId, model: selection.model },
          },
        };
      }
      return { ok: true, op: { op, ...withId, projectId, text } };
    }
    default:
      if (THREAD_ONLY_OPS.has(op)) {
        return (
          needThread() ?? {
            ok: true,
            op: { op: op as "stop", ...withId, threadId: threadId! },
          }
        );
      }
      return fail(`Unknown op ${op}`);
  }
}
