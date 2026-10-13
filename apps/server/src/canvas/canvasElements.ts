// @effect-diagnostics globalDate:off globalRandom:off - element versions carry a wall-clock time and random nonce, as Excalidraw writes them.
/**
 * Element edits and summaries the canvas tools make on the server, without
 * Excalidraw. Anything that measures text or builds new elements goes through
 * the canvas renderer instead.
 */
import type { CanvasElement, CanvasScene } from "@t3tools/contracts";
import { CANVAS_IMAGE_MAX_SIZE } from "@t3tools/shared/canvas";

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const round = (value: unknown) => Math.round(num(value));
const idOf = (element: CanvasElement) => element.id as string;
const live = (elements: ReadonlyArray<CanvasElement>) =>
  elements.filter((element) => element.isDeleted !== true);

const bindingTarget = (binding: unknown) =>
  typeof binding === "object" && binding !== null && "elementId" in binding
    ? String((binding as { elementId: unknown }).elementId)
    : undefined;

/** One line of `canvas_read`'s summary. */
export interface CanvasElementSummary {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text?: string;
  readonly name?: string;
  readonly frame?: string;
  readonly from?: string;
  readonly to?: string;
  readonly group?: ReadonlyArray<string>;
  readonly stroke?: string;
  readonly fill?: string;
  readonly link?: string;
}

/**
 * A compact view of the scene for the agent: every live element with its
 * box, and the text inside containers folded into the container as `text`.
 * Colors appear only when they differ from Excalidraw's defaults.
 */
export function summarizeCanvasElements(
  elements: ReadonlyArray<CanvasElement>,
): CanvasElementSummary[] {
  const optional = <K extends string, V>(key: K, value: V | undefined) =>
    value === undefined ? {} : ({ [key]: value } as Record<K, V>);
  const shown = live(elements);
  const labels = new Map<string, string>();
  for (const element of shown) {
    if (typeof element.containerId === "string" && typeof element.text === "string") {
      labels.set(element.containerId, element.text);
    }
  }
  return shown
    .filter((element) => !(element.type === "text" && typeof element.containerId === "string"))
    .map((element) => {
      const text = typeof element.text === "string" ? element.text : labels.get(idOf(element));
      const groups = Array.isArray(element.groupIds) ? (element.groupIds as string[]) : [];
      const stroke = element.strokeColor;
      const fill = element.backgroundColor;
      return {
        id: idOf(element),
        type: String(element.type),
        x: round(element.x),
        y: round(element.y),
        w: round(element.width),
        h: round(element.height),
        ...(text !== undefined && text !== "" ? { text } : {}),
        ...(typeof element.name === "string" && element.name !== "" ? { name: element.name } : {}),
        ...(typeof element.frameId === "string" ? { frame: element.frameId } : {}),
        ...optional("from", bindingTarget(element.startBinding)),
        ...optional("to", bindingTarget(element.endBinding)),
        ...(groups.length > 0 ? { group: groups } : {}),
        ...(typeof stroke === "string" && stroke !== "#1e1e1e" ? { stroke } : {}),
        ...(typeof fill === "string" && fill !== "transparent" ? { fill } : {}),
        ...(typeof element.link === "string" && element.link !== "" ? { link: element.link } : {}),
      };
    });
}

/** Fields a patch may not set: identity, history, and links Excalidraw maintains. */
const RESERVED_PATCH_FIELDS = new Set([
  "id",
  "type",
  "version",
  "versionNonce",
  "updated",
  "seed",
  "isDeleted",
  "index",
  "boundElements",
  "containerId",
]);

export interface CanvasElementPatch {
  readonly id: string;
  readonly [field: string]: unknown;
}

export class CanvasPatchError extends Error {}

const randomNonce = () => Math.floor(Math.random() * 2 ** 31);

/** The element at its next version, as Excalidraw records an edit. */
export function bumpCanvasElement(element: CanvasElement, changes: object): CanvasElement {
  return {
    ...element,
    ...changes,
    version: num(element.version) + 1,
    versionNonce: randomNonce(),
    updated: Date.now(),
  };
}

const shiftPoints = (
  points: unknown,
  index: "first" | "last",
  dx: number,
  dy: number,
): number[][] | undefined => {
  if (!Array.isArray(points) || points.length === 0) return undefined;
  const copy = points.map((point) =>
    Array.isArray(point) ? [num(point[0]), num(point[1])] : [0, 0],
  );
  const at = index === "first" ? 0 : copy.length - 1;
  copy[at] = [copy[at]![0]! + dx, copy[at]![1]! + dy];
  return copy;
};

/** Points re-based so the first is at 0,0, with the matching x, y, width and height. */
const rebasePoints = (x: number, y: number, points: number[][]) => {
  const [ox, oy] = points[0]!;
  const rebased = points.map(([px, py]) => [px! - ox!, py! - oy!]);
  const xs = rebased.map((point) => point[0]!);
  const ys = rebased.map((point) => point[1]!);
  return {
    x: x + ox!,
    y: y + oy!,
    points: rebased,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

export interface PatchedCanvas {
  readonly elements: CanvasElement[];
  readonly changedIds: ReadonlyArray<string>;
  /** Containers whose label text changed; the renderer rebuilds their text. */
  readonly relabels: ReadonlyArray<{ readonly id: string; readonly text: string }>;
  /** Free text elements whose text or font changed and need remeasuring. */
  readonly remeasure: ReadonlyArray<string>;
}

/**
 * Applies field patches by id. Moving a shape carries its label and the ends
 * of arrows bound to it; moving a frame carries everything in it. `label` on
 * a container (or `text` on a label) is returned as a relabel for the
 * renderer, since only Excalidraw can wrap and centre text in a shape.
 */
export function applyCanvasPatches(
  elements: ReadonlyArray<CanvasElement>,
  patches: ReadonlyArray<CanvasElementPatch>,
): PatchedCanvas {
  const byId = new Map(elements.map((element) => [idOf(element), element]));
  const changed = new Set<string>();
  const relabels = new Map<string, string>();
  const remeasure = new Set<string>();
  const update = (id: string, changes: object) => {
    const element = byId.get(id)!;
    byId.set(
      id,
      changed.has(id) ? { ...element, ...changes } : bumpCanvasElement(element, changes),
    );
    changed.add(id);
  };

  const moveBy = (id: string, dx: number, dy: number) => {
    const element = byId.get(id)!;
    update(id, { x: num(element.x) + dx, y: num(element.y) + dy });
  };

  for (const patch of patches) {
    const element = byId.get(patch.id);
    if (element === undefined || element.isDeleted === true) {
      throw new CanvasPatchError(`No element with id ${patch.id}.`);
    }
    const reserved = Object.keys(patch).filter(
      (key) => key !== "id" && RESERVED_PATCH_FIELDS.has(key),
    );
    if (reserved.length > 0) {
      throw new CanvasPatchError(`${reserved.join(", ")} cannot be patched (element ${patch.id}).`);
    }
    const { id, label, ...patchFields } = patch;
    const fields: Record<string, unknown> = { ...patchFields };
    const containerId = typeof element.containerId === "string" ? element.containerId : null;

    // A label edit, either through the container or through its text element.
    const labelText =
      typeof label === "string"
        ? label
        : containerId !== null && typeof fields.text === "string"
          ? fields.text
          : undefined;
    if (labelText !== undefined) {
      relabels.set(containerId ?? id, labelText);
      delete fields.text;
      delete fields.originalText;
    }
    if (element.type === "text" && containerId === null && typeof fields.text === "string") {
      fields.originalText = fields.text;
    }
    if (Object.keys(fields).length === 0) continue;

    const dx = "x" in fields ? num(fields.x) - num(element.x) : 0;
    const dy = "y" in fields ? num(fields.y) - num(element.y) : 0;
    update(id, fields);
    if (element.type === "text" && containerId === null) {
      if (["text", "fontSize", "fontFamily"].some((key) => key in fields)) remeasure.add(id);
    }
    if (dx === 0 && dy === 0) continue;

    // Everything that travels with the moved element.
    const moved = new Set([id]);
    if (element.type === "frame" || element.type === "magicframe") {
      for (const child of live(elements)) {
        if (child.frameId === id) {
          moved.add(idOf(child));
          moveBy(idOf(child), dx, dy);
        }
      }
    }
    for (const other of live([...byId.values()])) {
      const otherId = idOf(other);
      if (typeof other.containerId === "string" && moved.has(other.containerId)) {
        if (!moved.has(otherId)) moveBy(otherId, dx, dy);
        continue;
      }
      if (moved.has(otherId) || !Array.isArray(other.points)) continue;
      const start = bindingTarget(other.startBinding);
      const end = bindingTarget(other.endBinding);
      let points = other.points as unknown;
      if (start !== undefined && moved.has(start)) points = shiftPoints(points, "first", dx, dy);
      if (end !== undefined && moved.has(end)) points = shiftPoints(points, "last", dx, dy);
      if (points !== other.points && Array.isArray(points)) {
        update(otherId, rebasePoints(num(other.x), num(other.y), points as number[][]));
      }
    }
  }

  return {
    elements: elements.map((element) => byId.get(idOf(element))!),
    changedIds: [...changed],
    relabels: [...relabels].map(([id, text]) => ({ id, text })),
    remeasure: [...remeasure],
  };
}

/**
 * Marks elements deleted, along with their labels and anything bound inside
 * them. Arrows bound to a deleted shape stay, unbound.
 */
export function deleteCanvasElements(
  elements: ReadonlyArray<CanvasElement>,
  ids: ReadonlyArray<string>,
): { readonly elements: CanvasElement[]; readonly deletedIds: ReadonlyArray<string> } {
  const known = new Set(live(elements).map(idOf));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length > 0) throw new CanvasPatchError(`No elements with ids ${missing.join(", ")}.`);
  const doomed = new Set(ids);
  for (const element of live(elements)) {
    if (typeof element.containerId === "string" && doomed.has(element.containerId)) {
      doomed.add(idOf(element));
    }
  }
  const result = elements.map((element) => {
    const id = idOf(element);
    if (doomed.has(id)) return bumpCanvasElement(element, { isDeleted: true });
    const start = bindingTarget(element.startBinding);
    const end = bindingTarget(element.endBinding);
    const unbind = {
      ...(start !== undefined && doomed.has(start) ? { startBinding: null } : {}),
      ...(end !== undefined && doomed.has(end) ? { endBinding: null } : {}),
      ...(typeof element.frameId === "string" && doomed.has(element.frameId)
        ? { frameId: null }
        : {}),
    };
    const bound = Array.isArray(element.boundElements)
      ? (element.boundElements as Array<{ id: string }>).filter((entry) => !doomed.has(entry.id))
      : null;
    const boundChanged =
      bound !== null && bound.length !== (element.boundElements as unknown[]).length;
    if (Object.keys(unbind).length === 0 && !boundChanged) return element;
    return bumpCanvasElement(element, {
      ...unbind,
      ...(boundChanged ? { boundElements: bound } : {}),
    });
  });
  return { elements: result, deletedIds: [...doomed] };
}

/**
 * Replaces elements by id with the renderer's versions (or appends new ones),
 * keeping each replaced element's version history moving forward.
 */
export function upsertCanvasElements(
  elements: ReadonlyArray<CanvasElement>,
  incoming: ReadonlyArray<CanvasElement>,
): CanvasElement[] {
  const current = new Map(elements.map((element) => [idOf(element), element]));
  const replaced = new Map<string, CanvasElement>();
  const added: CanvasElement[] = [];
  for (const element of incoming) {
    const before = current.get(idOf(element));
    if (before === undefined) {
      added.push(element);
      continue;
    }
    replaced.set(idOf(element), {
      ...element,
      version: Math.max(num(before.version), num(element.version)) + 1,
      versionNonce: randomNonce(),
      updated: Date.now(),
    });
  }
  return [...elements.map((element) => replaced.get(idOf(element)) ?? element), ...added];
}

/** Element ids that patches, skeletons, and bindings refer to but the scene lacks. */
export function unknownCanvasReferences(
  scene: Pick<CanvasScene, "elements">,
  skeletons: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const ids = new Set(live(scene.elements).map(idOf));
  for (const skeleton of skeletons) if (typeof skeleton.id === "string") ids.add(skeleton.id);
  const missing = new Set<string>();
  const check = (value: unknown) => {
    if (typeof value === "object" && value !== null && "id" in value) {
      const id = String((value as { id: unknown }).id);
      if (!ids.has(id)) missing.add(id);
    }
  };
  for (const skeleton of skeletons) {
    check(skeleton.start);
    check(skeleton.end);
    if (Array.isArray(skeleton.children)) {
      for (const child of skeleton.children)
        if (!ids.has(String(child))) missing.add(String(child));
    }
    if (typeof skeleton.frameId === "string" && !ids.has(skeleton.frameId)) {
      missing.add(skeleton.frameId);
    }
  }
  return [...missing];
}

/** The scene elements skeletons bind to, which the renderer needs to see. */
export function canvasBindingTargets(
  elements: ReadonlyArray<CanvasElement>,
  skeletons: ReadonlyArray<Record<string, unknown>>,
): CanvasElement[] {
  const wanted = new Set<string>();
  const note = (value: unknown) => {
    if (typeof value === "object" && value !== null && "id" in value) {
      wanted.add(String((value as { id: unknown }).id));
    }
  };
  for (const skeleton of skeletons) {
    note(skeleton.start);
    note(skeleton.end);
  }
  return live(elements).filter((element) => wanted.has(idOf(element)));
}

export interface ImageInfo {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Format and pixel size from an image's header: PNG, JPEG, GIF, WebP and SVG
 * (SVG size comes from its width/height or viewBox, when present).
 */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, Math.min(end, bytes.length)));
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47) {
    return { mimeType: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && ascii(0, 4).startsWith("GIF8")) {
    return {
      mimeType: "image/gif",
      width: view.getUint16(6, true),
      height: view.getUint16(8, true),
    };
  }
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const chunk = ascii(12, 16);
    if (chunk === "VP8X") {
      const uint24 = (at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
      return { mimeType: "image/webp", width: 1 + uint24(24), height: 1 + uint24(27) };
    }
    if (chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return {
        mimeType: "image/webp",
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === "VP8 ") {
      return {
        mimeType: "image/webp",
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
    return null;
  }
  if (bytes.length >= 4 && view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      // Start-of-frame markers carry the size; C4, C8 and CC are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return {
          mimeType: "image/jpeg",
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        };
      }
      offset += 2 + length;
    }
    return null;
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 4096));
  const svg = /<svg\b[^>]*>/iu.exec(head)?.[0];
  if (svg !== undefined) {
    const attr = (name: string) =>
      Number.parseFloat(new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)`, "iu").exec(svg)?.[1] ?? "");
    const viewBox = /\bviewBox\s*=\s*["']([^"']+)/iu
      .exec(svg)?.[1]
      ?.trim()
      .split(/[\s,]+/u)
      .map(Number);
    const width = attr("width") || viewBox?.[2] || 0;
    const height = attr("height") || viewBox?.[3] || 0;
    return { mimeType: "image/svg+xml", width: Math.round(width), height: Math.round(height) };
  }
  return null;
}

// Images under this size and within CANVAS_IMAGE_MAX_SIZE are stored as they are.
const MAX_STORED_IMAGE_BYTES = 1024 * 1024;

/**
 * Whether an image should be re-encoded before it is embedded. Canvas files
 * carry their images inline, so a 12-megapixel photo would make every save
 * and every client sync carry megabytes it never shows at that size. Vector
 * SVG and animated GIF keep their originals.
 */
export function shouldDownscaleImage(info: ImageInfo, byteLength: number): boolean {
  if (info.mimeType === "image/svg+xml" || info.mimeType === "image/gif") return false;
  return (
    Math.max(info.width, info.height) > CANVAS_IMAGE_MAX_SIZE || byteLength > MAX_STORED_IMAGE_BYTES
  );
}

/**
 * Where an image goes and how big it is drawn. Width or height alone keeps
 * the aspect ratio; neither draws it at its pixel size, capped at 800 units.
 */
export function placeCanvasImage(
  info: Pick<ImageInfo, "width" | "height">,
  input: {
    readonly x?: number | undefined;
    readonly y?: number | undefined;
    readonly width?: number | undefined;
    readonly height?: number | undefined;
  },
  fallback: { readonly x: number; readonly y: number },
): { x: number; y: number; width: number; height: number } {
  const aspect = info.width > 0 && info.height > 0 ? info.width / info.height : 1;
  let width = input.width;
  let height = input.height;
  if (width === undefined && height === undefined) {
    const longest = Math.min(800, Math.max(info.width, info.height) || 400);
    width = aspect >= 1 ? longest : longest * aspect;
    height = aspect >= 1 ? longest / aspect : longest;
  } else if (width === undefined) {
    width = height! * aspect;
  } else if (height === undefined) {
    height = width / aspect;
  }
  return { x: input.x ?? fallback.x, y: input.y ?? fallback.y, width, height: height! };
}
