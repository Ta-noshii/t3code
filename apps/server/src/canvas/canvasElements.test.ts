// @effect-diagnostics nodeBuiltinImport:off
import type { CanvasElement } from "@t3tools/contracts";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import {
  CanvasPatchError,
  applyCanvasPatches,
  deleteCanvasElements,
  placeCanvasImage,
  readImageInfo,
  shouldDownscaleImage,
  summarizeCanvasElements,
  unknownCanvasReferences,
} from "./canvasElements.ts";
import { embeddedSceneFromPng } from "./canvasEmbedded.ts";

const element = (id: string, extra: Partial<CanvasElement> = {}): CanvasElement => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  version: 1,
  isDeleted: false,
  ...extra,
});

// A box with a label, a second box, and an arrow from the first to the second.
const scene = (): CanvasElement[] => [
  element("box", {
    boundElements: [
      { id: "label", type: "text" },
      { id: "arrow", type: "arrow" },
    ],
  }),
  element("label", { type: "text", x: 30, y: 15, text: "API", containerId: "box" }),
  element("db", { x: 300, boundElements: [{ id: "arrow", type: "arrow" }] }),
  element("arrow", {
    type: "arrow",
    x: 100,
    y: 25,
    width: 200,
    height: 0,
    points: [
      [0, 0],
      [200, 0],
    ],
    startBinding: { elementId: "box" },
    endBinding: { elementId: "db" },
  }),
];

const byId = (elements: ReadonlyArray<CanvasElement>, id: string) =>
  elements.find((candidate) => candidate.id === id)!;

describe("summarizeCanvasElements", () => {
  it("folds labels into their containers and names arrow ends", () => {
    expect(summarizeCanvasElements(scene())).toEqual([
      { id: "box", type: "rectangle", x: 0, y: 0, w: 100, h: 50, text: "API" },
      { id: "db", type: "rectangle", x: 300, y: 0, w: 100, h: 50 },
      { id: "arrow", type: "arrow", x: 100, y: 25, w: 200, h: 0, from: "box", to: "db" },
    ]);
  });
});

describe("applyCanvasPatches", () => {
  it("moves a shape with its label and the arrow end bound to it", () => {
    const result = applyCanvasPatches(scene(), [{ id: "box", x: 0, y: 100 }]);
    expect(byId(result.elements, "box")).toMatchObject({ y: 100, version: 2 });
    expect(byId(result.elements, "label")).toMatchObject({ y: 115 });
    expect(byId(result.elements, "arrow")).toMatchObject({
      x: 100,
      y: 125,
      points: [
        [0, 0],
        [200, -100],
      ],
      height: 100,
    });
    expect(result.changedIds).toEqual(["box", "label", "arrow"]);
  });

  it("returns label edits for the renderer instead of editing text", () => {
    const result = applyCanvasPatches(scene(), [
      { id: "box", label: "Gateway" },
      { id: "db", backgroundColor: "#a5d8ff" },
    ]);
    expect(result.relabels).toEqual([{ id: "box", text: "Gateway" }]);
    expect(result.changedIds).toEqual(["db"]);
  });

  it("refuses unknown ids and fields Excalidraw maintains", () => {
    expect(() => applyCanvasPatches(scene(), [{ id: "nope", x: 1 }])).toThrow(CanvasPatchError);
    expect(() => applyCanvasPatches(scene(), [{ id: "box", version: 9 }])).toThrow("version");
  });
});

describe("deleteCanvasElements", () => {
  it("deletes labels with their container and unbinds arrows", () => {
    const result = deleteCanvasElements(scene(), ["box"]);
    expect(result.deletedIds).toEqual(["box", "label"]);
    expect(byId(result.elements, "arrow")).toMatchObject({ startBinding: null, isDeleted: false });
    expect(byId(result.elements, "db").boundElements).toEqual([{ id: "arrow", type: "arrow" }]);
  });
});

describe("unknownCanvasReferences", () => {
  it("names bindings to elements that do not exist", () => {
    expect(
      unknownCanvasReferences({ elements: scene() }, [
        { type: "arrow", start: { id: "box" }, end: { id: "cache" } },
      ]),
    ).toEqual(["cache"]);
  });
});

describe("images", () => {
  it("reads sizes from image headers", () => {
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    expect(readImageInfo(png)).toEqual({ mimeType: "image/png", width: 640, height: 480 });

    const svg = new TextEncoder().encode('<svg viewBox="0 0 300 150"></svg>');
    expect(readImageInfo(svg)).toMatchObject({
      mimeType: "image/svg+xml",
      width: 300,
      height: 150,
    });
    expect(readImageInfo(new TextEncoder().encode("hello"))).toBeNull();
  });

  it("shrinks only large raster images", () => {
    const big = { mimeType: "image/png", width: 3000, height: 1000 };
    expect(shouldDownscaleImage(big, 1000)).toBe(true);
    expect(shouldDownscaleImage({ ...big, width: 800 }, 1000)).toBe(false);
    expect(shouldDownscaleImage({ ...big, width: 800 }, 2_000_000)).toBe(true);
    expect(shouldDownscaleImage({ ...big, mimeType: "image/svg+xml" }, 2_000_000)).toBe(false);
  });

  it("keeps the aspect ratio when placing", () => {
    const info = { width: 1600, height: 800 };
    expect(placeCanvasImage(info, {}, { x: 5, y: 6 })).toEqual({
      x: 5,
      y: 6,
      width: 800,
      height: 400,
    });
    expect(placeCanvasImage(info, { height: 100 }, { x: 0, y: 0 })).toMatchObject({ width: 200 });
  });
});

describe("embeddedSceneFromPng", () => {
  it("reads the scene from a PNG's text chunk", () => {
    const json = '{"type":"excalidraw","elements":[]}';
    const encoded = NodeZlib.deflateSync(Buffer.from(json)).toString("latin1");
    const envelope = JSON.stringify({
      version: "1",
      encoding: "bstring",
      compressed: true,
      encoded,
    });
    const data = Buffer.concat([
      Buffer.from("application/vnd.excalidraw+json\0", "latin1"),
      Buffer.from(envelope, "latin1"),
    ]);
    const chunk = (type: string, body: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(body.length, 0);
      head.write(type, 4, "latin1");
      return Buffer.concat([head, body, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", Buffer.alloc(13)),
      chunk("tEXt", data),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(embeddedSceneFromPng(new Uint8Array(png))).toBe(json);
    expect(embeddedSceneFromPng(new Uint8Array(png.subarray(0, 33)))).toBeNull();
  });
});
