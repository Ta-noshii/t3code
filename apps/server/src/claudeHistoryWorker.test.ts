// @effect-diagnostics nodeBuiltinImport:off - exercises the worker against a real Claude home on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  exportClaudeSession,
  importClaudeSession,
  readClaudeSubagentTranscript,
} from "./claudeHistoryWorker.ts";

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
    home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-home-"));
    process.env.CLAUDE_CONFIG_DIR = home;
  });

  afterEach(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await NodeFSP.rm(home, { recursive: true, force: true });
  });

  it("recreates a session under another project directory", async () => {
    const sourceDir = "/srv/source/project";
    const targetDir = "/home/someone/code/project";
    const projectDir = NodePath.join(home, "projects", sourceDir.replace(/[^a-zA-Z0-9]/g, "-"));
    await NodeFSP.mkdir(projectDir, { recursive: true });
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
    await NodeFSP.writeFile(
      NodePath.join(projectDir, `${SESSION_ID}.jsonl`),
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
    const targetProject = NodePath.join(home, "projects", targetDir.replace(/[^a-zA-Z0-9]/g, "-"));
    expect(await NodeFSP.readdir(targetProject)).toContain(`${sessionId}.jsonl`);
    const messages = await getSessionMessages(sessionId, { dir: targetDir });
    expect(messages.map((message) => message.type)).toEqual(["user", "assistant"]);
  });

  it("reads the transcript of the subagent a tool call spawned", async () => {
    const dir = "/srv/source/project";
    const subagents = NodePath.join(
      home,
      "projects",
      dir.replace(/[^a-zA-Z0-9]/g, "-"),
      SESSION_ID,
      "subagents",
    );
    await NodeFSP.mkdir(subagents, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(subagents, "..", "..", `${SESSION_ID}.jsonl`),
      `${JSON.stringify(entry("77777777-7777-4777-8777-777777777777", null, "user", "Go", dir))}\n`,
    );
    const sidechain = (line: Record<string, unknown>) => ({
      ...line,
      isSidechain: true,
      agentId: "a1b2c3",
    });
    const call = entry(
      "33333333-3333-4333-8333-333333333333",
      null,
      "user",
      "Find the parser",
      dir,
    );
    const lines = [
      sidechain(call),
      sidechain({
        ...entry(
          "44444444-4444-4444-8444-444444444444",
          "33333333-3333-4333-8333-333333333333",
          "assistant",
          "",
          dir,
        ),
        message: {
          id: "msg_tool",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [
            { type: "text", text: "Searching." },
            { type: "tool_use", id: "toolu_inner", name: "Grep", input: { pattern: "parse(" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      sidechain({
        ...entry(
          "55555555-5555-4555-8555-555555555555",
          "44444444-4444-4444-8444-444444444444",
          "user",
          "",
          dir,
        ),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_inner", content: "src/parser.ts" }],
        },
      }),
      sidechain(
        entry(
          "66666666-6666-4666-8666-666666666666",
          "55555555-5555-4555-8555-555555555555",
          "assistant",
          "It is in src/parser.ts.",
          dir,
        ),
      ),
    ];
    await NodeFSP.writeFile(
      NodePath.join(subagents, "agent-a1b2c3.jsonl"),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );
    await NodeFSP.writeFile(
      NodePath.join(subagents, "agent-a1b2c3.meta.json"),
      JSON.stringify({ agentType: "Explore", toolUseId: "toolu_spawn" }),
    );

    expect(await readClaudeSubagentTranscript(SESSION_ID, "toolu_other", { dir })).toBeNull();
    const transcript = await readClaudeSubagentTranscript(SESSION_ID, "toolu_spawn", { dir });
    expect(transcript?.truncated).toBe(false);
    expect(transcript?.entries).toEqual([
      { kind: "prompt", text: "Find the parser" },
      { kind: "text", text: "Searching." },
      { kind: "tool_call", toolName: "Grep", text: "parse(" },
      { kind: "tool_result", text: "src/parser.ts" },
      { kind: "text", text: "It is in src/parser.ts." },
    ]);
  });
});
