// @effect-diagnostics nodeBuiltinImport:off - Effect has no sync digest for revisions and file ids.
/**
 * Project canvases: Excalidraw scenes stored as `.excalidraw` files. Each
 * project has a library folder (the `canvasFolder` project setting, default
 * `.canvases`) in its main checkout, committed with the repository; any other
 * `.excalidraw` file on this machine opens by path too.
 *
 * Saves merge by element version against what is on disk, so the editor, the
 * agent and a text editor can all change a canvas at once. The service
 * watches the folders of canvases it has read and reports changes made
 * outside T3 as events.
 */
import {
  CanvasImageError,
  CanvasInvalidFileError,
  CanvasInvalidPathError,
  CanvasNotFoundError,
  CanvasOperationError,
  CanvasProjectNotFoundError,
  CanvasRenderError,
  type CanvasBinaryFile,
  type CanvasChangeSource,
  type CanvasCreateInput,
  type CanvasDocument,
  type CanvasElement,
  type CanvasEvent,
  type CanvasListResult,
  type CanvasReadInput,
  type CanvasRef,
  type CanvasSaveInput,
  type CanvasSaveResult,
  type CanvasScene,
  type CanvasScreenshotInput,
  type CanvasScreenshotResult,
  type CanvasSummary,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  CANVAS_FILE_EXTENSION,
  CANVAS_IMAGE_MAX_SIZE,
  CanvasCropError,
  canvasBaseName,
  canvasCropRect,
  canvasElementBounds,
  canvasExportScale,
  canvasFormatForPath,
  canvasSceneCounts,
  canvasSlug,
  canvasTitle,
  emptyCanvasScene,
  mergeCanvasElements,
  parseCanvasScene,
  serializeCanvasScene,
  unionCanvasRects,
} from "@t3tools/shared/canvas";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "node:crypto";

import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../os-jank.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CanvasRenderer from "./CanvasRenderer.ts";
import {
  CanvasPatchError,
  applyCanvasPatches,
  bumpCanvasElement,
  canvasBindingTargets,
  deleteCanvasElements,
  placeCanvasImage,
  readImageInfo,
  shouldDownscaleImage,
  summarizeCanvasElements,
  unknownCanvasReferences,
  upsertCanvasElements,
  type CanvasElementPatch,
  type CanvasElementSummary,
} from "./canvasElements.ts";
import { embeddedSceneFromPng, embeddedSceneFromSvg } from "./canvasEmbedded.ts";

/** Agent operations can also find the thread has no canvas yet. */
type CanvasAgentFailure = CanvasFailure | CanvasNoCurrentError;

type CanvasFailure =
  | CanvasNotFoundError
  | CanvasProjectNotFoundError
  | CanvasInvalidPathError
  | CanvasInvalidFileError
  | CanvasOperationError;

/** How an agent names a canvas: a library slug or a path. */
export interface CanvasThreadContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

export interface CanvasUpdateInput {
  readonly canvas?: string | undefined;
  /** Excalidraw element skeletons, as `convertToExcalidrawElements` takes them. */
  readonly add?: ReadonlyArray<Record<string, unknown>> | undefined;
  readonly update?: ReadonlyArray<CanvasElementPatch> | undefined;
  readonly delete?: ReadonlyArray<string> | undefined;
}

export interface CanvasUpdateResult {
  readonly canvas: CanvasSummary;
  readonly revision: string;
  readonly createdIds: ReadonlyArray<string>;
  readonly updatedIds: ReadonlyArray<string>;
  readonly deletedIds: ReadonlyArray<string>;
}

export type CanvasImageSource =
  | { readonly path: string }
  | { readonly url: string }
  | { readonly attachmentId: string };

export interface CanvasAddImageInput {
  readonly canvas?: string | undefined;
  readonly source: CanvasImageSource;
  readonly id?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** A frame name or id to place the image in. */
  readonly frame?: string | undefined;
}

export interface CanvasReadSummary {
  readonly canvas: CanvasSummary;
  readonly revision: string;
  readonly elements: ReadonlyArray<CanvasElementSummary>;
}

export interface CanvasReadFull {
  readonly canvas: CanvasSummary;
  readonly revision: string;
  readonly elements: ReadonlyArray<CanvasElement>;
  readonly omittedImages: ReadonlyArray<string>;
}

/** Full element JSON is refused past this many characters; pass ids instead. */
const CANVAS_FULL_READ_MAX_CHARS = 200_000;

/** An agent tool named no canvas and the thread has not used one yet. */
export class CanvasNoCurrentError extends Schema.TaggedError<CanvasNoCurrentError>()(
  "CanvasNoCurrentError",
  {},
) {
  override get message(): string {
    return "No canvas is open in this thread. Pass canvas, or call canvas_list.";
  }
}

export class CanvasTooLargeError extends Schema.TaggedError<CanvasTooLargeError>()(
  "CanvasTooLargeError",
  { path: Schema.String },
) {
  override get message(): string {
    return `${this.path} is too large to read in full. Read the summary, or pass ids.`;
  }
}

export class CanvasService extends Context.Service<
  CanvasService,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<CanvasListResult, CanvasFailure>;
    readonly read: (input: CanvasReadInput) => Effect.Effect<CanvasDocument, CanvasFailure>;
    /** Saves a client's edit, merging with whatever changed on disk since `baseRevision`. */
    readonly save: (
      input: CanvasSaveInput,
    ) => Effect.Effect<CanvasSaveResult, CanvasFailure | CanvasInvalidPathError>;
    readonly create: (input: CanvasCreateInput) => Effect.Effect<CanvasDocument, CanvasFailure>;
    readonly rename: (input: {
      readonly path: string;
      readonly title: string;
    }) => Effect.Effect<CanvasSummary, CanvasFailure>;
    readonly delete: (input: { readonly path: string }) => Effect.Effect<void, CanvasFailure>;
    readonly screenshot: (
      input: CanvasScreenshotInput,
    ) => Effect.Effect<
      CanvasScreenshotResult,
      CanvasFailure | CanvasRenderError | CanvasRenderer.CanvasBrowserError
    >;
    /** Changes to canvases and libraries, and agents asking clients to show a canvas. */
    readonly events: Stream.Stream<CanvasEvent>;

    // Agent operations. `canvas` is a library slug or a path; without one
    // they use the canvas the thread last opened, created, or changed.
    readonly agentList: (
      context: CanvasThreadContext,
    ) => Effect.Effect<CanvasListResult & { readonly current: string | null }, CanvasFailure>;
    readonly agentCreate: (
      context: CanvasThreadContext,
      input: { readonly title: string; readonly path?: string | undefined },
    ) => Effect.Effect<CanvasSummary, CanvasFailure>;
    /** Makes the canvas the thread's current one and shows it to the user. */
    readonly agentOpen: (
      context: CanvasThreadContext,
      canvas: string,
    ) => Effect.Effect<CanvasSummary, CanvasFailure>;
    readonly agentRead: (
      context: CanvasThreadContext,
      input: {
        readonly canvas?: string | undefined;
        readonly full?: boolean | undefined;
        readonly ids?: ReadonlyArray<string> | undefined;
      },
    ) => Effect.Effect<
      CanvasReadSummary | CanvasReadFull,
      CanvasAgentFailure | CanvasTooLargeError
    >;
    readonly agentUpdate: (
      context: CanvasThreadContext,
      input: CanvasUpdateInput,
    ) => Effect.Effect<
      CanvasUpdateResult,
      CanvasAgentFailure | CanvasRenderError | CanvasRenderer.CanvasBrowserError
    >;
    readonly agentAddImage: (
      context: CanvasThreadContext,
      input: CanvasAddImageInput,
    ) => Effect.Effect<
      CanvasUpdateResult,
      CanvasAgentFailure | CanvasImageError | CanvasRenderError | CanvasRenderer.CanvasBrowserError
    >;
    readonly agentScreenshot: (
      context: CanvasThreadContext,
      input: Omit<CanvasScreenshotInput, "canvas"> & { readonly canvas?: string | undefined },
    ) => Effect.Effect<
      CanvasScreenshotResult & { readonly canvas: CanvasSummary },
      CanvasAgentFailure | CanvasRenderError | CanvasRenderer.CanvasBrowserError
    >;
  }
>()("t3/canvas/CanvasService") {}

interface Stored {
  readonly text: string;
  readonly revision: string;
  readonly scene: CanvasScene;
  readonly modifiedAt: string;
}

interface Resolved {
  readonly path: string;
  readonly projectId: ProjectId | null;
  readonly slug: string | null;
  readonly format: NonNullable<ReturnType<typeof canvasFormatForPath>>;
}

// Revisions of a canvas kept as merge bases for saves that started from them.
const MERGE_BASES_PER_CANVAS = 8;
const MAX_WATCHED_FOLDERS = 64;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const WATCH_DEBOUNCE = Duration.millis(150);

const revisionOf = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const randomId = () => {
  const bytes = NodeCrypto.randomBytes(20);
  return Array.from(bytes, (byte) => BASE62[byte % 62]).join("");
};

/**
 * Fractional indexes for elements appended after `last`. Excalidraw orders
 * elements by these keys; appending a base-62 digit after the highest key
 * sorts above it, and a key it finds invalid is regenerated on load.
 */
const indexesAfter = (last: string, count: number) =>
  Array.from(
    { length: count },
    (_, index) => `${last}${"z".repeat(Math.floor(index / 30))}${BASE62[31 + (index % 30)]}`,
  );

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const renderer = yield* CanvasRenderer.CanvasRenderer;
  const httpClient = yield* HttpClient.HttpClient;
  const pathServices = yield* Effect.context<Path.Path>();
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const expandHome = (input: string) =>
    expandHomePath(input).pipe(
      Effect.provideContext(pathServices),
      Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
    );

  const events = yield* PubSub.unbounded<CanvasEvent>();
  const writes = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  /** The revision last read or written for each canvas, to tell external edits apart. */
  const known = new Map<string, string>();
  const mergeBases = new Map<string, Map<string, ReadonlyArray<CanvasElement>>>();
  /** Library folder → project, for library-changed events. */
  const libraries = new Map<string, ProjectId>();
  const watched = new Set<string>();
  const currentByThread = new Map<ThreadId, string>();
  const summaryCache = new Map<string, { readonly key: string; readonly summary: CanvasSummary }>();

  /** Missing files are `CanvasNotFoundError`; anything else failed `operation`. */
  const fileError =
    (operation: CanvasOperationError["operation"], at: string) =>
    (error: PlatformError.PlatformError) =>
      error.reason._tag === "NotFound"
        ? new CanvasNotFoundError({ path: at })
        : new CanvasOperationError({ operation, path: at, cause: error });

  const modifiedAtOf = (mtime: Option.Option<Date>) =>
    Option.match(mtime, {
      onNone: () => "1970-01-01T00:00:00.000Z",
      onSome: (date) => date.toISOString(),
    });

  const publish = (event: CanvasEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const operationError =
    (operation: CanvasOperationError["operation"], at: string) => (cause: unknown) =>
      new CanvasOperationError({ operation, path: at, cause });

  const rememberBase = (
    canvasPath: string,
    revision: string,
    elements: ReadonlyArray<CanvasElement>,
  ) => {
    const bases = mergeBases.get(canvasPath) ?? new Map<string, ReadonlyArray<CanvasElement>>();
    bases.delete(revision);
    bases.set(revision, elements);
    while (bases.size > MERGE_BASES_PER_CANVAS) bases.delete(bases.keys().next().value!);
    mergeBases.set(canvasPath, bases);
  };

  // Project roots and library folders.

  const projectRoot = Effect.fn("CanvasService.projectRoot")(function* (projectId: ProjectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.mapError(operationError("read", projectId)));
    if (Option.isNone(project)) return yield* new CanvasProjectNotFoundError({ projectId });
    return project.value;
  });

  const libraryOf = Effect.fn("CanvasService.libraryOf")(function* (projectId: ProjectId) {
    const project = yield* projectRoot(projectId);
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(operationError("read", project.workspaceRoot)),
    );
    const projectFile = yield* projectFiles.load(project.workspaceRoot);
    const folder = resolveProjectSettings(
      settings,
      projectId,
      project,
      Option.getOrNull(projectFile),
    ).settings.canvasFolder;
    const dir = path.resolve(project.workspaceRoot, folder);
    libraries.set(dir, projectId);
    return { root: project.workspaceRoot, folder, dir };
  });

  // Path resolution.

  const resolveRef = Effect.fn("CanvasService.resolveRef")(function* (ref: CanvasRef) {
    if ("slug" in ref) {
      const library = yield* libraryOf(ref.projectId);
      const base = path.join(library.dir, ref.slug);
      const json = `${base}${CANVAS_FILE_EXTENSION}.json`;
      const exists = yield* fileSystem.exists(json).pipe(Effect.orElseSucceed(() => false));
      const file = exists ? json : `${base}${CANVAS_FILE_EXTENSION}`;
      if (path.dirname(file) !== library.dir) {
        return yield* new CanvasInvalidPathError({ path: ref.slug, reason: "outside-library" });
      }
      return {
        path: file,
        projectId: ref.projectId,
        slug: canvasBaseName(file),
        format: "excalidraw",
      } satisfies Resolved;
    }
    const expanded = yield* expandHome(ref.path);
    let absolute = expanded;
    let library: { readonly dir: string } | null = null;
    if (ref.projectId !== undefined) library = yield* libraryOf(ref.projectId);
    if (!path.isAbsolute(expanded)) {
      if (ref.projectId === undefined) {
        return yield* new CanvasInvalidPathError({ path: ref.path, reason: "relative-path" });
      }
      absolute = path.resolve((yield* projectRoot(ref.projectId)).workspaceRoot, expanded);
    }
    absolute = path.resolve(absolute);
    const format = canvasFormatForPath(absolute);
    if (format === null) {
      return yield* new CanvasInvalidPathError({ path: ref.path, reason: "not-excalidraw" });
    }
    const dir = path.dirname(absolute);
    const projectId = library?.dir === dir ? ref.projectId! : (libraries.get(dir) ?? null);
    return {
      path: absolute,
      projectId,
      slug: projectId !== null && format === "excalidraw" ? canvasBaseName(absolute) : null,
      format,
    } satisfies Resolved;
  });

  /** A slug, a project-relative path, `~/…`, or an absolute path. */
  const refFor = (projectId: ProjectId, canvas: string): CanvasRef =>
    /[\\/]/u.test(canvas) || canvasFormatForPath(canvas) !== null
      ? { path: canvas, projectId }
      : { projectId, slug: canvas };

  const requireWritable = (resolved: Resolved) =>
    resolved.format === "excalidraw"
      ? Effect.void
      : Effect.fail(new CanvasInvalidPathError({ path: resolved.path, reason: "read-only" }));

  // Reading and writing files.

  const readStored = Effect.fn("CanvasService.readStored")(function* (resolved: Resolved) {
    const info = yield* fileSystem
      .stat(resolved.path)
      .pipe(Effect.mapError(fileError("read", resolved.path)));
    let text: string | null;
    if (resolved.format === "excalidraw-png") {
      const bytes = yield* fileSystem
        .readFile(resolved.path)
        .pipe(Effect.mapError(operationError("read", resolved.path)));
      text = embeddedSceneFromPng(bytes);
    } else {
      const raw = yield* fileSystem
        .readFileString(resolved.path)
        .pipe(Effect.mapError(operationError("read", resolved.path)));
      text = resolved.format === "excalidraw-svg" ? embeddedSceneFromSvg(raw) : raw;
    }
    const scene = text === null ? null : parseCanvasScene(text);
    if (text === null || scene === null) {
      return yield* new CanvasInvalidFileError({ path: resolved.path });
    }
    const revision = revisionOf(text);
    known.set(resolved.path, revision);
    rememberBase(resolved.path, revision, scene.elements);
    yield* watchFolder(path.dirname(resolved.path));
    return {
      text,
      revision,
      scene,
      modifiedAt: modifiedAtOf(info.mtime),
    } satisfies Stored;
  });

  const readIfExists = (resolved: Resolved) =>
    readStored(resolved).pipe(
      Effect.asSome,
      Effect.catchTags({ CanvasNotFoundError: () => Effect.succeed(Option.none<Stored>()) }),
    );

  const writeText = Effect.fn("CanvasService.writeText")(function* (target: string, text: string) {
    const dir = path.dirname(target);
    const temp = path.join(dir, `.${path.basename(target)}.${randomId()}.tmp`);
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(dir, { recursive: true });
      yield* fileSystem.writeFileString(temp, text);
      yield* fileSystem.rename(temp, target);
    }).pipe(
      Effect.tapError(() => fileSystem.remove(temp).pipe(Effect.ignore)),
      Effect.mapError(operationError("write", target)),
    );
    const revision = revisionOf(text);
    known.set(target, revision);
    yield* watchFolder(dir);
    return revision;
  });

  const summaryOf = (resolved: Resolved, stored: Stored): CanvasSummary => {
    const counts = canvasSceneCounts(stored.scene);
    return {
      path: resolved.path,
      projectId: resolved.projectId,
      slug: resolved.slug,
      title: canvasTitle(stored.scene, resolved.path),
      displayPath: displayPathFor(resolved.path),
      format: resolved.format,
      readOnly: resolved.format !== "excalidraw",
      modifiedAt: stored.modifiedAt,
      ...counts,
    };
  };

  const displayPathFor = (absolute: string) => {
    for (const [dir] of libraries) {
      const root = path.dirname(dir);
      if (absolute.startsWith(`${root}${path.sep}`)) return path.relative(root, absolute);
    }
    return absolute;
  };

  /**
   * Writes a new scene for a canvas unless it serializes to the bytes already
   * there, and tells clients. Callers hold the write permit.
   */
  const commit = Effect.fn("CanvasService.commit")(function* (
    resolved: Resolved,
    previous: Stored | null,
    scene: CanvasScene,
    origin: {
      readonly source: CanvasChangeSource;
      readonly threadId?: ThreadId | undefined;
      readonly elementIds?: ReadonlyArray<string> | undefined;
    },
  ) {
    const text = serializeCanvasScene(scene);
    if (previous !== null && text === previous.text) {
      return { stored: previous, written: false };
    }
    const revision = yield* writeText(resolved.path, text);
    const stored: Stored = {
      text,
      revision,
      scene: parseCanvasScene(text)!,
      modifiedAt: DateTime.formatIso(yield* DateTime.now),
    };
    rememberBase(resolved.path, revision, stored.scene.elements);
    yield* publish({
      type: "changed",
      path: resolved.path,
      revision,
      source: origin.source,
      ...(origin.threadId === undefined ? {} : { threadId: origin.threadId }),
      ...(origin.elementIds === undefined ? {} : { elementIds: [...origin.elementIds] }),
    });
    if (resolved.projectId !== null && previous === null) {
      yield* publish({ type: "library-changed", projectId: resolved.projectId });
    }
    return { stored, written: true };
  });

  // Watching for edits made outside T3.

  const onFolderChange = Effect.fn("CanvasService.onFolderChange")(function* (dir: string) {
    const projectId = libraries.get(dir);
    if (projectId !== undefined) yield* publish({ type: "library-changed", projectId });
    for (const [canvasPath, revision] of known) {
      if (path.dirname(canvasPath) !== dir) continue;
      const format = canvasFormatForPath(canvasPath);
      if (format === null) continue;
      const stored = yield* readStored({
        path: canvasPath,
        projectId: null,
        slug: null,
        format,
      }).pipe(Effect.option);
      if (Option.isNone(stored)) {
        known.delete(canvasPath);
        continue;
      }
      if (stored.value.revision !== revision) {
        yield* publish({
          type: "changed",
          path: canvasPath,
          revision: stored.value.revision,
          source: "external",
        });
      }
    }
  });

  function watchFolder(dir: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (watched.has(dir) || watched.size >= MAX_WATCHED_FOLDERS) return Effect.void;
      watched.add(dir);
      return fileSystem.watch(dir).pipe(
        // T3's own temp files come and go on every save.
        Stream.filter((event) => !event.path.endsWith(".tmp")),
        Stream.debounce(WATCH_DEBOUNCE),
        Stream.runForEach(() => writes.withPermits(1)(onFolderChange(dir)).pipe(Effect.ignore)),
        Effect.ensuring(Effect.sync(() => watched.delete(dir))),
        Effect.ignoreCause({ log: false }),
        Effect.forkIn(watcherScope),
        Effect.asVoid,
      );
    });
  }

  // Client operations.

  const list: CanvasService["Service"]["list"] = Effect.fn("CanvasService.list")(
    function* (projectId) {
      const library = yield* libraryOf(projectId);
      const names = yield* fileSystem.readDirectory(library.dir).pipe(
        Effect.mapError(fileError("list", library.dir)),
        Effect.catchTags({
          CanvasNotFoundError: () => Effect.succeed<ReadonlyArray<string>>([]),
        }),
      );
      if (names.length > 0) yield* watchFolder(library.dir);
      const canvases: CanvasSummary[] = [];
      for (const name of names) {
        if (canvasFormatForPath(name) !== "excalidraw") continue;
        const file = path.join(library.dir, name);
        const resolved: Resolved = {
          path: file,
          projectId,
          slug: canvasBaseName(file),
          format: "excalidraw",
        };
        const info = yield* fileSystem.stat(file).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") continue;
        const key = `${modifiedAtOf(info.value.mtime)}:${info.value.size}`;
        const cached = summaryCache.get(file);
        if (cached?.key === key) {
          canvases.push(cached.summary);
          continue;
        }
        const stored = yield* readStored(resolved).pipe(Effect.option);
        if (Option.isNone(stored)) continue;
        const summary = summaryOf(resolved, stored.value);
        summaryCache.set(file, { key, summary });
        canvases.push(summary);
      }
      canvases.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
      return { folder: library.folder, canvases };
    },
  );

  const documentFor = (
    resolved: Resolved,
    stored: Stored,
    knownFileIds: ReadonlyArray<string> = [],
  ): CanvasDocument => {
    const skip = new Set(knownFileIds);
    const files: Record<string, CanvasBinaryFile> = {};
    const omittedFileIds: string[] = [];
    for (const [id, file] of Object.entries(stored.scene.files)) {
      if (skip.has(id)) omittedFileIds.push(id);
      else files[id] = file;
    }
    return {
      canvas: summaryOf(resolved, stored),
      revision: stored.revision,
      scene: { ...stored.scene, files },
      omittedFileIds,
    };
  };

  const read: CanvasService["Service"]["read"] = Effect.fn("CanvasService.read")(function* (input) {
    const resolved = yield* resolveRef(input.canvas);
    const stored = yield* readStored(resolved);
    return documentFor(resolved, stored, input.knownFileIds);
  });

  const save: CanvasService["Service"]["save"] = Effect.fn("CanvasService.save")(function* (input) {
    const resolved = yield* resolveRef({ path: input.path });
    yield* requireWritable(resolved);
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const current = Option.getOrNull(yield* readIfExists(resolved));
        const base =
          input.baseRevision === null
            ? null
            : (mergeBases.get(resolved.path)?.get(input.baseRevision) ?? null);
        const upToDate = current === null || current.revision === input.baseRevision;
        const elements = upToDate
          ? [...input.elements]
          : mergeCanvasElements({ base, local: input.elements, remote: current.scene.elements });
        const scene: CanvasScene = {
          elements,
          appState: input.appState ?? current?.scene.appState ?? {},
          files: { ...current?.scene.files, ...input.files },
        };
        const { stored, written } = yield* commit(resolved, current, scene, { source: "client" });
        return {
          canvas: summaryOf(resolved, stored),
          revision: stored.revision,
          written,
          ...(upToDate ? {} : { merged: stored.scene }),
        };
      }),
    );
  });

  const uniqueLibraryPath = Effect.fn("CanvasService.uniqueLibraryPath")(function* (
    dir: string,
    title: string,
  ) {
    const slug = canvasSlug(title);
    for (let attempt = 1; ; attempt += 1) {
      const candidate = path.join(
        dir,
        `${attempt === 1 ? slug : `${slug}-${attempt}`}${CANVAS_FILE_EXTENSION}`,
      );
      const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return candidate;
    }
  });

  const create: CanvasService["Service"]["create"] = Effect.fn("CanvasService.create")(
    function* (input) {
      const library = yield* libraryOf(input.projectId);
      const resolved: Resolved =
        input.path === undefined
          ? yield* Effect.map(uniqueLibraryPath(library.dir, input.title), (file) => ({
              path: file,
              projectId: input.projectId,
              slug: canvasBaseName(file),
              format: "excalidraw" as const,
            }))
          : yield* resolveRef({ path: input.path, projectId: input.projectId });
      yield* requireWritable(resolved);
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const exists = yield* fileSystem
            .exists(resolved.path)
            .pipe(Effect.orElseSucceed(() => false));
          if (exists) {
            return yield* new CanvasInvalidPathError({ path: resolved.path, reason: "exists" });
          }
          const { stored } = yield* commit(resolved, null, emptyCanvasScene(input.title), {
            source: "client",
          });
          return documentFor(resolved, stored);
        }),
      );
    },
  );

  const rename: CanvasService["Service"]["rename"] = Effect.fn("CanvasService.rename")(
    function* (input) {
      const resolved = yield* resolveRef({ path: input.path });
      yield* requireWritable(resolved);
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const stored = yield* readStored(resolved);
          const scene = {
            ...stored.scene,
            appState: { ...stored.scene.appState, name: input.title },
          };
          // Library canvases also move to a file named after the new title.
          let target = resolved;
          if (resolved.projectId !== null && canvasSlug(input.title) !== resolved.slug) {
            const file = yield* uniqueLibraryPath(path.dirname(resolved.path), input.title);
            target = { ...resolved, path: file, slug: canvasBaseName(file) };
          }
          const { stored: next } = yield* commit(
            target,
            target === resolved ? stored : null,
            scene,
            {
              source: "client",
            },
          );
          if (target !== resolved) {
            yield* fileSystem
              .remove(resolved.path)
              .pipe(Effect.mapError(operationError("rename", resolved.path)));
            known.delete(resolved.path);
            for (const [threadId, canvasPath] of currentByThread) {
              if (canvasPath === resolved.path) currentByThread.set(threadId, target.path);
            }
          }
          return summaryOf(target, next);
        }),
      );
    },
  );

  const deleteCanvas: CanvasService["Service"]["delete"] = Effect.fn("CanvasService.delete")(
    function* (input) {
      const resolved = yield* resolveRef({ path: input.path });
      // Only library canvases are deleted from T3; other files belong to the user.
      if (resolved.projectId === null) {
        return yield* new CanvasInvalidPathError({ path: input.path, reason: "outside-library" });
      }
      yield* writes.withPermits(1)(
        fileSystem.remove(resolved.path).pipe(Effect.mapError(fileError("delete", resolved.path))),
      );
      known.delete(resolved.path);
      summaryCache.delete(resolved.path);
      yield* publish({ type: "library-changed", projectId: resolved.projectId });
    },
  );

  const shoot = Effect.fn("CanvasService.shoot")(function* (
    stored: Stored,
    input: Omit<CanvasScreenshotInput, "canvas">,
  ) {
    const rect = yield* Effect.try({
      try: () =>
        canvasCropRect(stored.scene.elements, input.crop ?? { type: "full" }, input.padding),
      catch: (error) =>
        new CanvasRenderError({
          reason: "invalid",
          detail: error instanceof CanvasCropError ? error.message : "the crop is not valid",
        }),
    });
    const scale = canvasExportScale(rect, { scale: input.scale, maxSize: input.maxSize });
    const image = yield* renderer.render({
      scene: stored.scene,
      rect,
      scale,
      background: input.background ?? true,
      dark: input.dark ?? false,
    });
    return { ...image, rect };
  });

  const screenshot: CanvasService["Service"]["screenshot"] = Effect.fn("CanvasService.screenshot")(
    function* (input) {
      const resolved = yield* resolveRef(input.canvas);
      return yield* shoot(yield* readStored(resolved), input);
    },
  );

  // Agent operations.

  const agentTarget = Effect.fn("CanvasService.agentTarget")(function* (
    context: CanvasThreadContext,
    canvas: string | undefined,
  ) {
    if (canvas !== undefined) return yield* resolveRef(refFor(context.projectId, canvas));
    const current = currentByThread.get(context.threadId);
    if (current === undefined) {
      return yield* new CanvasNoCurrentError();
    }
    return yield* resolveRef({ path: current, projectId: context.projectId });
  });

  const agentList: CanvasService["Service"]["agentList"] = (context) =>
    Effect.map(list(context.projectId), (result) => ({
      ...result,
      current: currentByThread.get(context.threadId) ?? null,
    }));

  const agentCreate: CanvasService["Service"]["agentCreate"] = Effect.fn(
    "CanvasService.agentCreate",
  )(function* (context, input) {
    const document = yield* create({ projectId: context.projectId, ...input });
    currentByThread.set(context.threadId, document.canvas.path);
    return document.canvas;
  });

  const agentOpen: CanvasService["Service"]["agentOpen"] = Effect.fn("CanvasService.agentOpen")(
    function* (context, canvas) {
      const resolved = yield* resolveRef(refFor(context.projectId, canvas));
      const summary = summaryOf(resolved, yield* readStored(resolved));
      currentByThread.set(context.threadId, resolved.path);
      yield* publish({ type: "focus", threadId: context.threadId, canvas: summary });
      return summary;
    },
  );

  const agentRead: CanvasService["Service"]["agentRead"] = Effect.fn("CanvasService.agentRead")(
    function* (context, input) {
      const resolved = yield* agentTarget(context, input.canvas);
      const stored = yield* readStored(resolved);
      currentByThread.set(context.threadId, resolved.path);
      const canvas = summaryOf(resolved, stored);
      const ids = input.ids === undefined ? null : new Set(input.ids);
      const live = stored.scene.elements.filter(
        (element) =>
          element.isDeleted !== true &&
          (ids === null ||
            ids.has(element.id as string) ||
            (typeof element.containerId === "string" && ids.has(element.containerId))),
      );
      if (input.full !== true) {
        return { canvas, revision: stored.revision, elements: summarizeCanvasElements(live) };
      }
      // @effect-diagnostics-next-line preferSchemaOverJson:off - only measures the size.
      const size = JSON.stringify(live).length;
      if (size > CANVAS_FULL_READ_MAX_CHARS) {
        return yield* new CanvasTooLargeError({ path: resolved.path });
      }
      return {
        canvas,
        revision: stored.revision,
        elements: live,
        omittedImages: Object.keys(stored.scene.files),
      };
    },
  );

  /** Turns skeletons (and relabels) into elements and appends them in order. */
  const addConverted = Effect.fn("CanvasService.addConverted")(function* (
    elements: ReadonlyArray<CanvasElement>,
    skeletons: ReadonlyArray<Record<string, unknown>>,
  ) {
    if (skeletons.length === 0) return { elements: [...elements], createdIds: [] as string[] };
    const before = new Set(elements.map((element) => element.id as string));
    const converted = yield* renderer.convert({
      skeletons,
      existing: canvasBindingTargets(elements, skeletons),
    });
    const created = converted.filter((element) => !before.has(element.id as string));
    // Frames list existing elements as children; those join the frame here,
    // since the renderer only sees the elements it was given.
    const joins = new Map<string, string>();
    for (const skeleton of skeletons) {
      if (skeleton.type !== "frame" || !Array.isArray(skeleton.children)) continue;
      for (const child of skeleton.children) {
        if (before.has(String(child))) joins.set(String(child), skeleton.id as string);
      }
    }
    const indexes = elements
      .map((element) => element.index)
      .filter((index): index is string => typeof index === "string")
      .toSorted();
    const last = indexes.at(-1);
    const fresh = last === undefined ? [] : indexesAfter(last, created.length);
    const createdWithIndex = created.map((element, position) => {
      const { index: _index, ...rest } = element;
      return last === undefined ? rest : { ...rest, index: fresh[position] };
    });
    const updated = converted.filter((element) => before.has(element.id as string));
    let next = upsertCanvasElements(elements, [...updated, ...createdWithIndex]);
    if (joins.size > 0) {
      next = next.map((element) =>
        joins.has(element.id as string)
          ? bumpCanvasElement(element, { frameId: joins.get(element.id as string) })
          : element,
      );
    }
    return { elements: next, createdIds: created.map((element) => element.id as string) };
  });

  const asInvalid = (error: CanvasPatchError) =>
    new CanvasRenderError({ reason: "invalid", detail: error.message });

  const agentUpdate: CanvasService["Service"]["agentUpdate"] = Effect.fn(
    "CanvasService.agentUpdate",
  )(function* (context, input) {
    const resolved = yield* agentTarget(context, input.canvas);
    yield* requireWritable(resolved);
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* readStored(resolved);
        let elements: ReadonlyArray<CanvasElement> = stored.scene.elements;
        let deletedIds: ReadonlyArray<string> = [];
        if (input.delete !== undefined && input.delete.length > 0) {
          const result = yield* Effect.try({
            try: () => deleteCanvasElements(elements, input.delete!),
            catch: (error) => asInvalid(error as CanvasPatchError),
          });
          elements = result.elements;
          deletedIds = result.deletedIds;
        }
        let updatedIds: ReadonlyArray<string> = [];
        const relabelSkeletons: Array<Record<string, unknown>> = [];
        if (input.update !== undefined && input.update.length > 0) {
          const patched = yield* Effect.try({
            try: () => applyCanvasPatches(elements, input.update!),
            catch: (error) =>
              error instanceof CanvasPatchError
                ? asInvalid(error)
                : new CanvasRenderError({ reason: "invalid", detail: "the patch is not valid" }),
          });
          elements = patched.elements;
          updatedIds = patched.changedIds;
          if (patched.remeasure.length > 0) {
            const ids = new Set(patched.remeasure);
            const remeasured = yield* renderer.normalize(
              elements.filter((element) => ids.has(element.id as string)),
            );
            elements = elements.map(
              (element) => remeasured.find((candidate) => candidate.id === element.id) ?? element,
            );
          }
          // A new label replaces the old text element; the renderer rebuilds
          // the container with Excalidraw's own wrapping and centring.
          for (const { id, text } of patched.relabels) {
            const container = elements.find((element) => element.id === id)!;
            const oldLabel = elements.find(
              (element) => element.containerId === id && element.isDeleted !== true,
            );
            if (oldLabel !== undefined) {
              elements = deleteCanvasElements(elements, [oldLabel.id as string]).elements;
            }
            const current = elements.find((element) => element.id === id)!;
            relabelSkeletons.push({
              ...current,
              boundElements: (Array.isArray(current.boundElements)
                ? current.boundElements
                : []
              ).filter((entry: { id: string }) => entry.id !== oldLabel?.id),
              label: {
                text,
                ...(oldLabel === undefined
                  ? {}
                  : {
                      fontSize: oldLabel.fontSize,
                      fontFamily: oldLabel.fontFamily,
                      strokeColor: oldLabel.strokeColor,
                      textAlign: oldLabel.textAlign,
                      verticalAlign: oldLabel.verticalAlign,
                    }),
              },
            });
            void container;
          }
        }
        const adds = (input.add ?? []).map((skeleton) =>
          typeof skeleton.id === "string" ? skeleton : { ...skeleton, id: randomId() },
        );
        const unknown = unknownCanvasReferences({ elements }, adds);
        if (unknown.length > 0) {
          return yield* new CanvasRenderError({
            reason: "invalid",
            detail: `no elements with ids ${unknown.join(", ")}`,
          });
        }
        const duplicate = adds.find((skeleton) =>
          elements.some((element) => element.id === skeleton.id && element.isDeleted !== true),
        );
        if (duplicate !== undefined) {
          return yield* new CanvasRenderError({
            reason: "invalid",
            detail: `an element with id ${String(duplicate.id)} already exists`,
          });
        }
        // Relabelled containers already exist, so the renderer's version of
        // them replaces the scene's rather than counting as created.
        const added = yield* addConverted(elements, [...relabelSkeletons, ...adds]);
        const scene = { ...stored.scene, elements: added.elements };
        const createdIds = added.createdIds;
        const changedIds = [...createdIds, ...updatedIds];
        const { stored: next } = yield* commit(resolved, stored, scene, {
          source: "agent",
          threadId: context.threadId,
          elementIds: changedIds,
        });
        currentByThread.set(context.threadId, resolved.path);
        return {
          canvas: summaryOf(resolved, next),
          revision: next.revision,
          createdIds,
          updatedIds,
          deletedIds,
        };
      }),
    );
  });

  const loadImage = Effect.fn("CanvasService.loadImage")(function* (
    context: CanvasThreadContext,
    source: CanvasImageSource,
  ) {
    if ("url" in source) {
      if (!/^https?:\/\//iu.test(source.url)) {
        return yield* new CanvasImageError({ source: source.url, reason: "unreadable" });
      }
      const response = yield* httpClient.get(source.url).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(
          (cause) => new CanvasImageError({ source: source.url, reason: "unreadable", cause }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new CanvasImageError({ source: source.url, reason: "unreadable" });
      }
      const length = Number(response.headers["content-length"] ?? 0);
      if (length > MAX_IMAGE_BYTES) {
        return yield* new CanvasImageError({ source: source.url, reason: "too-large" });
      }
      const buffer = yield* response.arrayBuffer.pipe(
        Effect.mapError(
          (cause) => new CanvasImageError({ source: source.url, reason: "unreadable", cause }),
        ),
      );
      return { label: source.url, bytes: new Uint8Array(buffer) };
    }
    let file: string;
    let label: string;
    if ("attachmentId" in source) {
      label = source.attachmentId;
      const segment = parseThreadSegmentFromAttachmentId(source.attachmentId);
      if (segment === null || segment !== toSafeThreadAttachmentSegment(context.threadId)) {
        return yield* new CanvasImageError({ source: label, reason: "not-allowed" });
      }
      const resolvedPath = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: source.attachmentId,
      });
      if (resolvedPath === null) {
        return yield* new CanvasImageError({ source: label, reason: "unreadable" });
      }
      file = resolvedPath;
    } else {
      label = source.path;
      const expanded = yield* expandHome(source.path);
      file = path.isAbsolute(expanded)
        ? expanded
        : path.resolve((yield* projectRoot(context.projectId)).workspaceRoot, expanded);
    }
    const info = yield* fileSystem
      .stat(file)
      .pipe(
        Effect.mapError(
          (cause) => new CanvasImageError({ source: label, reason: "unreadable", cause }),
        ),
      );
    if (Number(info.size) > MAX_IMAGE_BYTES) {
      return yield* new CanvasImageError({ source: label, reason: "too-large" });
    }
    const bytes = yield* fileSystem
      .readFile(file)
      .pipe(
        Effect.mapError(
          (cause) => new CanvasImageError({ source: label, reason: "unreadable", cause }),
        ),
      );
    return { label, bytes };
  });

  const agentAddImage: CanvasService["Service"]["agentAddImage"] = Effect.fn(
    "CanvasService.agentAddImage",
  )(function* (context, input) {
    const resolved = yield* agentTarget(context, input.canvas);
    yield* requireWritable(resolved);
    const { label, bytes } = yield* loadImage(context, input.source);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return yield* new CanvasImageError({ source: label, reason: "too-large" });
    }
    const info = readImageInfo(bytes);
    if (info === null) return yield* new CanvasImageError({ source: label, reason: "not-image" });
    let image = {
      dataURL: `data:${info.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
      mimeType: info.mimeType,
      width: info.width,
      height: info.height,
    };
    if (shouldDownscaleImage(info, bytes.byteLength)) {
      image = yield* renderer.downscale({ dataURL: image.dataURL, maxSize: CANVAS_IMAGE_MAX_SIZE });
    }
    // Excalidraw names files by content, so the same image is stored once.
    const fileId = NodeCrypto.createHash("sha1").update(image.dataURL).digest("hex");
    return yield* writes.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* readStored(resolved);
        const live = stored.scene.elements.filter((element) => element.isDeleted !== true);
        let frame: CanvasElement | undefined;
        if (input.frame !== undefined) {
          const wanted = input.frame;
          frame = live.find(
            (element) =>
              (element.type === "frame" || element.type === "magicframe") &&
              (element.id === wanted ||
                (typeof element.name === "string" &&
                  element.name.toLowerCase() === wanted.toLowerCase())),
          );
          if (frame === undefined) {
            return yield* new CanvasRenderError({
              reason: "invalid",
              detail: `no frame named ${wanted}`,
            });
          }
        }
        const bounds = unionCanvasRects(
          live.flatMap((element) => canvasElementBounds(element) ?? []),
        );
        const fallback =
          frame !== undefined
            ? { x: (frame.x as number) + 20, y: (frame.y as number) + 40 }
            : bounds === null
              ? { x: 0, y: 0 }
              : { x: bounds.x + bounds.width + 80, y: bounds.y };
        // Inside a frame with no size given, the image fits the frame.
        const fit =
          frame !== undefined && input.width === undefined && input.height === undefined
            ? (() => {
                const room = {
                  width: Math.max(40, (frame.width as number) - 40),
                  height: Math.max(40, (frame.height as number) - 60),
                };
                const scale = Math.min(room.width / image.width, room.height / image.height, 1);
                return { width: image.width * scale };
              })()
            : {};
        const placed = placeCanvasImage(image, { ...input, ...fit }, fallback);
        const id = input.id ?? randomId();
        const scene: CanvasScene = {
          ...stored.scene,
          files: {
            ...stored.scene.files,
            [fileId]: {
              id: fileId,
              mimeType: image.mimeType,
              dataURL: image.dataURL,
              created: yield* Clock.currentTimeMillis,
            },
          },
        };
        const added = yield* addConverted(scene.elements, [
          {
            type: "image",
            id,
            fileId,
            status: "saved",
            ...placed,
            ...(frame === undefined ? {} : { frameId: frame.id }),
          },
        ]);
        const elements =
          frame === undefined
            ? added.elements
            : added.elements.map((element) =>
                element.id === id ? { ...element, frameId: frame!.id } : element,
              );
        const { stored: next } = yield* commit(
          resolved,
          stored,
          { ...scene, elements },
          {
            source: "agent",
            threadId: context.threadId,
            elementIds: [id],
          },
        );
        currentByThread.set(context.threadId, resolved.path);
        return {
          canvas: summaryOf(resolved, next),
          revision: next.revision,
          createdIds: [id],
          updatedIds: [],
          deletedIds: [],
        };
      }),
    );
  });

  const agentScreenshot: CanvasService["Service"]["agentScreenshot"] = Effect.fn(
    "CanvasService.agentScreenshot",
  )(function* (context, input) {
    const resolved = yield* agentTarget(context, input.canvas);
    const stored = yield* readStored(resolved);
    currentByThread.set(context.threadId, resolved.path);
    const shot = yield* shoot(stored, input);
    return { ...shot, canvas: summaryOf(resolved, stored) };
  });

  return CanvasService.of({
    list,
    read,
    save,
    create,
    rename,
    delete: deleteCanvas,
    screenshot,
    events: Stream.fromPubSub(events),
    agentList,
    agentCreate,
    agentOpen,
    agentRead,
    agentUpdate,
    agentAddImage,
    agentScreenshot,
  });
});

export const layer = Layer.effect(CanvasService, make);

/**
 * Browser setup failures as the wire's `CanvasRenderError`. MCP tools keep
 * the original errors, whose messages say how to fix the host.
 */
const BROWSER_ERROR_TAGS: ReadonlySet<string> = new Set([
  "PreviewBrowserInstallError",
  "PreviewBrowserInstallingError",
  "PreviewBrowserUnsupportedError",
  "PreviewBrowserSandboxError",
  "PreviewBrowserLibrariesError",
]);

export const browserErrorsAsRenderErrors = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.mapError((error) =>
      BROWSER_ERROR_TAGS.has(error._tag)
        ? new CanvasRenderError({ reason: "browser-unavailable", cause: error })
        : (error as Exclude<E, CanvasRenderer.CanvasBrowserError>),
    ),
  );
