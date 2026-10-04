// @effect-diagnostics nodeBuiltinImport:off - wraps the SDK's Promise-based, filesystem-backed session store helpers.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  forkSession,
  getSessionMessages,
  importSessionToStore,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

export const CLAUDE_SESSION_EXPORT_FORMAT = "claude-session-v1";

/**
 * The Claude home an environment's CLAUDE_CONFIG_DIR selects, with the CLI's
 * default. Null for a relative path: the CLI resolves it against each
 * thread's working directory, so it names no single home.
 */
export function claudeHomeDir(env: NodeJS.ProcessEnv): string | null {
  const configured = env.CLAUDE_CONFIG_DIR;
  if (!configured) return NodePath.join(NodeOS.homedir(), ".claude");
  return NodePath.isAbsolute(configured) ? NodePath.resolve(configured) : null;
}

/** A Claude session's transcripts, keyed by subpath (null for the main transcript). */
export const ClaudeSessionExport = Schema.Struct({
  sessionId: Schema.String,
  /**
   * The message the conversation continues from when the source thread was
   * rolled back: later entries are discarded turns the copy leaves out.
   */
  upToMessageId: Schema.optional(Schema.String),
  transcripts: Schema.Array(
    Schema.Struct({
      subpath: Schema.NullOr(Schema.String),
      entries: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
export type ClaudeSessionExport = typeof ClaudeSessionExport.Type;

/**
 * Reads a local session, subagent transcripts included, through the SDK's
 * session-store export. Like the SDK's other history helpers it reads the
 * Claude home named by `process.env.CLAUDE_CONFIG_DIR`.
 */
export async function exportClaudeSession(
  sessionId: string,
  options: { readonly dir?: string | undefined; readonly upToMessageId?: string | undefined },
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
    ...(options.upToMessageId === undefined ? {} : { upToMessageId: options.upToMessageId }),
    transcripts: Array.from(transcripts, ([subpath, entries]) => ({
      subpath: subpath === "" ? null : subpath,
      entries,
    })),
  };
}

/**
 * Writes an exported session into this machine's Claude home as a fork, so it
 * gets fresh ids and lands under `dir`'s project. The SDK forks between stores
 * only, so the fork is captured in memory and written where the CLI keeps
 * project sessions: the project key the SDK derives for `dir` is the directory
 * name the CLI uses.
 */
export async function importClaudeSession(
  exported: ClaudeSessionExport,
  options: { readonly dir: string },
): Promise<{ readonly sessionId: string; readonly headMessageId: string }> {
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
      key.sessionId === exported.sessionId
        ? ([...(source.get(key.subpath ?? "") ?? [])] as SessionStoreEntry[])
        : null,
    listSubkeys: async () => [...source.keys()].filter((subpath) => subpath !== ""),
  };
  const { sessionId } = await forkSession(exported.sessionId, {
    dir: options.dir,
    sessionStore: store,
    ...(exported.upToMessageId === undefined ? {} : { upToMessageId: exported.upToMessageId }),
  });
  const home = claudeHomeDir(process.env);
  if (home === null) throw new Error("The server's CLAUDE_CONFIG_DIR is a relative path.");
  const projectsDir = NodePath.join(home, "projects");
  const writeTranscript = async (
    projectKey: string,
    subpath: string | undefined,
    entries: ReadonlyArray<unknown>,
  ) => {
    const file = NodePath.normalize(
      subpath
        ? NodePath.join(projectsDir, projectKey, sessionId, `${subpath}.jsonl`)
        : NodePath.join(projectsDir, projectKey, `${sessionId}.jsonl`),
    );
    if (!file.startsWith(projectsDir + NodePath.sep)) {
      throw new Error("Refusing to write outside the Claude home.");
    }
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
      flag: "wx",
    });
  };
  const forked = [...written.values()].filter(
    ({ key, entries }) => key.sessionId === sessionId && entries.length > 0,
  );
  const main = forked.find(({ key }) => !key.subpath);
  if (main === undefined) throw new Error("The Claude session fork produced no transcript.");
  for (const { key, entries } of forked) {
    await writeTranscript(key.projectKey, key.subpath, entries);
  }
  // The fork copies the main transcript only. Subagent transcripts move as
  // they are, renamed to the new session, so the copy can still show them.
  const forkedSubpaths = new Set(forked.map(({ key }) => key.subpath ?? ""));
  for (const [subpath, entries] of source) {
    if (subpath === "" || forkedSubpaths.has(subpath) || entries.length === 0) continue;
    await writeTranscript(
      main.key.projectKey,
      subpath,
      entries.map((entry) => ({ ...entry, sessionId })),
    );
  }
  const messages = await getSessionMessages(sessionId, { dir: options.dir });
  if (messages.length === 0) {
    throw new Error("The imported Claude session could not be read back.");
  }
  // The CLI refuses a fixed session id that already exists on disk, so the
  // first turn has to resume the copy; resuming at its last transcript entry
  // does that. The last entry, not the last message: entries such as a
  // structured-output attachment come after the last message.
  const head = main.entries.findLast(
    (entry): entry is SessionStoreEntry & { readonly uuid: string } =>
      typeof entry.uuid === "string" && "parentUuid" in entry,
  );
  if (head === undefined) throw new Error("The imported Claude session has no entries.");
  return { sessionId, headMessageId: head.uuid };
}
