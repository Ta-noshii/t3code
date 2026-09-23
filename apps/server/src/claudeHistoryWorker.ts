// @effect-diagnostics nodeBuiltinImport:off - a standalone worker around the SDK's filesystem-backed session helpers.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";

import {
  forkSession,
  getSessionMessages,
  importSessionToStore,
  type SessionKey,
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
  const projectsDir = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  for (const { key, entries } of written.values()) {
    if (key.sessionId !== sessionId || entries.length === 0) continue;
    const file = normalize(
      key.subpath
        ? join(projectsDir, key.projectKey, sessionId, `${key.subpath}.jsonl`)
        : join(projectsDir, key.projectKey, `${sessionId}.jsonl`),
    );
    if (!file.startsWith(projectsDir + sep))
      throw new Error("Refusing to write outside the Claude home.");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), {
      flag: "wx",
    });
  }
  const messages = await getSessionMessages(sessionId, { dir: options.dir });
  if (messages.length === 0) throw new Error("The imported Claude session could not be read back.");
  return { sessionId };
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
          : method === "importSession"
            ? await importClaudeSession(
                JSON.parse(await readFile(options.inputFile ?? "", "utf8")) as ClaudeSessionExport,
                { dir: options.dir ?? process.cwd() },
              )
            : (() => {
                throw new Error("Unknown Claude history operation.");
              })();
  process.stdout.write(JSON.stringify(result));
}
