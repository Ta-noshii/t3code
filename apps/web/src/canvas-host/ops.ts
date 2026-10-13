import {
  convertToExcalidrawElements,
  exportToCanvas,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { CanvasElement } from "@t3tools/contracts";
import type { CanvasHostOp, CanvasHostResult } from "@t3tools/shared/canvas";

type Elements = Parameters<typeof exportToCanvas>[0]["elements"];
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

async function render(op: Extract<CanvasHostOp, { op: "render" }>): Promise<CanvasHostResult> {
  // Excalidraw crops exports to a frame, so the crop rectangle becomes one.
  const [cropFrame] = convertToExcalidrawElements([
    { type: "frame", children: [], ...op.rect, name: "" },
  ]);
  const canvas = await exportToCanvas({
    elements: live(op.scene.elements),
    appState: {
      ...op.scene.appState,
      exportBackground: op.background,
      exportWithDarkMode: op.dark,
    },
    files: op.scene.files as never,
    exportPadding: 0,
    exportingFrame: cropFrame as never,
    getDimensions: (width: number, height: number) => ({
      width: Math.max(1, Math.round(width * op.scale)),
      height: Math.max(1, Math.round(height * op.scale)),
      scale: op.scale,
    }),
  });
  const png = canvas.toDataURL("image/png");
  return {
    png: png.slice(png.indexOf(",") + 1),
    width: canvas.width,
    height: canvas.height,
  };
}

function convertOnce(op: Extract<CanvasHostOp, { op: "convert" }>) {
  return convertToExcalidrawElements([...op.existing, ...op.skeletons] as unknown as Skeletons, {
    regenerateIds: false,
  });
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
