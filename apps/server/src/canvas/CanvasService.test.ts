// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId, type CanvasElement, type Project } from "@t3tools/contracts";
import { parseCanvasScene } from "@t3tools/shared/canvas";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeZlib from "node:zlib";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CanvasRenderer from "./CanvasRenderer.ts";
import * as CanvasService from "./CanvasService.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const context = { threadId, projectId };

// Stands in for Excalidraw: skeletons become elements as they are, which is
// enough to test what the service does around the renderer.
const fakeRenderer = CanvasRenderer.CanvasRenderer.of({
  render: (input) =>
    Effect.succeed({
      png: "",
      width: Math.round(input.rect.width * input.scale),
      height: Math.round(input.rect.height * input.scale),
    }),
  convert: ({ skeletons }) =>
    Effect.succeed(
      skeletons.map(({ label: _label, children: _children, ...skeleton }) => ({
        width: 100,
        height: 50,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        ...skeleton,
      })),
    ),
  normalize: Effect.succeed,
  downscale: (input) =>
    Effect.succeed({ dataURL: input.dataURL, mimeType: "image/webp", width: 2048, height: 1024 }),
});

const makeLayer = (root: string, home: string) =>
  CanvasService.layer.pipe(
    Layer.provide(Layer.succeed(CanvasRenderer.CanvasRenderer, fakeRenderer)),
    Layer.provide(T3ProjectFileLoader.layer),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(
        ProjectService.ProjectService,
        // Only `getById` is reached.
        {
          getById: (id: ProjectId) =>
            Effect.succeed(
              id === projectId
                ? Option.some({ id, workspaceRoot: root } as unknown as Project)
                : Option.none(),
            ),
        } as unknown as ProjectService.ProjectService["Service"],
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
    Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "t3-canvas-service-" })),
    Layer.provideMerge(NodeServices.layer),
  );

/** Runs `body` with a fresh project directory and home directory. */
const withCanvases = <A, E>(
  body: (dirs: {
    readonly root: string;
    readonly home: string;
  }) => Effect.Effect<
    A,
    E,
    CanvasService.CanvasService | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-canvas-project-" });
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-canvas-home-" });
    return yield* body({ root, home }).pipe(Effect.provide(makeLayer(root, home)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const box = (id: string, extra: Partial<CanvasElement> = {}): CanvasElement => ({
  id,
  type: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  ...extra,
});

describe("CanvasService", () => {
  it.effect("creates library canvases and lists them", () =>
    withCanvases(({ root }) =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const fileSystem = yield* FileSystem.FileSystem;

        const created = yield* canvases.create({ projectId, title: "System Map" });
        expect(created.canvas).toMatchObject({
          path: `${root}/.canvases/system-map.excalidraw`,
          slug: "system-map",
          title: "System Map",
          displayPath: ".canvases/system-map.excalidraw",
          readOnly: false,
        });
        const again = yield* canvases.create({ projectId, title: "System Map" });
        expect(again.canvas.slug).toBe("system-map-2");

        const text = yield* fileSystem.readFileString(created.canvas.path);
        expect(text).toContain('\n  "type": "excalidraw",\n');
        expect(parseCanvasScene(text)?.appState).toMatchObject({ name: "System Map" });

        const listed = yield* canvases.list(projectId);
        expect(listed.folder).toBe(".canvases");
        expect(listed.canvases.map((canvas) => canvas.slug).toSorted()).toEqual([
          "system-map",
          "system-map-2",
        ]);
      }),
    ),
  );

  it.effect("lists nothing before the library folder exists", () =>
    withCanvases(() =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        expect((yield* canvases.list(projectId)).canvases).toEqual([]);
      }),
    ),
  );

  it.effect("skips writes that change nothing and keeps output stable", () =>
    withCanvases(() =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const fileSystem = yield* FileSystem.FileSystem;
        const { canvas, revision } = yield* canvases.create({ projectId, title: "Flow" });

        const first = yield* canvases.save({
          path: canvas.path,
          baseRevision: revision,
          elements: [box("a", { strokeColor: "#1e1e1e", angle: 0 })],
        });
        expect(first.written).toBe(true);
        const text = yield* fileSystem.readFileString(canvas.path);

        // Same scene, keys in another order.
        const second = yield* canvases.save({
          path: canvas.path,
          baseRevision: first.revision,
          elements: [{ angle: 0, strokeColor: "#1e1e1e", ...box("a") }],
        });
        expect(second).toMatchObject({ written: false, revision: first.revision });
        expect(yield* fileSystem.readFileString(canvas.path)).toBe(text);
      }),
    ),
  );

  it.effect("merges saves that started from an older revision", () =>
    withCanvases(() =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const { canvas, revision } = yield* canvases.create({ projectId, title: "Shared" });
        const base = yield* canvases.save({
          path: canvas.path,
          baseRevision: revision,
          elements: [box("a")],
        });

        yield* canvases.save({
          path: canvas.path,
          baseRevision: base.revision,
          elements: [box("a", { x: 40, version: 2 }), box("b")],
        });
        // A second client still on `base` adds its own element.
        const late = yield* canvases.save({
          path: canvas.path,
          baseRevision: base.revision,
          elements: [box("a"), box("c")],
        });

        expect(late.merged?.elements.map((element) => element.id).toSorted()).toEqual([
          "a",
          "b",
          "c",
        ]);
        expect(late.merged?.elements.find((element) => element.id === "a")?.x).toBe(40);
        const read = yield* canvases.read({ canvas: { path: canvas.path } });
        expect(read.scene.elements).toHaveLength(3);
      }),
    ),
  );

  // Live clock: the watcher debounces events.
  it.live("reports edits made outside T3", () =>
    withCanvases(() =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const fileSystem = yield* FileSystem.FileSystem;
        const { canvas } = yield* canvases.create({ projectId, title: "Watched" });
        const external = yield* Deferred.make<string>();
        yield* canvases.events.pipe(
          Stream.filter((event) => event.type === "changed" && event.source === "external"),
          Stream.runForEach((event) =>
            Deferred.succeed(external, event.type === "changed" ? event.path : ""),
          ),
          Effect.forkScoped,
        );

        const scene = parseCanvasScene(yield* fileSystem.readFileString(canvas.path))!;
        const edit = JSON.stringify({ type: "excalidraw", ...scene, elements: [box("x")] });
        // The folder watcher starts in the background; rewrite until it reports.
        yield* fileSystem
          .writeFileString(canvas.path, edit)
          .pipe(
            Effect.andThen(Effect.sleep("200 millis")),
            Effect.repeat({ until: () => Deferred.isDoneUnsafe(external) }),
            Effect.raceFirst(Deferred.await(external)),
          );
        expect(yield* Deferred.await(external)).toBe(canvas.path);
      }),
    ),
  );

  it.effect("resolves paths outside the project and refuses other files", () =>
    withCanvases(({ home }) =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const fileSystem = yield* FileSystem.FileSystem;
        const created = yield* canvases.create({
          projectId,
          title: "Notes",
          path: "~/notes/arch.excalidraw",
        });
        expect(created.canvas).toMatchObject({
          path: `${home}/notes/arch.excalidraw`,
          projectId: null,
          slug: null,
        });
        expect(yield* fileSystem.exists(`${home}/notes/arch.excalidraw`)).toBe(true);

        const relative = yield* Effect.flip(canvases.read({ canvas: { path: "a.excalidraw" } }));
        expect(relative).toMatchObject({ _tag: "CanvasInvalidPathError", reason: "relative-path" });

        const other = yield* Effect.flip(canvases.read({ canvas: { path: `${home}/notes.txt` } }));
        expect(other).toMatchObject({ _tag: "CanvasInvalidPathError", reason: "not-excalidraw" });

        const outside = yield* Effect.flip(canvases.delete({ path: created.canvas.path }));
        expect(outside).toMatchObject({ reason: "outside-library" });
      }),
    ),
  );

  it.effect("opens scenes embedded in exported SVGs read-only", () =>
    withCanvases(({ home }) =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const fileSystem = yield* FileSystem.FileSystem;
        const svgPath = `${home}/diagram.excalidraw.svg`;
        yield* fileSystem.writeFileString(svgPath, embeddedSvg([box("a"), box("b")]));

        const document = yield* canvases.read({ canvas: { path: svgPath } });
        expect(document.canvas).toMatchObject({ format: "excalidraw-svg", readOnly: true });
        expect(document.scene.elements.map((element) => element.id)).toEqual(["a", "b"]);

        const save = yield* Effect.flip(
          canvases.save({ path: svgPath, baseRevision: document.revision, elements: [] }),
        );
        expect(save).toMatchObject({ _tag: "CanvasInvalidPathError", reason: "read-only" });
      }),
    ),
  );

  it.effect("renames library canvases to a new file", () =>
    withCanvases(({ root }) =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const fileSystem = yield* FileSystem.FileSystem;
        const { canvas } = yield* canvases.create({ projectId, title: "Draft" });
        const renamed = yield* canvases.rename({ path: canvas.path, title: "Data Model" });
        expect(renamed).toMatchObject({
          path: `${root}/.canvases/data-model.excalidraw`,
          title: "Data Model",
        });
        expect(yield* fileSystem.exists(canvas.path)).toBe(false);
      }),
    ),
  );
});

describe("CanvasService agent operations", () => {
  it.effect("needs a canvas until the thread opens one", () =>
    withCanvases(() =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const missing = yield* Effect.flip(canvases.agentRead(context, {}));
        expect(missing._tag).toBe("CanvasNoCurrentError");

        yield* canvases.agentCreate(context, { title: "Plan" });
        const read = yield* canvases.agentRead(context, {});
        expect(read.canvas.slug).toBe("plan");
        expect((yield* canvases.agentList(context)).current).toBe(read.canvas.path);
      }),
    ),
  );

  it.effect("adds, patches and deletes elements in one update", () =>
    withCanvases(() =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const events = yield* Deferred.make<ReadonlyArray<string>>();
        yield* canvases.events.pipe(
          Stream.filter((event) => event.type === "changed" && event.source === "agent"),
          Stream.runForEach((event) =>
            Deferred.succeed(events, event.type === "changed" ? (event.elementIds ?? []) : []),
          ),
          Effect.forkScoped,
        );
        yield* canvases.agentCreate(context, { title: "Arch" });
        const first = yield* canvases.agentUpdate(context, {
          add: [
            { type: "rectangle", id: "api", x: 0, y: 0 },
            { type: "rectangle", id: "db", x: 300, y: 0 },
            { type: "ellipse", x: 600, y: 0 },
          ],
        });
        expect(first.createdIds.slice(0, 2)).toEqual(["api", "db"]);
        expect(first.createdIds).toHaveLength(3);
        expect(yield* Deferred.await(events)).toEqual(first.createdIds);

        const second = yield* canvases.agentUpdate(context, {
          delete: ["db"],
          update: [{ id: "api", x: 50 }],
        });
        expect(second).toMatchObject({ deletedIds: ["db"], updatedIds: ["api"] });

        const read = yield* canvases.agentRead(context, {});
        expect(read.elements.map((element) => element.id)).toEqual(["api", first.createdIds[2]]);
        expect(read.elements[0]).toMatchObject({ x: 50 });

        const duplicate = yield* Effect.flip(
          canvases.agentUpdate(context, { add: [{ type: "rectangle", id: "api" }] }),
        );
        expect(duplicate).toMatchObject({ _tag: "CanvasRenderError", reason: "invalid" });
        const dangling = yield* Effect.flip(
          canvases.agentUpdate(context, {
            add: [{ type: "arrow", start: { id: "nope" }, end: { id: "api" } }],
          }),
        );
        expect(dangling.message).toContain("nope");
      }),
    ),
  );

  it.effect("embeds images from a file and shrinks large ones", () =>
    withCanvases(({ root }) =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* canvases.agentCreate(context, { title: "Shots" });
        yield* canvases.agentUpdate(context, {
          add: [{ type: "frame", id: "f", name: "Login", x: 0, y: 0, width: 500, height: 400 }],
        });

        yield* fileSystem.writeFile(`${root}/wide.png`, pngHeader(4096, 2048));
        const result = yield* canvases.agentAddImage(context, {
          source: { path: "wide.png" },
          frame: "login",
        });
        const read = yield* canvases.agentRead(context, { full: true, ids: result.createdIds });
        const image = read.elements[0] as CanvasElement | undefined;
        expect(image).toMatchObject({ type: "image", frameId: "f", x: 20, y: 40, width: 460 });
        expect(image?.height).toBe(230);
        expect("omittedImages" in read && read.omittedImages).toEqual([image?.fileId]);

        const document = yield* canvases.read({ canvas: { path: read.canvas.path } });
        expect(document.scene.files[image?.fileId as string]?.mimeType).toBe("image/webp");

        const notImage = yield* Effect.flip(
          canvases.agentAddImage(context, { source: { path: "missing.png" } }),
        );
        expect(notImage).toMatchObject({ _tag: "CanvasImageError", reason: "unreadable" });
        const otherThread = yield* Effect.flip(
          canvases.agentAddImage(context, { source: { attachmentId: "thread-2-0000" } }),
        );
        expect(otherThread).toMatchObject({ _tag: "CanvasImageError", reason: "not-allowed" });
      }),
    ),
  );

  it.effect("screenshots crops at the requested scale", () =>
    withCanvases(() =>
      Effect.gen(function* () {
        const canvases = yield* CanvasService.CanvasService;
        yield* canvases.agentCreate(context, { title: "Shot" });
        yield* canvases.agentUpdate(context, {
          add: [{ type: "rectangle", id: "a", x: 0, y: 0, width: 200, height: 100 }],
        });
        const shot = yield* canvases.agentScreenshot(context, {
          crop: { type: "elements", ids: ["a"] },
          padding: 10,
          scale: 2,
        });
        expect(shot.rect).toEqual({ x: -10, y: -10, width: 220, height: 120 });
        expect({ width: shot.width, height: shot.height }).toEqual({ width: 440, height: 240 });

        const missing = yield* Effect.flip(
          canvases.agentScreenshot(context, { crop: { type: "frame", frame: "nope" } }),
        );
        expect(missing).toMatchObject({ _tag: "CanvasRenderError", reason: "invalid" });
      }),
    ),
  );
});

/** An SVG as Excalidraw exports it with "Embed scene" on. */
function embeddedSvg(elements: ReadonlyArray<CanvasElement>) {
  const json = JSON.stringify({
    type: "excalidraw",
    version: 2,
    elements,
    appState: {},
    files: {},
  });
  const encoded = NodeZlib.deflateSync(Buffer.from(json)).toString("latin1");
  const envelope = JSON.stringify({ version: "1", encoding: "bstring", compressed: true, encoded });
  const payload = Buffer.from(envelope, "latin1").toString("base64");
  return `<svg xmlns="http://www.w3.org/2000/svg"><!-- svg-source:excalidraw --><!-- payload-type:application/vnd.excalidraw+json --><!-- payload-version:2 --><!-- payload-start -->${payload}<!-- payload-end --></svg>`;
}

/** The start of a PNG: enough for its size to be read. */
function pngHeader(width: number, height: number) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
}
