// @effect-diagnostics nodeBuiltinImport:off - exercises the transfer against a real Claude home on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { exportClaudeSession, importClaudeSession } from "./claudeSessionTransfer.ts";

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

const projectKey = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-");

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

  it("recreates a session, subagent transcripts included, under another project directory", async () => {
    const sourceDir = "/srv/source/project";
    const targetDir = "/home/someone/code/project";
    const projectDir = NodePath.join(home, "projects", projectKey(sourceDir));
    await NodeFSP.mkdir(NodePath.join(projectDir, SESSION_ID, "subagents"), { recursive: true });
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
    await NodeFSP.writeFile(
      NodePath.join(projectDir, SESSION_ID, "subagents", "agent-a1b2c3.jsonl"),
      `${JSON.stringify({
        ...entry("33333333-3333-4333-8333-333333333333", null, "user", "Find it", sourceDir),
        isSidechain: true,
        agentId: "a1b2c3",
      })}\n`,
    );

    const exported = await exportClaudeSession(SESSION_ID, { dir: sourceDir });
    expect(exported.transcripts.map((transcript) => transcript.subpath).toSorted()).toEqual([
      null,
      "subagents/agent-a1b2c3",
    ]);

    // The export travels as JSON between machines.
    const { sessionId, headMessageId } = await importClaudeSession(
      JSON.parse(JSON.stringify(exported)),
      { dir: targetDir },
    );

    expect(sessionId).not.toBe(SESSION_ID);
    const targetProject = NodePath.join(home, "projects", projectKey(targetDir));
    expect(await NodeFSP.readdir(targetProject)).toContain(`${sessionId}.jsonl`);
    expect(await NodeFSP.readdir(NodePath.join(targetProject, sessionId, "subagents"))).toEqual([
      "agent-a1b2c3.jsonl",
    ]);
    const messages = await getSessionMessages(sessionId, { dir: targetDir });
    expect(messages.map((message) => message.type)).toEqual(["user", "assistant"]);
    expect(headMessageId).toBe(messages.at(-1)?.uuid);
  });

  it("resumes the copy at its last entry, past the last message", async () => {
    const dir = "/srv/source/project";
    const projectDir = NodePath.join(home, "projects", projectKey(dir));
    await NodeFSP.mkdir(projectDir, { recursive: true });
    const first = "11111111-1111-4111-8111-111111111111";
    const reply = "22222222-2222-4222-8222-222222222222";
    const lines = [
      entry(first, null, "user", "Fix the parser", dir),
      entry(reply, first, "assistant", "Done.", dir),
      {
        type: "attachment",
        uuid: "33333333-3333-4333-8333-333333333333",
        parentUuid: reply,
        sessionId: SESSION_ID,
        timestamp: "2026-09-23T10:00:01.000Z",
        cwd: dir,
        isSidechain: false,
        attachment: { type: "structured_output", data: { ok: true } },
      },
    ];
    await NodeFSP.writeFile(
      NodePath.join(projectDir, `${SESSION_ID}.jsonl`),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );

    const exported = await exportClaudeSession(SESSION_ID, { dir });
    const targetDir = "/home/someone/project";
    const { sessionId, headMessageId } = await importClaudeSession(exported, { dir: targetDir });

    const written = (
      await NodeFSP.readFile(
        NodePath.join(home, "projects", projectKey(targetDir), `${sessionId}.jsonl`),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { uuid?: string; type: string })
      // Chain entries link to a parent; the fork's title record does not.
      .filter((line) => "parentUuid" in line);
    const messages = await getSessionMessages(sessionId, { dir: targetDir });
    expect(written.at(-1)).toMatchObject({ type: "attachment", uuid: headMessageId });
    expect(headMessageId).not.toBe(messages.at(-1)?.uuid);
  });

  it("leaves out turns after a rollback boundary", async () => {
    const dir = "/srv/source/project";
    const projectDir = NodePath.join(home, "projects", projectKey(dir));
    await NodeFSP.mkdir(projectDir, { recursive: true });
    const first = "11111111-1111-4111-8111-111111111111";
    const lines = [
      entry(first, null, "user", "Fix the parser", dir),
      entry("22222222-2222-4222-8222-222222222222", first, "assistant", "Discarded.", dir),
    ];
    await NodeFSP.writeFile(
      NodePath.join(projectDir, `${SESSION_ID}.jsonl`),
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    );

    const exported = await exportClaudeSession(SESSION_ID, { dir, upToMessageId: first });
    const { sessionId } = await importClaudeSession(exported, { dir: "/home/someone/project" });

    const messages = await getSessionMessages(sessionId, { dir: "/home/someone/project" });
    expect(messages.map((message) => message.type)).toEqual(["user"]);
  });

  it("fails when the session is not in the Claude home", async () => {
    await expect(exportClaudeSession(SESSION_ID, { dir: "/nowhere" })).rejects.toThrow();
  });
});
