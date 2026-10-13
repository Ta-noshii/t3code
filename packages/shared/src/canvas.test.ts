import { describe, expect, it } from "vite-plus/test";

import {
  canvasBaseName,
  canvasCropRect,
  canvasElementBounds,
  canvasExportScale,
  canvasFormatForPath,
  canvasSlug,
  canvasTitle,
  mergeCanvasElements,
  parseCanvasScene,
  serializeCanvasScene,
} from "./canvas.ts";

const rect = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "rectangle",
  x,
  y,
  width: 100,
  height: 50,
  strokeWidth: 0,
  version: 1,
  versionNonce: 1,
  ...extra,
});

describe("canvas paths", () => {
  it("recognizes canvas files by suffix", () => {
    expect(canvasFormatForPath("/a/flow.excalidraw")).toBe("excalidraw");
    expect(canvasFormatForPath("/a/flow.Excalidraw.json")).toBe("excalidraw");
    expect(canvasFormatForPath("flow.excalidraw.svg")).toBe("excalidraw-svg");
    expect(canvasFormatForPath("flow.excalidraw.png")).toBe("excalidraw-png");
    expect(canvasFormatForPath("flow.json")).toBeNull();
    expect(canvasFormatForPath("flow.png")).toBeNull();
    expect(canvasBaseName("/a/b/auth-flow.excalidraw.json")).toBe("auth-flow");
  });

  it("makes slugs and titles", () => {
    expect(canvasSlug("Auth flow: v2")).toBe("auth-flow-v2");
    expect(canvasSlug("Café ☕")).toBe("cafe");
    expect(canvasSlug("!!!")).toBe("canvas");
    expect(canvasTitle({ appState: {} }, "/x/data_model-v2.excalidraw")).toBe("Data model v2");
    expect(canvasTitle({ appState: { name: "API gateway" } }, "/x/a.excalidraw")).toBe(
      "API gateway",
    );
  });
});

describe("serializeCanvasScene", () => {
  it("writes the same bytes for the same scene in any key order", () => {
    const one = serializeCanvasScene({
      elements: [{ id: "a", type: "rectangle", x: 1, y: 2 }],
      appState: { viewBackgroundColor: "#fff", name: "A", zoom: { value: 2 } },
      files: {},
    });
    const two = serializeCanvasScene({
      elements: [{ y: 2, x: 1, type: "rectangle", id: "a" }],
      appState: { name: "A", viewBackgroundColor: "#fff", scrollX: 40 },
      files: {},
    });
    expect(one).toBe(two);
    expect(one).toContain('\n  "type": "excalidraw",\n  "version": 2,');
    expect(one).not.toContain("zoom");
  });

  it("leaves out deleted elements and unused images, and reads back", () => {
    const image = {
      id: "f1",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,AA",
      created: 1,
    };
    const text = serializeCanvasScene({
      elements: [
        { id: "img", type: "image", fileId: "f1" },
        { id: "gone", type: "rectangle", isDeleted: true },
      ],
      appState: {},
      files: { f1: image, f2: { ...image, id: "f2" } },
    });
    const scene = parseCanvasScene(text);
    expect(scene?.elements.map((element) => element.id)).toEqual(["img"]);
    expect(Object.keys(scene?.files ?? {})).toEqual(["f1"]);
  });

  it("rejects files that are not Excalidraw scenes", () => {
    expect(parseCanvasScene("{}")).toBeNull();
    expect(parseCanvasScene("not json")).toBeNull();
    expect(parseCanvasScene('{"type":"excalidrawlib"}')).toBeNull();
  });
});

describe("mergeCanvasElements", () => {
  it("keeps the newer version of an element both sides changed", () => {
    const merged = mergeCanvasElements({
      base: [rect("a", 0, 0)],
      local: [rect("a", 10, 0, { version: 2 })],
      remote: [rect("a", 0, 99, { version: 3 })],
    });
    expect(merged).toEqual([rect("a", 0, 99, { version: 3 })]);
  });

  it("keeps additions from both sides", () => {
    const merged = mergeCanvasElements({
      base: [rect("a", 0, 0)],
      local: [rect("a", 0, 0), rect("mine", 1, 1)],
      remote: [rect("a", 0, 0), rect("agent", 2, 2)],
    });
    expect(merged.map((element) => element.id)).toEqual(["a", "mine", "agent"]);
  });

  it("drops what the other side deleted, unless this side changed it since", () => {
    const merged = mergeCanvasElements({
      base: [rect("a", 0, 0), rect("b", 0, 0)],
      local: [rect("a", 0, 0), rect("b", 5, 5, { version: 2 })],
      remote: [],
    });
    expect(merged.map((element) => element.id)).toEqual(["b"]);
  });

  it("keeps everything without a base", () => {
    const merged = mergeCanvasElements({
      base: null,
      local: [rect("a", 0, 0)],
      remote: [rect("b", 0, 0)],
    });
    expect(merged.map((element) => element.id)).toEqual(["a", "b"]);
  });

  it("orders by fractional index when every element has one", () => {
    const merged = mergeCanvasElements({
      base: null,
      local: [rect("z", 0, 0, { index: "a2" })],
      remote: [rect("y", 0, 0, { index: "a1" })],
    });
    expect(merged.map((element) => element.id)).toEqual(["y", "z"]);
  });
});

describe("screenshot crops", () => {
  const elements = [
    rect("a", 0, 0),
    rect("b", 400, 300),
    { id: "label", type: "text", x: 410, y: 310, width: 20, height: 10, containerId: "b" },
    {
      id: "arrow",
      type: "arrow",
      x: 100,
      y: 25,
      width: 300,
      height: 275,
      points: [
        [0, 0],
        [300, 275],
      ],
      strokeWidth: 2,
    },
    {
      id: "frame-1",
      type: "frame",
      name: "Login",
      x: -50,
      y: -50,
      width: 200,
      height: 150,
      strokeWidth: 1,
    },
    rect("old", 5000, 5000, { isDeleted: true }),
  ];

  it("fits the full scene with padding and skips deleted elements", () => {
    // The frame's 1 px stroke adds half a unit on each side.
    expect(canvasCropRect(elements, { type: "full" }, 10)).toEqual({
      x: -60.5,
      y: -60.5,
      width: 570.5,
      height: 420.5,
    });
  });

  it("crops to elements and their bound text", () => {
    expect(canvasCropRect(elements, { type: "elements", ids: ["b"] }, 0)).toEqual({
      x: 400,
      y: 300,
      width: 100,
      height: 50,
    });
    expect(() => canvasCropRect(elements, { type: "elements", ids: ["nope"] })).toThrow(/nope/u);
  });

  it("crops to a frame by name or id without padding", () => {
    const frame = { x: -50, y: -50, width: 200, height: 150 };
    expect(canvasCropRect(elements, { type: "frame", frame: "login" }, 40)).toEqual(frame);
    expect(canvasCropRect(elements, { type: "frame", frame: "frame-1" }, 40)).toEqual(frame);
    expect(() => canvasCropRect(elements, { type: "frame", frame: "Signup" })).toThrow(/Login/u);
  });

  it("pads a scene rect", () => {
    expect(
      canvasCropRect([], { type: "rect", rect: { x: 0, y: 0, width: 10, height: 20 } }, 5),
    ).toEqual({ x: -5, y: -5, width: 20, height: 30 });
  });

  it("refuses an empty canvas", () => {
    expect(() => canvasCropRect([], { type: "full" })).toThrow(/empty/u);
  });

  it("bounds rotated elements by their rotated box", () => {
    const box = canvasElementBounds(
      rect("r", 0, 0, { width: 100, height: 100, angle: Math.PI / 4 }),
    );
    expect(box?.width).toBeCloseTo(Math.SQRT2 * 100);
    expect(box?.x).toBeCloseTo(50 - (Math.SQRT2 * 100) / 2);
  });

  it("fits the longest side to the size and caps scale", () => {
    expect(canvasExportScale({ x: 0, y: 0, width: 3200, height: 800 }, {})).toBe(0.5);
    expect(canvasExportScale({ x: 0, y: 0, width: 100, height: 50 }, {})).toBe(3);
    expect(canvasExportScale({ x: 0, y: 0, width: 1000, height: 50 }, { scale: 8 })).toBeCloseTo(
      4.096,
    );
  });
});
