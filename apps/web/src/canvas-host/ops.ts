import {
  convertToExcalidrawElements,
  elementsOverlappingBBox,
  exportToCanvas,
  getCommonBounds,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { CanvasElement } from "@t3tools/contracts";
import type { CanvasHostOp, CanvasHostResult } from "@t3tools/shared/canvas";

type Elements = readonly ExcalidrawElement[];
type Skeletons = Parameters<typeof convertToExcalidrawElements>[0];

const live = (elements: ReadonlyArray<CanvasElement>) =>
  elements.filter((element) => element.isDeleted !== true) as unknown as Elements;

const plain = (elements: ReadonlyArray<object>) =>
  JSON.parse(JSON.stringify(elements)) as CanvasElement[];

// Text is measured with whatever font is loaded at the time. Exporting a
// tiny image first makes Excalidraw load the fonts these elements use, so
// the measuring pass that follows gets the real glyph widths.
async function loadFonts(elements: Elements): Promise<void> {
  if (!elements.some((element: { readonly type: string }) => element.type === "text")) return;
  await exportToCanvas({ elements, files: null, maxWidthOrHeight: 8 });
}

/**
 * Excalidraw only crops exports to a frame, and a frame export leaves out
 * elements that belong to other frames. So the scene around the crop is
 * exported whole and the crop is cut from it. A transparent box the size of
 * the crop keeps empty parts of it in the export.
 */
async function render(op: Extract<CanvasHostOp, { op: "render" }>): Promise<CanvasHostResult> {
  const { rect, scale } = op;
  const all = live(op.scene.elements);
  const byId = new Map(all.map((element) => [element.id, element]));
  const kept = new Set<ExcalidrawElement>(
    elementsOverlappingBBox({
      elements: all,
      bounds: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
      type: "overlap",
    }),
  );
  // Frames clip their children and containers place their text, so both
  // come along with any element of theirs that is in view.
  for (const element of Array.from(kept)) {
    for (const id of [element.frameId, "containerId" in element ? element.containerId : null]) {
      const owner = id ? byId.get(id) : undefined;
      if (owner) kept.add(owner);
    }
  }
  const [anchor] = convertToExcalidrawElements([
    {
      type: "rectangle",
      ...rect,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      opacity: 0,
    },
  ]);
  const elements = [...all.filter((element) => kept.has(element)), anchor!] as Elements;
  // The export starts at the top left of its top-level elements.
  const [minX, minY] = getCommonBounds(elements.filter((element) => !element.frameId));
  const scene = await exportToCanvas({
    elements,
    appState: {
      ...op.scene.appState,
      exportBackground: op.background,
      exportWithDarkMode: op.dark,
    },
    files: op.scene.files as never,
    exportPadding: 0,
    getDimensions: (width: number, height: number) => ({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale,
    }),
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(rect.width * scale));
  canvas.height = Math.max(1, Math.round(rect.height * scale));
  canvas
    .getContext("2d")
    ?.drawImage(scene, Math.round((minX - rect.x) * scale), Math.round((minY - rect.y) * scale));
  const png = canvas.toDataURL("image/png");
  return {
    png: png.slice(png.indexOf(",") + 1),
    width: canvas.width,
    height: canvas.height,
  };
}

// Space between an arrow's end and the shape it points at.
const ARROW_GAP = 8;
// Excalidraw's size for shapes given without one.
const DEFAULT_SIZE = 100;

type Box = { x: number; y: number; width: number; height: number; type: string };

function boxOf(element: CanvasElement | undefined): Box | undefined {
  if (!element || typeof element.x !== "number" || typeof element.y !== "number") return;
  const sized = typeof element.width === "number" && typeof element.height === "number";
  // Text sizes come from measuring, so unsized text is a point.
  if (!sized && element.type === "text") {
    return { x: element.x, y: element.y, width: 0, height: 0, type: "text" };
  }
  return {
    x: element.x,
    y: element.y,
    width: sized ? (element.width as number) : DEFAULT_SIZE,
    height: sized ? (element.height as number) : DEFAULT_SIZE,
    type: String(element.type),
  };
}

/** Where a ray from the center of `box` along unit vector (ux, uy) leaves its outline. */
function edge(box: Box, ux: number, uy: number): [number, number] {
  const hw = box.width / 2;
  const hh = box.height / 2;
  const cx = box.x + hw;
  const cy = box.y + hh;
  if (hw === 0 || hh === 0) return [cx, cy];
  const t =
    box.type === "ellipse"
      ? 1 / Math.hypot(ux / hw, uy / hh)
      : box.type === "diamond"
        ? 1 / (Math.abs(ux) / hw + Math.abs(uy) / hh)
        : Math.min(
            ux === 0 ? Infinity : hw / Math.abs(ux),
            uy === 0 ? Infinity : hh / Math.abs(uy),
          );
  return [cx + ux * (t + ARROW_GAP), cy + uy * (t + ARROW_GAP)];
}

/**
 * Excalidraw binds an arrow to shapes named by id but leaves it where it was
 * drawn. An arrow given both ends and no points of its own is laid from the
 * edge of one shape to the edge of the other instead.
 */
function routeArrows(
  skeletons: ReadonlyArray<CanvasElement>,
  existing: ReadonlyArray<CanvasElement>,
): CanvasElement[] {
  const shapes = new Map<string, CanvasElement>();
  for (const element of [...existing, ...skeletons]) {
    if (typeof element.id === "string") shapes.set(element.id, element);
  }
  const endId = (end: unknown) =>
    typeof end === "object" && end !== null && "id" in end && typeof end.id === "string"
      ? end.id
      : undefined;
  return skeletons.map((skeleton) => {
    if (skeleton.type !== "arrow" && skeleton.type !== "line") return skeleton;
    if (Array.isArray(skeleton.points) || typeof skeleton.width === "number") return skeleton;
    const startId = endId(skeleton.start);
    const finishId = endId(skeleton.end);
    const from = boxOf(startId ? shapes.get(startId) : undefined);
    const to = boxOf(finishId ? shapes.get(finishId) : undefined);
    if (!from || !to) return skeleton;
    const dx = to.x + to.width / 2 - (from.x + from.width / 2);
    const dy = to.y + to.height / 2 - (from.y + from.height / 2);
    const length = Math.hypot(dx, dy);
    if (length === 0) return skeleton;
    const [x1, y1] = edge(from, dx / length, dy / length);
    const [x2, y2] = edge(to, -dx / length, -dy / length);
    return {
      ...skeleton,
      x: x1,
      y: y1,
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      points: [
        [0, 0],
        [x2 - x1, y2 - y1],
      ],
    };
  });
}

// Excalidraw reads `children` from every frame it converts, existing frames
// included, and throws when a frame has none. It also sizes frames from their
// children and treats a 0 coordinate as unset, so the given box is put back.
const FRAME_BOX = ["x", "y", "width", "height"] as const;

function convertOnce(op: Extract<CanvasHostOp, { op: "convert" }>) {
  const input = [...op.existing, ...routeArrows(op.skeletons, op.existing)];
  const frames = new Map<string, CanvasElement>();
  const prepared = input.map((element) => {
    if (element.type !== "frame" && element.type !== "magicframe") return element;
    if (typeof element.id === "string") frames.set(element.id, element);
    return Array.isArray(element.children) ? element : { ...element, children: [] };
  });
  const converted = convertToExcalidrawElements(prepared as unknown as Skeletons, {
    regenerateIds: false,
  });
  for (const element of converted) {
    const source = frames.get(element.id);
    if (!source) continue;
    for (const key of FRAME_BOX) {
      if (typeof source[key] === "number") Object.assign(element, { [key]: source[key] });
    }
  }
  return converted;
}

async function convert(op: Extract<CanvasHostOp, { op: "convert" }>): Promise<CanvasHostResult> {
  await loadFonts(convertOnce(op));
  const converted = convertOnce(op);
  const existing = new Map(op.existing.map((element) => [element.id as string, element]));
  const elements: object[] = [];
  for (const element of converted) {
    const before = existing.get(element.id);
    if (before === undefined) {
      elements.push(element);
      continue;
    }
    // Existing elements only pass through so new arrows can bind to them;
    // keep them as they were apart from the new bindings.
    const boundElements = element.boundElements ?? null;
    if (JSON.stringify(boundElements) === JSON.stringify(before.boundElements ?? null)) continue;
    elements.push({
      ...before,
      boundElements,
      version: (typeof before.version === "number" ? before.version : 1) + 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
    });
  }
  return { elements: plain(elements) };
}

async function normalize(
  op: Extract<CanvasHostOp, { op: "normalize" }>,
): Promise<CanvasHostResult> {
  const elements = op.elements as unknown as Elements;
  await loadFonts(elements);
  return {
    elements: plain(
      restoreElements(elements, null, { refreshDimensions: true, repairBindings: true }),
    ),
  };
}

async function downscale(
  op: Extract<CanvasHostOp, { op: "downscale" }>,
): Promise<CanvasHostResult> {
  const image = new Image();
  image.src = op.dataURL;
  await image.decode();
  const ratio = Math.min(1, op.maxSize / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
  canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
  // WebP keeps transparency and is far smaller than PNG for screenshots and
  // photos alike. Browsers without a WebP encoder hand back PNG instead.
  const dataURL = canvas.toDataURL("image/webp", 0.9);
  return {
    dataURL,
    mimeType: dataURL.slice("data:".length, dataURL.indexOf(";")),
    width: canvas.width,
    height: canvas.height,
  };
}

/**
 * Runs one op. Bad element input comes back as `{ error }` so the server can
 * tell the agent what to fix; anything else throws.
 */
export async function runCanvasHostOp(op: CanvasHostOp): Promise<CanvasHostResult> {
  switch (op.op) {
    case "render":
      return render(op);
    case "downscale":
      return downscale(op);
    case "convert":
    case "normalize":
      try {
        return op.op === "convert" ? await convert(op) : await normalize(op);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
  }
}
