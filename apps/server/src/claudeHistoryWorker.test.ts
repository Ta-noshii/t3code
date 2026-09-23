// @effect-diagnostics nodeBuiltinImport:off - exercises the worker against a real Claude home on disk.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { exportClaudeSession, importClaudeSession } from "./claudeHistoryWorker.ts";

const SESSION_ID = "0f6a3c2e-5b1d-4c8e-9a7f-2d3e4b5c6a71";

const entry = (
  uuid: string,
  parentUuid: string | null,
  role: "user" | "assistant",
  content: string,
  cwd: string,
) => ({
  type: role,
  uuid,
  parentUuid,
  sessionId: SESSION_ID,
  timestamp: "2026-09-23T10:00:00.000Z",
  cwd,
  isSidechain: false,
  userType: "external",
  version: "2.1.0",
  message:
    role === "user"
      ? { role, content }
      : {
          id: `msg_${uuid}`,
          type: "message",
          role,
          model: "claude-opus-5-5",
          content: [{ type: "text", text: content }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
});

describe("Claude session transfer", () => {
  let home: string;
  const previous = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "t3-claude-home-"));
    process.env.CLAUDE_CONFIG_DIR = home;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(home, { recursive: true, force: true });
  });

  it("recreates a session under another project directory", async () => {
    const sourceDir = "/srv/source/project";
    const targetDir = "/home/someone/code/project";
    const projectDir = join(home, "projects", sourceDir.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(projectDir, { recursive: true });
    const lines = [
      entry("11111111-1111-4111-8111-111111111111", null, "user", "Fix the parser", sourceDir),
      entry(
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
        "assistant",
        "It drops trailing commas.",
        sourceDir,
      ),
    ];
    await writeFile(
      join(projectDir, `${SESSION_ID}.jsonl`),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );

    const exported = await exportClaudeSession(SESSION_ID, { dir: sourceDir });
    expect(exported.transcripts).toHaveLength(1);
    expect(exported.transcripts[0]?.entries.length).toBeGreaterThanOrEqual(2);

    // The export travels as JSON between machines.
    const { sessionId } = await importClaudeSession(JSON.parse(JSON.stringify(exported)), {
      dir: targetDir,
    });

    expect(sessionId).not.toBe(SESSION_ID);
    const targetProject = join(home, "projects", targetDir.replace(/[^a-zA-Z0-9]/g, "-"));
    expect(await readdir(targetProject)).toContain(`${sessionId}.jsonl`);
    const messages = await getSessionMessages(sessionId, { dir: targetDir });
    expect(messages.map((message) => message.type)).toEqual(["user", "assistant"]);
  });
});
