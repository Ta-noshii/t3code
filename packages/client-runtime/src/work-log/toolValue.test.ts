import { describe, expect, it } from "vite-plus/test";

import {
  toolFieldLabel,
  toolFields,
  toolOutputBlocks,
  toolScalarView,
  toolStatusTone,
} from "./toolValue.ts";

describe("toolOutputBlocks", () => {
  it("prefers structuredContent over its text copy and keeps images", () => {
    const status = { taskId: "task-1", status: "completed" };
    expect(
      toolOutputBlocks({
        content: [
          { type: "text", text: JSON.stringify(status) },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        structuredContent: status,
      }),
    ).toEqual([
      { kind: "data", value: status },
      {
        kind: "image",
        image: { type: "image", mimeType: "image/png", data: "AAAA", byteLength: 3 },
      },
    ]);
  });

  it("parses JSON text blocks, one document per line", () => {
    expect(toolOutputBlocks({ content: [{ type: "text", text: '{"a":1}\n{"b":2}' }] })).toEqual([
      { kind: "data", value: { a: 1 } },
      { kind: "data", value: { b: 2 } },
    ]);
  });

  it("keeps plain and truncated text as text", () => {
    const truncated = '{"type":"image","file":{"base64":"iVBOR\n… output truncated for transport';
    expect(toolOutputBlocks(truncated)).toEqual([{ kind: "text", text: truncated }]);
    expect(toolOutputBlocks("hello")).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("turns a Claude Read image result into an image block", () => {
    const blocks = toolOutputBlocks({
      type: "image",
      file: { base64: "AAAA", type: "image/png", dimensions: { originalWidth: 10 } },
    });
    expect(blocks).toMatchObject([{ kind: "image", image: { mimeType: "image/png", width: 10 } }]);
  });

  it("shows a Claude Read text result as its file content", () => {
    expect(
      toolOutputBlocks({ type: "text", file: { filePath: "/a.ts", content: "const a = 1;" } }),
    ).toEqual([{ kind: "text", text: "const a = 1;" }]);
  });

  it("drops empty results", () => {
    expect(toolOutputBlocks({})).toEqual([]);
    expect(toolOutputBlocks({ content: [] })).toEqual([]);
    expect(toolOutputBlocks(null)).toEqual([]);
  });
});

describe("toolScalarView", () => {
  it.each([
    ["status", "completed", { kind: "status", text: "completed", tone: "success" }],
    ["workState", "running", { kind: "status", text: "running", tone: "info" }],
    ["createdAt", "2026-10-05T09:00:00.000Z", { kind: "time", iso: "2026-10-05T09:00:00.000Z" }],
    [
      "url",
      "https://github.com/a/b/pull/1",
      { kind: "url", href: "https://github.com/a/b/pull/1" },
    ],
    ["taskId", "task_8f2c", { kind: "id", text: "task_8f2c" }],
    ["cwd", "/home/me/project", { kind: "path", text: "/home/me/project" }],
    ["model", "gpt-6.1-sol", { kind: "text", text: "gpt-6.1-sol" }],
    ["count", 1200, { kind: "number", text: "1,200" }],
  ] as const)("classifies %s", (key, value, expected) => {
    expect(toolScalarView(key, value)).toEqual(expected);
  });

  it("reads epoch milliseconds under a time key", () => {
    expect(toolScalarView("updatedAt", 1_790_000_000_000)).toMatchObject({ kind: "time" });
  });
});

describe("field helpers", () => {
  it("labels and filters fields", () => {
    expect(toolFieldLabel("childNodeId")).toBe("Child node id");
    expect(toolFieldLabel("provider_instance_id")).toBe("Provider instance id");
    expect(toolFields({ a: null, b: "", c: [], d: { e: null }, f: 0, g: "x" })).toEqual([
      ["f", 0],
      ["g", "x"],
    ]);
  });

  it("tones unknown statuses neutrally", () => {
    expect(toolStatusTone("Cancelled")).toBe("error");
    expect(toolStatusTone("whatever")).toBe("neutral");
  });
});
