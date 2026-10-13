/**
 * Canvas - Schemas for Excalidraw canvases.
 *
 * A project keeps its canvases as plain `.excalidraw` files in a folder of
 * its main checkout (`.canvases` unless the project sets `canvasFolder`), so
 * they are committed with the repository and open in excalidraw.com or the
 * VS Code extension. Any other `.excalidraw` file on the environment can be
 * opened by path too. The server owns reading, writing, merging and
 * watching; clients (web, desktop, and mobile over T3 Connect) only speak
 * these RPCs, and agents reach the same service through the `canvas_*` MCP
 * tools.
 *
 * Mobile hosts the editor in a WebView loading `CANVAS_HOST_PAGE_PATH` from
 * the environment it is connected to, so the editor version always matches
 * the server and the app bundles no Excalidraw code. The page talks to the
 * native side over `postMessage` with `CanvasHostMessage`; the native side
 * reads and saves through the RPCs below.
 *
 * @module Canvas
 */
import { Schema } from "effect";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Default library folder, relative to the project root. */
export const DEFAULT_CANVAS_FOLDER = ".canvases";

const isPlainRelativeFolder = (value: string) =>
  !/^([a-zA-Z]:)?[\\/]/u.test(value) &&
  !value.startsWith("~") &&
  value.split(/[\\/]/u).every((segment) => segment !== "..");

/** A folder inside the project, such as ".canvases" or "docs/diagrams". */
export const CanvasFolder = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (value) => isPlainRelativeFolder(value) || "The canvas folder must be inside the project.",
  ),
);
export type CanvasFolder = typeof CanvasFolder.Type;

/**
 * How the file is stored. `excalidraw` covers `.excalidraw` and
 * `.excalidraw.json`; the image formats carry a scene in their metadata and
 * open read-only.
 */
export const CanvasFormat = Schema.Literals(["excalidraw", "excalidraw-svg", "excalidraw-png"]);
export type CanvasFormat = typeof CanvasFormat.Type;

/**
 * A canvas is addressed by `path`, the absolute path on the environment.
 * Library canvases also carry their project and slug (file name without
 * extension) so tools and clients can name them briefly.
 */
export const CanvasSummary = Schema.Struct({
  path: TrimmedNonEmptyString,
  projectId: Schema.NullOr(ProjectId),
  slug: Schema.NullOr(TrimmedNonEmptyString),
  title: Schema.String,
  /** Relative to the project root for library canvases, else the absolute path. */
  displayPath: Schema.String,
  format: CanvasFormat,
  readOnly: Schema.Boolean,
  modifiedAt: Schema.String,
  elementCount: NonNegativeInt,
  imageCount: NonNegativeInt,
});
export type CanvasSummary = typeof CanvasSummary.Type;

/**
 * An Excalidraw scene as stored in the file. Elements and files stay opaque
 * records here: Excalidraw owns their shape and the server only reads the
 * fields it merges by (`id`, `version`, `versionNonce`, `isDeleted`).
 */
export const CanvasElement = Schema.Record(Schema.String, Schema.Unknown);
export type CanvasElement = typeof CanvasElement.Type;

export const CanvasBinaryFile = Schema.Struct({
  id: Schema.String,
  mimeType: Schema.String,
  dataURL: Schema.String,
  created: Schema.Number,
  lastRetrieved: Schema.optional(Schema.Number),
});
export type CanvasBinaryFile = typeof CanvasBinaryFile.Type;

export const CanvasScene = Schema.Struct({
  elements: Schema.Array(CanvasElement),
  appState: Schema.Record(Schema.String, Schema.Unknown),
  files: Schema.Record(Schema.String, CanvasBinaryFile),
});
export type CanvasScene = typeof CanvasScene.Type;

/**
 * A scene and the revision it was read at. `revision` is a hash of the
 * written file; it changes on every write, from any source.
 */
export const CanvasDocument = Schema.Struct({
  canvas: CanvasSummary,
  revision: Schema.String,
  scene: CanvasScene,
  /** Image files left out because the client said it already has them. */
  omittedFileIds: Schema.Array(Schema.String),
});
export type CanvasDocument = typeof CanvasDocument.Type;

/** A library canvas by slug, or any canvas file by path. */
export const CanvasRef = Schema.Union([
  Schema.Struct({ projectId: ProjectId, slug: TrimmedNonEmptyString }),
  Schema.Struct({
    /** Absolute, `~/`-relative, or relative to the project root when `projectId` is set. */
    path: TrimmedNonEmptyString,
    projectId: Schema.optional(ProjectId),
  }),
]);
export type CanvasRef = typeof CanvasRef.Type;

export const CanvasListInput = Schema.Struct({ projectId: ProjectId });
export type CanvasListInput = typeof CanvasListInput.Type;

export const CanvasListResult = Schema.Struct({
  folder: Schema.String,
  canvases: Schema.Array(CanvasSummary),
});
export type CanvasListResult = typeof CanvasListResult.Type;

export const CanvasReadInput = Schema.Struct({
  canvas: CanvasRef,
  /** Image files the client holds already; their data is not sent again. */
  knownFileIds: Schema.optional(Schema.Array(Schema.String)),
});
export type CanvasReadInput = typeof CanvasReadInput.Type;

/**
 * A client save. The server merges `elements` into the file by element
 * version, the way Excalidraw reconciles collaborators, so a save never
 * drops an agent's change made since `baseRevision`. `files` only needs the
 * images the file does not have yet.
 */
export const CanvasSaveInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  baseRevision: Schema.NullOr(Schema.String),
  elements: Schema.Array(CanvasElement),
  appState: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  files: Schema.optional(Schema.Record(Schema.String, CanvasBinaryFile)),
});
export type CanvasSaveInput = typeof CanvasSaveInput.Type;

export const CanvasSaveResult = Schema.Struct({
  canvas: CanvasSummary,
  revision: Schema.String,
  /** False when the merge left the file as it was. */
  written: Schema.Boolean,
  /** Present when other changes were merged in; the client applies it. */
  merged: Schema.optional(CanvasScene),
});
export type CanvasSaveResult = typeof CanvasSaveResult.Type;

export const CanvasCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** Where to create it instead of the library: absolute, `~/`, or project-relative. */
  path: Schema.optional(TrimmedNonEmptyString),
});
export type CanvasCreateInput = typeof CanvasCreateInput.Type;

export const CanvasRenameInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type CanvasRenameInput = typeof CanvasRenameInput.Type;

export const CanvasDeleteInput = Schema.Struct({ path: TrimmedNonEmptyString });
export type CanvasDeleteInput = typeof CanvasDeleteInput.Type;

/** A scene rectangle in canvas coordinates. */
export const CanvasRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number.check(Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isGreaterThan(0)),
});
export type CanvasRect = typeof CanvasRect.Type;

/** What a screenshot shows: everything, some elements, a rectangle, or one frame. */
export const CanvasCrop = Schema.Union([
  Schema.Struct({ type: Schema.Literal("full") }),
  Schema.Struct({ type: Schema.Literal("elements"), ids: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("rect"), rect: CanvasRect }),
  Schema.Struct({ type: Schema.Literal("frame"), frame: TrimmedNonEmptyString }),
]);
export type CanvasCrop = typeof CanvasCrop.Type;

export const CANVAS_SCREENSHOT_DEFAULT_SIZE = 1600;
export const CANVAS_SCREENSHOT_MAX_SIZE = 4096;

export const CanvasScreenshotOptions = Schema.Struct({
  crop: Schema.optional(CanvasCrop),
  /** Longest side of the PNG in pixels. Defaults to 1600; capped at 4096. */
  maxSize: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 64, maximum: 4096 }))),
  /** Explicit scale (output pixels per scene unit); overrides `maxSize`. */
  scale: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0.05, maximum: 8 }))),
  padding: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2000 }))),
  background: Schema.optional(Schema.Boolean),
  dark: Schema.optional(Schema.Boolean),
});
export type CanvasScreenshotOptions = typeof CanvasScreenshotOptions.Type;

export const CanvasScreenshotInput = Schema.Struct({
  ...CanvasScreenshotOptions.fields,
  canvas: CanvasRef,
});
export type CanvasScreenshotInput = typeof CanvasScreenshotInput.Type;

export const CanvasScreenshotResult = Schema.Struct({
  /** Base64 PNG. */
  png: Schema.String,
  width: NonNegativeInt,
  height: NonNegativeInt,
  /** The scene rectangle the image shows. */
  rect: CanvasRect,
});
export type CanvasScreenshotResult = typeof CanvasScreenshotResult.Type;

export const CanvasChangeSource = Schema.Literals(["agent", "client", "external"]);
export type CanvasChangeSource = typeof CanvasChangeSource.Type;

/**
 * Pushed to subscribers. `changed` tells an open editor to read the file
 * again; `focus` asks the thread's clients to show a canvas, the way preview
 * tools bring up the Browser panel.
 */
export const CanvasEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("library-changed"), projectId: ProjectId }),
  Schema.Struct({
    type: Schema.Literal("changed"),
    path: Schema.String,
    revision: Schema.String,
    source: CanvasChangeSource,
    threadId: Schema.optional(ThreadId),
    /** Elements an agent added or changed, for a brief highlight. */
    elementIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("focus"),
    threadId: ThreadId,
    canvas: CanvasSummary,
  }),
]);
export type CanvasEvent = typeof CanvasEvent.Type;

export const CanvasSubscribeInput = Schema.Struct({});

/**
 * Messages between the canvas host page (`CANVAS_HOST_PAGE_PATH`) and a
 * native WebView. Native sends `load` with a document and `update` when the
 * file changes; the page sends `ready` once, then `change` with the scene
 * after edits settle, which native saves with `canvas.save`.
 */
export const CANVAS_HOST_PAGE_PATH = "/canvas-host.html";

export const CanvasHostMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({
    type: Schema.Literal("load"),
    document: CanvasDocument,
    theme: Schema.Literals(["light", "dark"]),
  }),
  Schema.Struct({ type: Schema.Literal("update"), document: CanvasDocument }),
  Schema.Struct({
    type: Schema.Literal("change"),
    path: Schema.String,
    baseRevision: Schema.NullOr(Schema.String),
    elements: Schema.Array(CanvasElement),
    appState: Schema.Record(Schema.String, Schema.Unknown),
    files: Schema.Record(Schema.String, CanvasBinaryFile),
  }),
]);
export type CanvasHostMessage = typeof CanvasHostMessage.Type;

export class CanvasNotFoundError extends Schema.TaggedError<CanvasNotFoundError>()(
  "CanvasNotFoundError",
  { path: Schema.String },
) {
  override get message(): string {
    return `No canvas at ${this.path}.`;
  }
}

export class CanvasProjectNotFoundError extends Schema.TaggedError<CanvasProjectNotFoundError>()(
  "CanvasProjectNotFoundError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return `Project ${this.projectId} was not found.`;
  }
}

export class CanvasImageError extends Schema.TaggedError<CanvasImageError>()("CanvasImageError", {
  source: Schema.String,
  reason: Schema.Literals(["unreadable", "not-image", "too-large", "not-allowed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unreadable":
        return `Could not read the image at ${this.source}.`;
      case "not-image":
        return `${this.source} is not a PNG, JPEG, GIF, WebP or SVG image.`;
      case "too-large":
        return `${this.source} is larger than 25 MB.`;
      case "not-allowed":
        return `${this.source} is not an attachment of this thread.`;
    }
  }
}

export class CanvasInvalidPathError extends Schema.TaggedError<CanvasInvalidPathError>()(
  "CanvasInvalidPathError",
  {
    path: Schema.String,
    reason: Schema.Literals([
      "not-excalidraw",
      "read-only",
      "outside-library",
      "exists",
      "relative-path",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-excalidraw":
        return `${this.path} is not an Excalidraw file. Canvases end in .excalidraw or .excalidraw.json.`;
      case "read-only":
        return `${this.path} is an exported image and opens read-only.`;
      case "outside-library":
        return `${this.path} is not in a project's canvas folder.`;
      case "exists":
        return `A canvas already exists at ${this.path}.`;
      case "relative-path":
        return `${this.path} is relative; pass an absolute path or the project it belongs to.`;
    }
  }
}

export class CanvasInvalidFileError extends Schema.TaggedError<CanvasInvalidFileError>()(
  "CanvasInvalidFileError",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path} is not a valid Excalidraw scene.`;
  }
}

export class CanvasOperationError extends Schema.TaggedError<CanvasOperationError>()(
  "CanvasOperationError",
  {
    operation: Schema.Literals(["read", "write", "list", "rename", "delete", "fetch"]),
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the canvas at ${this.path}.`;
  }
}

export class CanvasRenderError extends Schema.TaggedError<CanvasRenderError>()(
  "CanvasRenderError",
  {
    reason: Schema.Literals([
      "browser-unavailable",
      "renderer-missing",
      "render-failed",
      "invalid",
    ]),
    /** For `invalid`: what Excalidraw rejected in the elements. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "browser-unavailable":
        return "T3's headless browser is not available, so canvases cannot be rendered here.";
      case "renderer-missing":
        return "The canvas renderer is missing from this build. Build the web app (vp run build in apps/web) and try again.";
      case "render-failed":
        return "The canvas could not be rendered.";
      case "invalid":
        return `Excalidraw rejected the elements: ${this.detail ?? "unknown error"}`;
    }
  }
}

export const CanvasError = Schema.Union([
  CanvasNotFoundError,
  CanvasProjectNotFoundError,
  CanvasImageError,
  CanvasInvalidPathError,
  CanvasInvalidFileError,
  CanvasOperationError,
  CanvasRenderError,
]);
export type CanvasError = typeof CanvasError.Type;
