import type { CanvasHostPageMessage, CanvasSaveResult } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { NativeBridge, readNativeMessage } from "./nativeBridge";

const summary = {
  path: "/repo/.canvases/arch.excalidraw",
  projectId: null,
  slug: "arch",
  title: "Arch",
  displayPath: ".canvases/arch.excalidraw",
  format: "excalidraw" as const,
  readOnly: false,
  modifiedAt: "2026-10-13T00:00:00.000Z",
  elementCount: 0,
  imageCount: 0,
};

const saveResult: CanvasSaveResult = { canvas: summary, revision: "r2", written: true };

function setup(timeoutMs?: number) {
  const sent: CanvasHostPageMessage[] = [];
  const bridge = new NativeBridge((message) => sent.push(message), timeoutMs);
  return { bridge, sent };
}

describe("NativeBridge", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves each request with the answer carrying its id", async () => {
    const { bridge, sent } = setup();
    const first = bridge.save({ baseRevision: "r1", elements: [] });
    const second = bridge.read(["img"]);
    expect(sent).toEqual([
      { type: "save", requestId: 0, input: { baseRevision: "r1", elements: [] } },
      { type: "read", requestId: 1, knownFileIds: ["img"] },
    ]);

    expect(bridge.answer({ type: "document", requestId: 1, document: null })).toBe(true);
    expect(bridge.answer({ type: "saved", requestId: 0, result: saveResult })).toBe(true);
    await expect(second).resolves.toBeNull();
    await expect(first).resolves.toEqual(saveResult);
    // Answered requests are forgotten.
    expect(bridge.answer({ type: "saved", requestId: 0, result: saveResult })).toBe(false);
  });

  it("does not take other messages as answers", () => {
    const { bridge } = setup();
    void bridge.save({ baseRevision: null, elements: [] });
    expect(bridge.answer({ type: "changed", revision: "r3" })).toBe(false);
    expect(bridge.answer({ type: "flush" })).toBe(false);
  });

  it("gives up on a request native never answers", async () => {
    vi.useFakeTimers();
    const { bridge } = setup(1_000);
    const pending = bridge.save({ baseRevision: "r1", elements: [] });
    vi.advanceTimersByTime(1_000);
    await expect(pending).resolves.toBeNull();
  });
});

describe("readNativeMessage", () => {
  it("decodes protocol messages and ignores anything else", () => {
    expect(readNativeMessage(JSON.stringify({ type: "changed", revision: "r2" }))).toEqual({
      type: "changed",
      revision: "r2",
    });
    expect(readNativeMessage(JSON.stringify({ type: "save", requestId: 1 }))).toBeNull();
    expect(readNativeMessage("not json")).toBeNull();
    expect(readNativeMessage({ type: "flush" })).toBeNull();
  });
});
