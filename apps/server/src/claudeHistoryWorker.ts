// @effect-diagnostics nodeBuiltinImport:off - a standalone worker around the SDK's filesystem-backed session helpers.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  importSessionToStore,
  type SessionKey,
  type SessionMessage,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// A separate process gives SDK history helpers the provider's environment without
// mutating the server's environment. `claude-history-worker.ts` is the
// standalone entry bundled beside the server for npm installs; the
// single-executable hosts the same function as its `__claude-history`
// subcommand, which has no Node to run a sibling script. Nothing here may run
// on import: inside the executable `import.meta.main` is true for the whole
// bundle.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
      inputFile: Schema.optionalKey(Schema.String),
      toolUseId: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** A Claude session's transcripts, keyed by subpath (null for the main transcript). */
export interface ClaudeSessionExport {
  readonly sessionId: string;
  readonly transcripts: ReadonlyArray<{
    readonly subpath: string | null;
    readonly entries: ReadonlyArray<SessionStoreEntry>;
  }>;
}

/** Reads a local session, subagent transcripts included, through the SDK's store export. */
export async function exportClaudeSession(
  sessionId: string,
  options: { readonly dir?: string },
): Promise<ClaudeSessionExport> {
  const transcripts = new Map<string, SessionStoreEntry[]>();
  const capture: SessionStore = {
    append: async (key, entries) => {
      const subpath = key.subpath ?? "";
      transcripts.set(subpath, [...(transcripts.get(subpath) ?? []), ...entries]);
    },
    load: async () => null,
  };
  await importSessionToStore(sessionId, capture, {
    ...(options.dir ? { dir: options.dir } : {}),
    includeSubagents: true,
  });
  if (!transcripts.has("")) throw new Error("The Claude session transcript was not found.");
  return {
    sessionId,
    transcripts: Array.from(transcripts, ([subpath, entries]) => ({
      subpath: subpath === "" ? null : subpath,
      entries,
    })),
  };
}

/**
 * Writes an exported session into this machine's Claude home as a fork, so it gets fresh
 * ids and lands under `dir`'s project. The SDK forks between stores only, so the fork is
 * captured in memory and written where the CLI keeps project sessions: the project key it
 * derives for `dir` is the directory name the CLI uses.
 */
export async function importClaudeSession(
  exported: ClaudeSessionExport,
  options: { readonly dir: string },
): Promise<{ readonly sessionId: string }> {
  const source = new Map(exported.transcripts.map((t) => [t.subpath ?? "", t.entries]));
  const written = new Map<string, { key: SessionKey; entries: SessionStoreEntry[] }>();
  const store: SessionStore = {
    append: async (key, entries) => {
      const id = `${key.sessionId}/${key.subpath ?? ""}`;
      const current = written.get(id) ?? { key, entries: [] };
      current.entries.push(...entries);
      written.set(id, current);
    },
    load: async (key) =>
      key.sessionId === exported.sessionId ? [...(source.get(key.subpath ?? "") ?? [])] : null,
    listSubkeys: async () => [...source.keys()].filter((subpath) => subpath !== ""),
  };
  const { sessionId } = await forkSession(exported.sessionId, {
    dir: options.dir,
    sessionStore: store,
  });
  const projectsDir = NodePath.join(
    process.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude"),
    "projects",
  );
  for (const { key, entries } of written.values()) {
    if (key.sessionId !== sessionId || entries.length === 0) continue;
    const file = NodePath.normalize(
      key.subpath
        ? NodePath.join(projectsDir, key.projectKey, sessionId, `${key.subpath}.jsonl`)
        : NodePath.join(projectsDir, key.projectKey, `${sessionId}.jsonl`),
    );
    if (!file.startsWith(projectsDir + NodePath.sep))
      throw new Error("Refusing to write outside the Claude home.");
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
      flag: "wx",
    });
  }
  const messages = await getSessionMessages(sessionId, { dir: options.dir });
  if (messages.length === 0) throw new Error("The imported Claude session could not be read back.");
  return { sessionId };
}

export interface ClaudeAgentTranscriptEntry {
  readonly kind: "prompt" | "text" | "tool_call" | "tool_result";
  readonly text: string;
  readonly toolName?: string;
  readonly isError?: boolean;
}

const TRANSCRIPT_ENTRY_LIMIT = 400;
const TEXT_CHAR_LIMIT = 6_000;
const TOOL_RESULT_CHAR_LIMIT = 2_000;
const TOOL_INPUT_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "prompt"];

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function blocksOf(message: unknown): ReadonlyArray<Record<string, unknown>> | string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content.filter((block): block is Record<string, unknown> => typeof block === "object")
    : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "[image]",
    )
    .join("\n");
}

function summarizeToolInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of TOOL_INPUT_KEYS) {
    if (typeof record[key] === "string") return clip(record[key], 400);
  }
  return clip(JSON.stringify(record), 400);
}

/** Turns a subagent's SDK messages into the Agents panel's transcript entries. */
export function toAgentTranscript(messages: ReadonlyArray<SessionMessage>): {
  readonly entries: ReadonlyArray<ClaudeAgentTranscriptEntry>;
  readonly truncated: boolean;
} {
  const entries: ClaudeAgentTranscriptEntry[] = [];
  for (const message of messages) {
    const blocks = blocksOf(message.message);
    if (message.type === "user") {
      if (typeof blocks === "string") {
        entries.push({
          kind: entries.length === 0 ? "prompt" : "text",
          text: clip(blocks, TEXT_CHAR_LIMIT),
        });
        continue;
      }
      for (const block of blocks) {
        if (block.type === "tool_result") {
          entries.push({
            kind: "tool_result",
            text: clip(toolResultText(block.content), TOOL_RESULT_CHAR_LIMIT),
            ...(block.is_error === true ? { isError: true } : {}),
          });
        } else if (block.type === "text" && typeof block.text === "string") {
          entries.push({
            kind: entries.length === 0 ? "prompt" : "text",
            text: clip(block.text, TEXT_CHAR_LIMIT),
          });
        }
      }
    } else if (message.type === "assistant" && typeof blocks !== "string") {
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          entries.push({ kind: "text", text: clip(block.text, TEXT_CHAR_LIMIT) });
        } else if (block.type === "tool_use") {
          entries.push({
            kind: "tool_call",
            toolName: typeof block.name === "string" ? block.name : "tool",
            text: summarizeToolInput(block.input),
          });
        }
      }
    }
  }
  // The prompt stays when the middle is dropped: it says what the agent was asked to do.
  if (entries.length <= TRANSCRIPT_ENTRY_LIMIT) return { entries, truncated: false };
  const prompt = entries[0]?.kind === "prompt" ? [entries[0]] : [];
  return {
    entries: [...prompt, ...entries.slice(-(TRANSCRIPT_ENTRY_LIMIT - prompt.length))],
    truncated: true,
  };
}

/**
 * Reads the transcript of the subagent a session spawned with the tool call `toolUseId`.
 * The CLI records that id in each subagent's `agent-<id>.meta.json`, beside its transcript.
 */
export async function readClaudeSubagentTranscript(
  sessionId: string,
  toolUseId: string,
  options: { readonly dir?: string },
): Promise<ReturnType<typeof toAgentTranscript> | null> {
  const projectsDir = NodePath.join(
    process.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude"),
    "projects",
  );
  const projects = await NodeFSP.readdir(projectsDir).catch(() => []);
  for (const project of projects) {
    const subagentsDir = NodePath.join(projectsDir, project, sessionId, "subagents");
    const files = await NodeFSP.readdir(subagentsDir).catch(() => []);
    for (const file of files) {
      if (!file.startsWith("agent-") || !file.endsWith(".meta.json")) continue;
      const meta = await NodeFSP.readFile(NodePath.join(subagentsDir, file), "utf8")
        .then((text) => JSON.parse(text) as { toolUseId?: unknown })
        .catch(() => null);
      if (meta?.toolUseId !== toolUseId) continue;
      const agentId = file.slice("agent-".length, -".meta.json".length);
      const messages = await getSubagentMessages(
        sessionId,
        agentId,
        options.dir ? { dir: options.dir } : {},
      );
      return toAgentTranscript(messages);
    }
  }
  return null;
}

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result =
    method === "getSessionMessages"
      ? await getSessionMessages(sessionId, options)
      : method === "forkSession"
        ? await forkSession(sessionId, options)
        : method === "exportSession"
          ? await exportClaudeSession(sessionId, options)
          : method === "readSubagentTranscript"
            ? await readClaudeSubagentTranscript(sessionId, options.toolUseId ?? "", options)
            : method === "importSession"
              ? await importClaudeSession(
                  JSON.parse(
                    await NodeFSP.readFile(options.inputFile ?? "", "utf8"),
                  ) as ClaudeSessionExport,
                  { dir: options.dir ?? process.cwd() },
                )
              : (() => {
                  throw new Error("Unknown Claude history operation.");
                })();
  process.stdout.write(JSON.stringify(result));
}
