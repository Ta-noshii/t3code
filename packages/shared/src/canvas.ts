/**
 * Excalidraw canvas helpers shared by the server, the web editor, and the
 * canvas host page: file formats, the stored file shape, element merging,
 * and screenshot crop math. Elements stay plain records; only the fields
 * Excalidraw itself merges and bounds by are read here.
 */
import type {
  CanvasBinaryFile,
  CanvasCrop,
  CanvasElement,
  CanvasFormat,
  CanvasRect,
  CanvasScene,
} from "@t3tools/contracts";
import { CANVAS_SCREENSHOT_DEFAULT_SIZE, CANVAS_SCREENSHOT_MAX_SIZE } from "@t3tools/contracts";

export const CANVAS_FILE_EXTENSION = ".excalidraw";

const FORMAT_SUFFIXES: ReadonlyArray<readonly [string, CanvasFormat]> = [
  [".excalidraw.json", "excalidraw"],
  [".excalidraw.svg", "excalidraw-svg"],
  [".excalidraw.png", "excalidraw-png"],
  [".excalidraw", "excalidraw"],
];

/** The canvas format a file name implies, or null for anything else. */
export function canvasFormatForPath(path: string): CanvasFormat | null {
  const lower = path.toLowerCase();
  return FORMAT_SUFFIXES.find(([suffix]) => lower.endsWith(suffix))?.[1] ?? null;
}

/** The file name without its canvas suffix: "auth-flow" for "auth-flow.excalidraw.json". */
export function canvasBaseName(path: string): string {
  const name = path.split(/[\\/]/u).pop() ?? path;
  const suffix = FORMAT_SUFFIXES.find(([candidate]) => name.toLowerCase().endsWith(candidate));
  return suffix ? name.slice(0, name.length - suffix[0].length) : name;
}

/** "Auth flow: v2" → "auth-flow-v2". */
export function canvasSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "");
  return slug || "canvas";
}

/** "auth-flow_v2" → "Auth flow v2", for files that carry no title. */
function canvasTitleFromName(name: string): string {
  const words = name.replace(/[-_]+/gu, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Untitled";
}

export function canvasTitle(scene: Pick<CanvasScene, "appState">, path: string): string {
  const name = scene.appState.name;
  return typeof name === "string" && name.trim()
    ? name.trim()
    : canvasTitleFromName(canvasBaseName(path));
}

// The editor state worth keeping in a committed file. Everything else
// (scroll, zoom, selection, open menus) is per viewer.
const STORED_APP_STATE_KEYS = [
  "name",
  "viewBackgroundColor",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "lockedMultiSelections",
] as const;

export function storedAppState(
  appState: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  for (const key of STORED_APP_STATE_KEYS) {
    if (appState[key] !== undefined && appState[key] !== null) stored[key] = appState[key];
  }
  return stored;
}

export function emptyCanvasScene(name?: string): CanvasScene {
  return {
    elements: [],
    appState: { ...(name ? { name } : {}), viewBackgroundColor: "#ffffff", gridSize: 20 },
    files: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}

/**
 * The file text for a scene: Excalidraw's own JSON shape with every object's
 * keys sorted and 2-space indent, so the same scene always writes the same
 * bytes and diffs stay small. Deleted elements and images no element uses
 * are left out, as Excalidraw does when it saves a file.
 */
export function serializeCanvasScene(scene: CanvasScene): string {
  const elements = scene.elements.filter((element) => element.isDeleted !== true);
  const usedFiles = new Set(
    elements.flatMap((element) => (typeof element.fileId === "string" ? [element.fileId] : [])),
  );
  const files: Record<string, CanvasBinaryFile> = {};
  for (const id of Object.keys(scene.files).sort()) {
    if (usedFiles.has(id)) files[id] = scene.files[id]!;
  }
  const document = {
    type: "excalidraw",
    version: 2,
    source: "https://t3.codes",
    elements: elements.map(sortKeys),
    appState: sortKeys(storedAppState(scene.appState)),
    files: sortKeys(files),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** Reads an Excalidraw JSON document. Returns null when it is not one. */
export function parseCanvasScene(text: string): CanvasScene | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.type !== "excalidraw") return null;
  const elements = Array.isArray(value.elements) ? value.elements.filter(isRecord) : [];
  const files: Record<string, CanvasBinaryFile> = {};
  if (isRecord(value.files)) {
    for (const [id, file] of Object.entries(value.files)) {
      if (isRecord(file) && typeof file.dataURL === "string" && typeof file.mimeType === "string") {
        files[id] = {
          id: typeof file.id === "string" ? file.id : id,
          mimeType: file.mimeType,
          dataURL: file.dataURL,
          created: typeof file.created === "number" ? file.created : 0,
          ...(typeof file.lastRetrieved === "number" ? { lastRetrieved: file.lastRetrieved } : {}),
        };
      }
    }
  }
  return {
    elements,
    appState: isRecord(value.appState) ? storedAppState(value.appState) : {},
    files,
  };
}

/** Elements and images the scene shows, ignoring deleted ones. */
export function canvasSceneCounts(scene: CanvasScene): {
  readonly elementCount: number;
  readonly imageCount: number;
} {
  const live = scene.elements.filter((element) => element.isDeleted !== true);
  return {
    elementCount: live.length,
    imageCount: live.filter((element) => element.type === "image").length,
  };
}

function version(element: CanvasElement): number {
  return typeof element.version === "number" ? element.version : 0;
}

function nonce(element: CanvasElement): number {
  return typeof element.versionNonce === "number" ? element.versionNonce : 0;
}

/** Excalidraw's rule: the higher version wins, and the lower nonce breaks a tie. */
function newer(left: CanvasElement, right: CanvasElement): CanvasElement {
  if (version(left) !== version(right)) return version(left) > version(right) ? left : right;
  return nonce(left) <= nonce(right) ? left : right;
}

function byId(elements: ReadonlyArray<CanvasElement>): Map<string, CanvasElement> {
  const map = new Map<string, CanvasElement>();
  for (const element of elements) {
    if (typeof element.id === "string") map.set(element.id, element);
  }
  return map;
}

/**
 * Merges two edits of the same scene element by element. Both sides changed
 * from `base`; an element on one side only was added there, unless `base`
 * had it at that same version, in which case the other side deleted it.
 * Without a base, every element on either side is kept. Order follows
 * Excalidraw's fractional `index` when all elements carry one, and `local`'s
 * order otherwise.
 */
export function mergeCanvasElements(input: {
  readonly base: ReadonlyArray<CanvasElement> | null;
  readonly local: ReadonlyArray<CanvasElement>;
  readonly remote: ReadonlyArray<CanvasElement>;
}): CanvasElement[] {
  const base = input.base ? byId(input.base) : new Map<string, CanvasElement>();
  const local = byId(input.local);
  const remote = byId(input.remote);
  const deletedElsewhere = (element: CanvasElement) => {
    const before = base.get(element.id as string);
    return before !== undefined && version(before) === version(element);
  };
  const merged: CanvasElement[] = [];
  const seen = new Set<string>();
  for (const element of [...input.local, ...input.remote]) {
    const id = element.id;
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    const mine = local.get(id);
    const theirs = remote.get(id);
    const winner = mine && theirs ? newer(mine, theirs) : (mine ?? theirs)!;
    if (!(mine && theirs) && deletedElsewhere(winner)) continue;
    merged.push(winner);
  }
  if (merged.every((element) => typeof element.index === "string")) {
    return [...merged].sort((left, right) => {
      const a = left.index as string;
      const b = right.index as string;
      if (a !== b) return a < b ? -1 : 1;
      return (left.id as string) < (right.id as string) ? -1 : 1;
    });
  }
  return merged;
}

// Screenshot geometry. Scene units are Excalidraw's canvas coordinates.

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** An element's axis-aligned box, accounting for line points and rotation. */
export function canvasElementBounds(element: CanvasElement): CanvasRect | null {
  const x = num(element.x);
  const y = num(element.y);
  let minX = x;
  let minY = y;
  let maxX = x + num(element.width);
  let maxY = y + num(element.height);
  if (Array.isArray(element.points) && element.points.length > 0) {
    minX = Infinity;
    minY = Infinity;
    maxX = -Infinity;
    maxY = -Infinity;
    for (const point of element.points) {
      if (!Array.isArray(point)) continue;
      const px = x + num(point[0]);
      const py = y + num(point[1]);
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
    if (!Number.isFinite(minX)) return null;
  }
  const angle = num(element.angle);
  if (angle !== 0) {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const halfWidth = ((maxX - minX) * cos + (maxY - minY) * sin) / 2;
    const halfHeight = ((maxX - minX) * sin + (maxY - minY) * cos) / 2;
    minX = cx - halfWidth;
    maxX = cx + halfWidth;
    minY = cy - halfHeight;
    maxY = cy + halfHeight;
  }
  // Strokes are drawn centred on the outline, so half of one sits outside it.
  const stroke = num(element.strokeWidth) / 2;
  return {
    x: minX - stroke,
    y: minY - stroke,
    width: Math.max(1, maxX - minX + stroke * 2),
    height: Math.max(1, maxY - minY + stroke * 2),
  };
}

export function unionCanvasRects(rects: ReadonlyArray<CanvasRect>): CanvasRect | null {
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export class CanvasCropError extends Error {}

const CANVAS_SCREENSHOT_DEFAULT_PADDING = 24;
// Frames crop tight, like Excalidraw's frame export. Two units keep the
// border's antialiased edge and stop just below the frame's name.
const CANVAS_FRAME_DEFAULT_PADDING = 2;
// Excalidraw draws every frame border at this width, whatever the element says.
const CANVAS_FRAME_STROKE_WIDTH = 2;
// A small crop is enlarged at most this much, so a single shape does not
// come back as a blurry 1600 px blow-up.
const MAX_AUTO_SCALE = 3;

/**
 * The scene rectangle a crop shows, padding included. Element crops take
 * the listed elements plus the text bound inside them; frame crops match a
 * frame's name or id and default to a few units of padding instead.
 */
export function canvasCropRect(
  elements: ReadonlyArray<CanvasElement>,
  crop: CanvasCrop,
  padding?: number,
): CanvasRect {
  const live = elements.filter((element) => element.isDeleted !== true);
  const pad = (rect: CanvasRect | null, amount: number) => {
    if (rect === null) throw new CanvasCropError("The canvas is empty.");
    return {
      x: rect.x - amount,
      y: rect.y - amount,
      width: rect.width + amount * 2,
      height: rect.height + amount * 2,
    };
  };
  const boundsOf = (list: ReadonlyArray<CanvasElement>) =>
    unionCanvasRects(list.flatMap((element) => canvasElementBounds(element) ?? []));
  switch (crop.type) {
    case "full":
      return pad(boundsOf(live), padding ?? CANVAS_SCREENSHOT_DEFAULT_PADDING);
    case "rect":
      return pad(crop.rect, padding ?? CANVAS_SCREENSHOT_DEFAULT_PADDING);
    case "elements": {
      const ids = new Set(crop.ids);
      const picked = live.filter(
        (element) =>
          ids.has(element.id as string) ||
          (typeof element.containerId === "string" && ids.has(element.containerId)),
      );
      const missing = crop.ids.filter((id) => !live.some((element) => element.id === id));
      if (missing.length > 0) {
        throw new CanvasCropError(`No elements with ids ${missing.join(", ")}.`);
      }
      return pad(boundsOf(picked), padding ?? CANVAS_SCREENSHOT_DEFAULT_PADDING);
    }
    case "frame": {
      const frames = live.filter(
        (element) => element.type === "frame" || element.type === "magicframe",
      );
      const frame =
        frames.find((element) => element.id === crop.frame) ??
        frames.find((element) => element.name === crop.frame) ??
        frames.find(
          (element) =>
            typeof element.name === "string" &&
            element.name.toLowerCase() === crop.frame.toLowerCase(),
        );
      if (!frame) {
        const names = frames.map((element) =>
          typeof element.name === "string" ? element.name : String(element.id),
        );
        throw new CanvasCropError(
          names.length > 0
            ? `No frame named ${crop.frame}. Frames: ${names.join(", ")}.`
            : "The canvas has no frames.",
        );
      }
      return pad(
        canvasElementBounds({ ...frame, strokeWidth: CANVAS_FRAME_STROKE_WIDTH }),
        padding ?? CANVAS_FRAME_DEFAULT_PADDING,
      );
    }
  }
}

/**
 * Output pixels per scene unit. An explicit scale wins; otherwise the longest
 * side is fitted to `maxSize`. Either way the image stays within the cap.
 */
export function canvasExportScale(
  rect: CanvasRect,
  options: { readonly scale?: number | undefined; readonly maxSize?: number | undefined },
): number {
  const longest = Math.max(rect.width, rect.height);
  const target = Math.min(
    options.maxSize ?? CANVAS_SCREENSHOT_DEFAULT_SIZE,
    CANVAS_SCREENSHOT_MAX_SIZE,
  );
  const scale = options.scale ?? Math.min(target / longest, MAX_AUTO_SCALE);
  return Math.min(scale, CANVAS_SCREENSHOT_MAX_SIZE / longest);
}

/** Longest side, in pixels, an image keeps once it is placed on a canvas. */
export const CANVAS_IMAGE_MAX_SIZE = 2048;

/**
 * Work the canvas host page does for the server's headless renderer. The
 * server writes one op to `/__t3/input.json` and reads back the result.
 */
export type CanvasHostOp =
  | {
      readonly op: "render";
      readonly scene: CanvasScene;
      readonly rect: CanvasRect;
      readonly scale: number;
      readonly background: boolean;
      readonly dark: boolean;
    }
  | {
      /**
       * Turns Excalidraw element skeletons into full elements. `existing`
       * holds the elements the skeletons bind to, so arrows can attach.
       */
      readonly op: "convert";
      readonly skeletons: ReadonlyArray<Record<string, unknown>>;
      readonly existing: ReadonlyArray<CanvasElement>;
    }
  | {
      /** Remeasures text and repairs bindings after a patch. */
      readonly op: "normalize";
      readonly elements: ReadonlyArray<CanvasElement>;
    }
  | {
      readonly op: "downscale";
      readonly dataURL: string;
      readonly maxSize: number;
    };

export type CanvasHostResult =
  | { readonly error: string }
  | { readonly png: string; readonly width: number; readonly height: number }
  | { readonly elements: ReadonlyArray<CanvasElement> }
  | {
      readonly dataURL: string;
      readonly mimeType: string;
      readonly width: number;
      readonly height: number;
    };
