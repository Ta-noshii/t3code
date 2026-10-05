import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { type ToolImage, toolImageFromValue } from "@t3tools/shared/toolMedia";

/**
 * Display model for tool results. A result becomes a list of blocks (text,
 * an image, or structured data); `toolDigest.ts` turns the data into a
 * summary so clients render values instead of dumping JSON.
 */
export type ToolOutputBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "data"; readonly value: unknown }
  | { readonly kind: "image"; readonly image: ToolImage };

const MAX_BLOCK_DEPTH = 6;
const CONTENT_BLOCK_TYPES = new Set(["text", "image", "audio", "resource", "resource_link"]);
const ENVELOPE_KEYS = new Set(["content", "structuredContent", "isError", "is_error", "_meta"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContentBlock(value: unknown): boolean {
  return isRecord(value) && typeof value.type === "string" && CONTENT_BLOCK_TYPES.has(value.type);
}

function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** JSON text as data: one document, or one document per line as MCP tools often print. */
function jsonDocuments(text: string): unknown[] | undefined {
  const trimmed = text.trim();
  if (!/^[[{]/u.test(trimmed)) return undefined;
  const whole = parseJson(trimmed);
  if (whole !== undefined) return [whole];
  const documents = trimmed
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => parseJson(line.trim()));
  return documents.every((document) => document !== undefined) ? documents : undefined;
}

function blocksFromText(text: string, depth: number): ToolOutputBlock[] {
  if (!text.trim()) return [];
  const documents = jsonDocuments(text);
  if (documents === undefined) return [{ kind: "text", text }];
  return documents.flatMap((document) =>
    isRecord(document) || Array.isArray(document)
      ? blocksFrom(document, depth + 1)
      : [{ kind: "text" as const, text: String(document) }],
  );
}

function blocksFrom(value: unknown, depth: number): ToolOutputBlock[] {
  if (value === undefined || value === null) return [];
  const image = toolImageFromValue(value);
  if (image !== undefined) return [{ kind: "image", image }];
  if (typeof value === "string") return blocksFromText(value, depth);
  if (typeof value !== "object") return [{ kind: "text", text: String(value) }];
  if (depth > MAX_BLOCK_DEPTH) return [{ kind: "data", value }];

  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return value.every(isContentBlock)
      ? value.flatMap((block) => blocksFrom(block, depth + 1))
      : [{ kind: "data", value }];
  }
  if (!isRecord(value)) return [{ kind: "data", value }];

  if (value.type === "text" && typeof value.text === "string") {
    return blocksFromText(value.text, depth);
  }
  // Claude Code's Read result for a text file.
  if (value.type === "text" && isRecord(value.file) && typeof value.file.content === "string") {
    return value.file.content.trim() ? [{ kind: "text", text: value.file.content }] : [];
  }
  if (value.type === "resource_link" && typeof value.uri === "string") {
    return [{ kind: "text", text: value.uri }];
  }
  if (value.type === "resource" && isRecord(value.resource)) {
    const resource = value.resource;
    if (typeof resource.text === "string") return blocksFromText(resource.text, depth);
    if (typeof resource.uri === "string") return [{ kind: "text", text: resource.uri }];
  }

  // MCP envelope. `structuredContent` is the same result as data, so it wins
  // over the text copy in `content`; images only live in `content`.
  if ("content" in value && Object.keys(value).every((key) => ENVELOPE_KEYS.has(key))) {
    const content = blocksFrom(value.content, depth + 1);
    if (!hasEntries(value.structuredContent)) return content;
    return [
      { kind: "data", value: value.structuredContent },
      ...content.filter((block) => block.kind === "image"),
    ];
  }
  return Object.keys(value).length > 0 ? [{ kind: "data", value }] : [];
}

/** Splits a tool result into displayable blocks. */
export function toolOutputBlocks(value: unknown): ToolOutputBlock[] {
  return blocksFrom(value, 0);
}

/** The blocks a fetched item's tool result shows, or null for items without one. */
export function turnItemOutputBlocks(item: OrchestrationV2TurnItem): ToolOutputBlock[] | null {
  return item.type === "dynamic_tool" && item.outputOmitted !== true
    ? toolOutputBlocks(item.output)
    : null;
}

export type ToolStatusTone = "success" | "error" | "info" | "warning" | "neutral";

const SUCCESS_STATUSES = new Set([
  "completed",
  "complete",
  "succeeded",
  "success",
  "done",
  "ok",
  "merged",
  "ready",
  "passed",
  "approved",
  "open",
  "active",
  "connected",
  "settled",
]);
const ERROR_STATUSES = new Set([
  "failed",
  "failure",
  "error",
  "errored",
  "cancelled",
  "canceled",
  "rejected",
  "timed_out",
  "timeout",
  "closed",
  "interrupted",
  "disconnected",
  "conflicting",
]);
const INFO_STATUSES = new Set([
  "running",
  "in_progress",
  "starting",
  "working",
  "streaming",
  "busy",
  "active_turn",
]);
const WARNING_STATUSES = new Set([
  "pending",
  "queued",
  "waiting",
  "idle",
  "paused",
  "blocked",
  "draft",
  "stale",
  "needs_input",
]);

export function toolStatusTone(status: string): ToolStatusTone {
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
  if (SUCCESS_STATUSES.has(normalized)) return "success";
  if (ERROR_STATUSES.has(normalized)) return "error";
  if (INFO_STATUSES.has(normalized)) return "info";
  if (WARNING_STATUSES.has(normalized)) return "warning";
  return "neutral";
}

/** `childNodeId` and `child_node_id` both become "Child node id". */
export function toolFieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim()
    .toLowerCase();
  if (!words) return key;
  return words.charAt(0).toUpperCase() + words.slice(1);
}
