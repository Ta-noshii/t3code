import { PROVIDER_DISPLAY_NAMES, type ProviderDriverKind } from "@t3tools/contracts";
import { resolveT3McpToolKey } from "@t3tools/shared/t3McpToolPresentation";

import { toolFieldLabel, type ToolStatusTone, toolStatusTone } from "./toolValue.ts";

/**
 * What a tool call did, in the terms a person skimming the timeline cares
 * about: an outcome, the thing it acted on, the model or page involved, any
 * text worth reading, and links to the threads it touched. Internal IDs and
 * bookkeeping go to `details`, which clients keep collapsed.
 *
 * T3's own tools get presenters written for their results; every other
 * structured result goes through the same rules generically.
 */
export interface ToolDigestStatus {
  readonly label: string;
  readonly tone: ToolStatusTone;
}

/** What a digest is about, so clients can mark it with an icon. */
export type ToolDigestKind =
  | "task"
  | "thread"
  | "message"
  | "page"
  | "models"
  | "schedule"
  | "project"
  | "request"
  | "list";

/** Icons for facts in a digest's meta line. Clients map them to their own glyphs. */
export type ToolDigestIcon =
  | "clock"
  | "viewport"
  | "branch"
  | "runs"
  | "folder"
  | "repeat"
  | "calendar"
  | "pointer"
  | "alert"
  | "link"
  | "pause"
  | "loading"
  | "info";

/** One fact beside the title: a model (drawn with its provider's logo) or a short line. */
export type ToolDigestMeta =
  | {
      readonly kind: "model";
      readonly providerInstanceId?: string | undefined;
      readonly model?: string | undefined;
      readonly effort?: string | undefined;
    }
  | { readonly kind: "fact"; readonly text: string; readonly icon?: ToolDigestIcon | undefined };

export interface ToolDigestRow {
  readonly title: string;
  readonly kind?: ToolDigestKind | undefined;
  /** Provider instance the row stands for, drawn with its logo. */
  readonly providerInstanceId?: string | undefined;
  readonly detail?: string | undefined;
  readonly status?: ToolDigestStatus | undefined;
  readonly threadId?: string | undefined;
  readonly href?: string | undefined;
  readonly chips?: readonly string[] | undefined;
}

export interface ToolDigest {
  readonly kind?: ToolDigestKind | undefined;
  readonly status?: ToolDigestStatus | undefined;
  /** The thing the call acted on or produced: a task name, page title, thread title. */
  readonly title?: string | undefined;
  readonly href?: string | undefined;
  /** Short facts read alongside the title: model, viewport, counts. */
  readonly meta: readonly ToolDigestMeta[];
  readonly threads: ReadonlyArray<{ readonly threadId: string; readonly label: string }>;
  /** Text worth reading in full, rendered as markdown. */
  readonly text?: string | undefined;
  readonly textLabel?: string | undefined;
  readonly rows?: readonly ToolDigestRow[] | undefined;
  /** Said instead of an empty list. */
  readonly empty?: string | undefined;
  readonly error?: string | undefined;
  /** Everything else, as label and value, for a collapsed details section. */
  readonly details: ReadonlyArray<readonly [string, string]>;
}

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ID_KEY = /(^id$|Id$|_id$|Ids$|^sequence$|^cursor$|Cursor$)/u;
const NOISE_KEYS = new Set(["toolIcon", "_tag", "clientRequestId"]);

/** Machine identifiers: keys named like ids, uuids, and `kind:...` references. */
function isOpaqueId(key: string, value: unknown): boolean {
  if (ID_KEY.test(key)) return true;
  const text = str(value);
  if (text === undefined) return false;
  return UUID.test(text) || (/^[a-z][a-z-]*:\S+$/u.test(text) && text.length > 24);
}

function isThreadKey(key: string): boolean {
  return /(^t|T)hreadId$/u.test(key);
}

/** "cancel_requested" → "Cancel requested". */
export function statusLabel(raw: string): string {
  const special: Record<string, string> = {
    cancel_requested: "Cancelling",
    in_progress: "In progress",
    needs_input: "Needs input",
  };
  const key = raw.trim().toLowerCase();
  if (special[key]) return special[key];
  const words = key.replace(/[_-]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function digestStatus(raw: unknown): ToolDigestStatus | undefined {
  const text = str(raw);
  return text === undefined ? undefined : { label: statusLabel(text), tone: toolStatusTone(text) };
}

export function providerLabel(providerInstanceId: string): string {
  const known = PROVIDER_DISPLAY_NAMES[providerInstanceId as ProviderDriverKind];
  if (known) return known;
  if (/^claude/iu.test(providerInstanceId)) return "Claude";
  return toolFieldLabel(providerInstanceId);
}

function fact(text: string, icon?: ToolDigestIcon): ToolDigestMeta {
  return { kind: "fact", text, ...(icon ? { icon } : {}) };
}

function facts(...items: Array<ToolDigestMeta | undefined>): ToolDigestMeta[] {
  return items.filter((item): item is ToolDigestMeta => item !== undefined);
}

/** The model a task or thread runs on, with its provider and reasoning effort. */
function modelMeta(
  fields: Fields,
  providerKey = "providerInstanceId",
  modelKey = "model",
): ToolDigestMeta[] {
  const providerInstanceId = str(fields[providerKey]);
  const model = str(fields[modelKey]);
  const effort = isRecord(fields.options) ? str(fields.options.reasoningEffort) : undefined;
  if (!providerInstanceId && !model) return [];
  return [
    {
      kind: "model",
      ...(providerInstanceId ? { providerInstanceId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    },
  ];
}

/** "Codex gpt-6.1-sol, medium effort", or the fact's text. */
export function toolDigestMetaText(meta: ToolDigestMeta): string {
  if (meta.kind === "fact") return meta.text;
  const label = [
    meta.providerInstanceId ? providerLabel(meta.providerInstanceId) : undefined,
    meta.model,
  ]
    .filter(Boolean)
    .join(" ");
  return meta.effort ? `${label}, ${meta.effort} effort` : label;
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} h`;
}

/** The caller's name for a delegated task, kept at the end of its id: `...delegate-task:wiki-perf-1`. */
export function delegatedTaskName(taskId: string | undefined): string | undefined {
  if (taskId === undefined) return undefined;
  let decoded = taskId;
  try {
    decoded = decodeURIComponent(decodeURIComponent(taskId));
  } catch {
    // Keep the raw id.
  }
  return /delegate-task:([^:]+)$/u.exec(decoded)?.[1];
}

const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "2026-10-05T11:32:36.755Z" → "Oct 5, 11:32 AM" in the viewer's zone. */
export function timeLabel(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : TIME_FORMAT.format(ms);
}

/** "https://host/path?query" → "host/path"; the full URL stays on the title link. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function detailValue(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Details for every field the presenter did not use. */
function restDetails(fields: Fields, used: ReadonlySet<string>): Array<readonly [string, string]> {
  return Object.entries(fields).flatMap(([key, value]) => {
    if (used.has(key) || NOISE_KEYS.has(key)) return [];
    const text = detailValue(value);
    return text === undefined ? [] : [[toolFieldLabel(key), text] as const];
  });
}

function base(): ToolDigest {
  return { meta: [], threads: [], details: [] };
}

function errorDigest(value: unknown): ToolDigest | undefined {
  if (typeof value === "string" && /^error:/iu.test(value.trim())) {
    return {
      ...base(),
      status: { label: "Failed", tone: "error" },
      error: value.trim().replace(/^error:\s*/iu, ""),
    };
  }
  if (isRecord(value) && typeof value._tag === "string" && /(Failure|Error)$/u.test(value._tag)) {
    const message = str(value.message) ?? statusLabel(str(value.code) ?? "failed");
    return {
      ...base(),
      status: { label: "Failed", tone: "error" },
      error: message,
      details: restDetails(value, new Set(["message"])),
    };
  }
  return undefined;
}

/** Argument keys that carry the prompt or code a call sent. */
const CALL_TEXT_KEYS = ["task", "message", "prompt", "expression", "text"] as const;
const TITLE_KEYS = ["title", "name", "displayName", "label", "snippet", "question"] as const;
const TEXT_KEYS = [
  "summary",
  "latestTerminalSummary",
  "result",
  "message",
  "text",
  "prompt",
  "description",
] as const;

function rowFrom(value: unknown): ToolDigestRow | undefined {
  if (!isRecord(value)) {
    const text = detailValue(value);
    return text === undefined ? undefined : { title: text };
  }
  const titleKey = TITLE_KEYS.find((key) => str(value[key]) !== undefined);
  const threadKey = Object.keys(value).find((key) => isThreadKey(key) && str(value[key]));
  const path = str(value.workspaceRoot) ?? str(value.worktreePath) ?? str(value.path);
  const url = str(value.url);
  const title =
    (titleKey ? firstLine(str(value[titleKey])!) : undefined) ?? path ?? url ?? str(value.id);
  if (title === undefined) return undefined;
  const status = digestStatus(value.status ?? value.state);
  const rawTime = str(value.updatedAt) ?? str(value.messageCreatedAt) ?? str(value.createdAt);
  const time = rawTime ? timeLabel(rawTime) : undefined;
  const detailParts = [
    ...modelMeta(value).map(toolDigestMetaText),
    path && path !== title ? path : undefined,
    url && url !== title ? url : undefined,
    str(value.branch),
  ].filter((part): part is string => part !== undefined);
  const kind: ToolDigestKind | undefined = threadKey
    ? "thread"
    : str(value.workspaceRoot)
      ? "project"
      : url
        ? "page"
        : undefined;
  return {
    title,
    ...(kind ? { kind } : {}),
    ...(detailParts.length > 0 ? { detail: detailParts.join("  ") } : {}),
    ...(status ? { status } : {}),
    ...(threadKey ? { threadId: str(value[threadKey])! } : {}),
    ...(url ? { href: url } : {}),
    ...(time && !detailParts.length ? { detail: time } : {}),
  };
}

function rowsFrom(value: unknown): ToolDigestRow[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const row = rowFrom(entry);
        return row ? [row] : [];
      })
    : [];
}

/**
 * The generic presenter: status, a title, model, thread links, the longest
 * text, lists as rows, short scalars as meta. IDs go to details.
 */
function genericDigest(fields: Fields): ToolDigest {
  const used = new Set<string>();
  const take = <T>(key: string, value: T): T => {
    used.add(key);
    return value;
  };
  const statusKey = ["status", "state", "workState"].find((key) => str(fields[key]));
  const status = statusKey ? take(statusKey, digestStatus(fields[statusKey])) : undefined;
  const titleKey = TITLE_KEYS.find((key) => str(fields[key]) && str(fields[key])!.length <= 160);
  const title = titleKey ? take(titleKey, str(fields[titleKey])) : undefined;
  const url = str(fields.url);
  if (url) used.add("url");
  const meta = modelMeta(fields);
  if (meta.length > 0) used.add("providerInstanceId").add("model");
  const threads = Object.keys(fields)
    .filter((key) => isThreadKey(key) && key !== "currentThreadId" && str(fields[key]))
    .map((key) =>
      take(key, {
        threadId: str(fields[key])!,
        label: key === "parentThreadId" ? "Open parent thread" : "Open thread",
      }),
    );
  const textKey = TEXT_KEYS.find((key) => str(fields[key]));
  const text = textKey ? take(textKey, str(fields[textKey])) : undefined;
  const listKey = Object.keys(fields).find(
    (key) => Array.isArray(fields[key]) && (fields[key] as unknown[]).some(isRecord),
  );
  const rows = listKey ? take(listKey, rowsFrom(fields[listKey])) : undefined;
  const emptyListKey = Object.keys(fields).find(
    (key) => Array.isArray(fields[key]) && (fields[key] as unknown[]).length === 0,
  );
  for (const [key, value] of Object.entries(fields)) {
    if (used.has(key) || NOISE_KEYS.has(key) || isOpaqueId(key, value)) continue;
    if (typeof value === "boolean") {
      used.add(key);
      if (value) meta.push(fact(toolFieldLabel(key)));
    } else if (typeof value === "number" && meta.length < 6) {
      used.add(key);
      meta.push(fact(`${toolFieldLabel(key)} ${value.toLocaleString("en-US")}`));
    } else if (
      typeof value === "string" &&
      value.length <= 60 &&
      !value.includes("\n") &&
      meta.length < 6
    ) {
      used.add(key);
      meta.push(fact(`${toolFieldLabel(key)} ${value}`));
    }
  }
  return {
    ...(status ? { status } : {}),
    ...(title ? { title } : url ? { title: url } : {}),
    ...(url ? { href: url } : {}),
    meta,
    threads,
    ...(text ? { text } : {}),
    ...(rows && rows.length > 0 ? { rows } : {}),
    ...(!rows?.length && emptyListKey
      ? { empty: `No ${toolFieldLabel(emptyListKey).toLowerCase()}` }
      : {}),
    details: restDetails(fields, used),
  };
}

/** delegate_task, task_status, task_cancel: one subagent task. */
function taskDigest(fields: Fields, input: Fields | undefined, tool: string): ToolDigest {
  const terminal = str(fields.latestTerminalStatus);
  const raw = terminal ?? str(fields.status);
  const name =
    str(input?.title) ??
    delegatedTaskName(str(fields.taskId) ?? str(input?.taskId)) ??
    (str(input?.task) ? firstLine(str(input!.task)!, 80) : undefined);
  const waiting = str(fields.workState) === "waiting" || fields.hasPendingChildRuns === true;
  const status: ToolDigestStatus | undefined =
    raw === "running" && waiting
      ? { label: "Waiting for input", tone: "warning" }
      : digestStatus(raw);
  const meta = modelMeta(fields);
  const waitMs = num(Number(input?.waitMs));
  if (fields.waitTimedOut === true) {
    meta.push(
      fact(
        waitMs ? `Still running after ${durationLabel(waitMs)}` : "Still running after the wait",
        "clock",
      ),
    );
  }
  const text = str(fields.summary) ?? str(fields.latestTerminalSummary);
  const childThreadId = str(fields.childThreadId);
  return {
    kind: "task",
    ...(status ? { status } : {}),
    ...(name ? { title: name } : {}),
    meta,
    threads: childThreadId ? [{ threadId: childThreadId, label: "Open task thread" }] : [],
    ...(text ? { text, textLabel: tool === "task_cancel" ? undefined : "Result" } : {}),
    details: restDetails(
      fields,
      new Set([
        "status",
        "workState",
        "latestTerminalStatus",
        "providerInstanceId",
        "model",
        "summary",
        "latestTerminalSummary",
        "waitTimedOut",
        "hasPendingChildRuns",
      ]),
    ),
  };
}

function threadDigest(thread: Fields): ToolDigest {
  const digest = genericDigest(thread);
  const runs = num(thread.runCount);
  const pending = num(thread.pendingRequestCount);
  const branch = str(thread.branch);
  const threadId = str(thread.threadId);
  return {
    ...digest,
    kind: "thread",
    meta: [
      ...modelMeta(thread),
      ...facts(
        branch ? fact(branch, "branch") : undefined,
        runs !== undefined ? fact(`${runs} ${runs === 1 ? "run" : "runs"}`, "runs") : undefined,
        pending ? fact(`${pending} pending requests`, "alert") : undefined,
      ),
    ],
    threads: threadId ? [{ threadId, label: "Open thread" }] : digest.threads,
  };
}

function previewDigest(fields: Fields): ToolDigest {
  const viewport = isRecord(fields.viewport) ? fields.viewport : undefined;
  const size =
    viewport && num(viewport.width) && num(viewport.height)
      ? `${viewport.width}×${viewport.height}`
      : undefined;
  const consoleErrors = Array.isArray(fields.consoleEntries)
    ? fields.consoleEntries.filter((entry) => isRecord(entry) && entry.level === "error").length
    : 0;
  const elements = Array.isArray(fields.interactiveElements)
    ? fields.interactiveElements.length
    : 0;
  const url = str(fields.url);
  const title = str(fields.title);
  const meta = facts(
    title && url ? fact(shortUrl(url), "link") : undefined,
    size ? fact(size, "viewport") : undefined,
    fields.loading === true ? fact("Loading", "loading") : undefined,
    elements ? fact(`${elements} interactive elements`, "pointer") : undefined,
    consoleErrors ? fact(`${consoleErrors} console errors`, "alert") : undefined,
  );
  const value = "value" in fields ? fields.value : undefined;
  return {
    ...(title || url ? { kind: "page" as const } : {}),
    ...(title ? { title } : url ? { title: url } : {}),
    ...(url ? { href: url } : {}),
    meta,
    threads: [],
    ...(value !== undefined
      ? { text: "```json\n" + JSON.stringify(value, null, 2) + "\n```", textLabel: "Returned" }
      : {}),
    details: restDetails(
      fields,
      new Set([
        "url",
        "title",
        "viewport",
        "loading",
        "value",
        "interactiveElements",
        "consoleEntries",
        "networkEntries",
        "visibleText",
      ]),
    ),
  };
}

function scheduleLabel(schedule: unknown): string | undefined {
  if (!isRecord(schedule)) return undefined;
  if (schedule.type === "interval" && num(schedule.everyMs)) {
    return `Every ${durationLabel(schedule.everyMs as number)}`;
  }
  if (schedule.type === "fixed_time" && str(schedule.timeOfDay))
    return `Daily at ${schedule.timeOfDay}`;
  return undefined;
}

function scheduledTaskDigest(fields: Fields): ToolDigest {
  const digest = genericDigest(fields);
  const every = scheduleLabel(fields.schedule);
  const nextRunAt = str(fields.nextRunAt);
  const meta = facts(
    every ? fact(every, "repeat") : undefined,
    fields.enabled === false ? fact("Paused", "pause") : undefined,
    nextRunAt ? fact(`Next run ${timeLabel(nextRunAt)}`, "calendar") : undefined,
  );
  return {
    ...digest,
    kind: "schedule",
    status: digestStatus(fields.lastRunStatus === "never" ? undefined : fields.lastRunStatus) ?? {
      label: "Scheduled",
      tone: "info",
    },
    meta,
    threads: [],
  };
}

function capabilitiesDigest(fields: Fields): ToolDigest {
  const providers = Array.isArray(fields.providers) ? fields.providers.filter(isRecord) : [];
  const rows = providers.map((provider) => {
    const models = Array.isArray(provider.models) ? provider.models.filter(isRecord) : [];
    const providerInstanceId = str(provider.providerInstanceId);
    return {
      title: str(provider.displayName) ?? providerLabel(providerInstanceId ?? "provider"),
      ...(providerInstanceId ? { providerInstanceId } : {}),
      chips: models.map((model) => str(model.label) ?? str(model.id) ?? "model"),
    };
  });
  const inherited = modelMeta(fields, "inheritedProviderInstanceId", "inheritedModel");
  const hidden = num(fields.hiddenModelCount);
  return {
    kind: "models",
    title: `${rows.reduce((total, row) => total + row.chips.length, 0)} models available`,
    meta: [
      ...(inherited.length ? [fact("This thread"), ...inherited] : []),
      ...facts(hidden ? fact(`${hidden} hidden`) : undefined),
    ],
    threads: [],
    rows,
    details: [],
  };
}

function presenterDigest(tool: string, fields: Fields, input: Fields | undefined): ToolDigest {
  switch (tool) {
    case "delegate_task":
    case "task_status":
    case "task_cancel":
      return taskDigest(fields, input, tool);
    case "t3_thread_read":
      return isRecord(fields.thread) ? threadDigest(fields.thread) : genericDigest(fields);
    case "t3_thread_send": {
      const digest = genericDigest(fields);
      const delivery = str(fields.delivery);
      return {
        ...digest,
        kind: "message",
        title: delivery === "queued" ? "Message queued" : "Message sent",
        meta: [],
        threads: digest.threads.map((thread) => ({ ...thread, label: "Open thread" })),
      };
    }
    case "t3_thread_list":
    case "t3_thread_search":
    case "t3_project_list":
    case "t3_worktree_list":
    case "t3_queue_list":
    case "list_scheduled_tasks":
    case "device_list":
    case "t3_preview_list": {
      const digest = genericDigest(fields);
      const total = num(fields.total) ?? digest.rows?.length ?? 0;
      return {
        ...digest,
        kind: "list",
        title: digest.rows?.length
          ? `${total} ${total === 1 ? "result" : "results"}`
          : (digest.title ?? ""),
        meta: [],
        empty: digest.rows?.length ? undefined : (digest.empty ?? "Nothing found"),
      };
    }
    case "t3_project_create":
    case "t3_project_read":
    case "t3_project_update": {
      const project = isRecord(fields.project) ? fields.project : fields;
      const digest = genericDigest(project);
      const root = str(project.workspaceRoot);
      return { ...digest, kind: "project", meta: root ? [fact(root, "folder")] : [] };
    }
    case "orchestrator_capabilities":
      return capabilitiesDigest(fields);
    case "schedule_task":
    case "update_scheduled_task":
      return scheduledTaskDigest(fields);
    case "t3_pending_request_list": {
      const ids = Array.isArray(fields.requestIds) ? fields.requestIds : [];
      return ids.length
        ? {
            ...base(),
            kind: "request",
            title: `${ids.length} pending ${ids.length === 1 ? "request" : "requests"}`,
            details: ids.map((id, index) => [`Request ${index + 1}`, String(id)] as const),
          }
        : { ...base(), empty: "No pending requests" };
    }
    case "t3_pending_request_read": {
      const questions = Array.isArray(fields.questions) ? fields.questions.filter(isRecord) : [];
      return {
        ...base(),
        kind: "request",
        title: questions.length === 1 ? "1 question" : `${questions.length} questions`,
        text: questions.map((question) => `> ${str(question.question) ?? ""}`).join("\n\n"),
        details: restDetails(fields, new Set(["questions"])),
      };
    }
    case "t3_pending_request_respond":
      return {
        ...base(),
        kind: "request",
        title: "Answer sent",
        details: restDetails(fields, new Set()),
      };
    default:
      if (tool.startsWith("preview_") || tool.startsWith("device_")) return previewDigest(fields);
      return genericDigest(fields);
  }
}

/**
 * Digest of a tool's structured result. `value` is the result as data (an
 * MCP `structuredContent`, parsed JSON text) or a string. Returns null when
 * the result is plain text or empty, which clients show as is.
 */
export function toolResultDigest(
  toolName: string | null | undefined,
  value: unknown,
  input?: unknown,
): ToolDigest | null {
  const failure = errorDigest(value);
  if (failure) return failure;
  const t3Tool = resolveT3McpToolKey(toolName);
  const inputFields = isRecord(input) ? input : undefined;
  if (value === null || value === undefined) {
    if (t3Tool === "t3_thread_wait")
      return {
        ...base(),
        kind: "thread",
        status: { label: "Still running", tone: "info" },
        meta: [fact("The wait ended before the thread stopped", "clock")],
      };
    return null;
  }
  if (Array.isArray(value)) {
    const rows = rowsFrom(value);
    return rows.length ? { ...base(), title: `${rows.length} results`, rows } : null;
  }
  if (!isRecord(value)) return null;
  const digest = t3Tool ? presenterDigest(t3Tool, value, inputFields) : genericDigest(value);
  // What the call already shows (the prompt a scheduled task echoes, the
  // model a delegated task was sent to) is not repeated in the result.
  const echoed =
    digest.text !== undefined &&
    inputFields !== undefined &&
    CALL_TEXT_KEYS.some((key) => str(inputFields[key]) === digest.text);
  const target = isRecord(inputFields?.target) ? inputFields.target : undefined;
  const targetModel = target ? str(target.model) : undefined;
  const sameTitle = digest.title !== undefined && digest.title === str(inputFields?.title);
  return {
    ...digest,
    ...(echoed ? { text: undefined, textLabel: undefined } : {}),
    ...(sameTitle ? { title: undefined } : {}),
    meta: digest.meta.filter((meta) => meta.kind !== "model" || meta.model !== targetModel),
  };
}

export interface ToolCallDigest {
  readonly title?: string | undefined;
  readonly meta: readonly ToolDigestMeta[];
  readonly text?: string | undefined;
  readonly textLabel?: string | undefined;
  readonly args: ReadonlyArray<readonly [string, string]>;
  readonly threads: ReadonlyArray<{ readonly threadId: string; readonly label: string }>;
}

/**
 * Digest of a T3 tool's arguments: the prompt or message it sent and the
 * arguments a person would recognize, without the IDs the result already
 * links. Null for other tools, which show their arguments as given.
 */
export function toolCallDigest(
  toolName: string | null | undefined,
  input: unknown,
): ToolCallDigest | null {
  const tool = resolveT3McpToolKey(toolName);
  if (tool === null || !isRecord(input)) return null;
  const used = new Set<string>(["clientRequestId"]);
  const textKey = CALL_TEXT_KEYS.find((key) => str(input[key]));
  if (textKey) used.add(textKey);
  const target = isRecord(input.target) ? input.target : undefined;
  if (target) used.add("target");
  const title = str(input.title);
  if (title) used.add("title");
  const args = Object.entries(input).flatMap(([key, value]) => {
    if (used.has(key) || isOpaqueId(key, value) || value === null || value === undefined) return [];
    const label = toolFieldLabel(key);
    if (key.endsWith("Ms") && num(Number(value)))
      return [[label.replace(/ ms$/u, ""), durationLabel(Number(value))] as const];
    // A flag reads as its name; a false one is the default and says nothing.
    if (typeof value === "boolean") return value ? [[label, ""] as const] : [];
    if (key === "schedule")
      return [[label, scheduleLabel(value) ?? JSON.stringify(value)] as const];
    const text = detailValue(value);
    return text === undefined ? [] : [[label, text] as const];
  });
  const text = textKey ? str(input[textKey]) : undefined;
  return {
    ...(title ? { title } : {}),
    meta: target ? modelMeta(target) : [],
    ...(text
      ? {
          text: textKey === "expression" ? "```js\n" + text + "\n```" : text,
          textLabel: toolFieldLabel(textKey!),
        }
      : {}),
    args,
    threads: [],
  };
}

/** Plain-text form of a digest for clients without the rich view. */
export function toolDigestText(digest: ToolDigest): string {
  return [
    [digest.status?.label, digest.title].filter(Boolean).join(": "),
    digest.meta.map(toolDigestMetaText).join(", "),
    digest.error,
    digest.text,
    ...(digest.rows ?? []).map((row) =>
      [
        row.status ? `[${row.status.label}]` : undefined,
        row.title,
        row.detail,
        row.chips?.join(", "),
      ]
        .filter(Boolean)
        .join("  "),
    ),
    digest.empty,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n");
}
