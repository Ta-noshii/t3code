/**
 * Runs Excalidraw for the server. Excalidraw only runs in a browser, so each
 * call loads the web build's canvas host page (`canvas-host.html`) in T3's
 * headless Chrome and runs one op there: rasterize a crop, turn element
 * skeletons into elements, remeasure text, or shrink an image.
 *
 * Needs the headless browser (installed on first use, like `html_preview`)
 * and the built web app; dev servers without `apps/web/dist` report
 * `renderer-missing`.
 */
import {
  CANVAS_HOST_PAGE_PATH,
  CanvasRenderError,
  type CanvasElement,
  type CanvasRect,
  type CanvasScene,
} from "@t3tools/contracts";
import type { CanvasHostOp, CanvasHostResult } from "@t3tools/shared/canvas";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Mime from "effect/http/Mime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as ServerConfig from "../config.ts";
import * as HeadlessChrome from "../htmlRender/headlessChrome.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as PreviewBrowserHost from "../preview/PreviewBrowserHost.ts";

const INPUT_PATH = "/__t3/input.json";
// Each op is its own Chrome process; a burst of screenshots queues here.
const MAX_CONCURRENT_BROWSERS = 2;

export type CanvasBrowserError =
  | PreviewBrowser.PreviewBrowserInstallError
  | PreviewBrowser.PreviewBrowserInstallingError
  | PreviewBrowser.PreviewBrowserUnsupportedError
  | PreviewBrowserHost.PreviewBrowserHostError;

export interface CanvasImage {
  readonly dataURL: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

export class CanvasRenderer extends Context.Service<
  CanvasRenderer,
  {
    /** A PNG (base64) of `rect` in scene units at `scale` output pixels per unit. */
    readonly render: (input: {
      readonly scene: CanvasScene;
      readonly rect: CanvasRect;
      readonly scale: number;
      readonly background: boolean;
      readonly dark: boolean;
    }) => Effect.Effect<
      { readonly png: string; readonly width: number; readonly height: number },
      CanvasRenderError | CanvasBrowserError
    >;
    /**
     * Full elements for Excalidraw skeletons. Existing elements the new ones
     * bind to come back too when their bindings changed.
     */
    readonly convert: (input: {
      readonly skeletons: ReadonlyArray<Record<string, unknown>>;
      readonly existing: ReadonlyArray<CanvasElement>;
    }) => Effect.Effect<ReadonlyArray<CanvasElement>, CanvasRenderError | CanvasBrowserError>;
    /** The elements with text remeasured and bindings repaired. */
    readonly normalize: (
      elements: ReadonlyArray<CanvasElement>,
    ) => Effect.Effect<ReadonlyArray<CanvasElement>, CanvasRenderError | CanvasBrowserError>;
    /** The image re-encoded with its longest side at most `maxSize`. */
    readonly downscale: (input: {
      readonly dataURL: string;
      readonly maxSize: number;
    }) => Effect.Effect<CanvasImage, CanvasRenderError | CanvasBrowserError>;
  }
>()("t3/canvas/CanvasRenderer") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  const services = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  const browsers = yield* Semaphore.make(MAX_CONCURRENT_BROWSERS);
  const noSandbox = PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment);
  const setupCommand = yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND);

  const rendererMissing = () => new CanvasRenderError({ reason: "renderer-missing" });

  const staticRoot = Effect.gen(function* () {
    const staticDir =
      config.staticDir ??
      (yield* ServerConfig.resolveStaticDir().pipe(Effect.provideContext(services)));
    if (staticDir === undefined) return yield* rendererMissing();
    return path.resolve(staticDir);
  });

  // Serves the built page's own scripts, styles and fonts; nothing else.
  const resourcesFor =
    (root: string, input: Uint8Array): HeadlessChrome.PageResources =>
    (pathname) =>
      Effect.gen(function* () {
        if (pathname === INPUT_PATH) {
          return { bytes: input, contentType: "application/json" };
        }
        if (!pathname.startsWith("/assets/") && !pathname.startsWith("/excalidraw-assets/")) {
          return undefined;
        }
        const file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
        if (!file.startsWith(`${root}${path.sep}`)) return undefined;
        const bytes = yield* fileSystem.readFile(file).pipe(Effect.option);
        if (Option.isNone(bytes)) return undefined;
        return {
          bytes: bytes.value,
          contentType: Option.getOrElse(Mime.getType(file), () => "application/octet-stream"),
        };
      }).pipe(Effect.orElseSucceed(() => undefined));

  const run = Effect.fn("CanvasRenderer.run")(function* (op: CanvasHostOp) {
    const root = yield* staticRoot;
    const html = yield* fileSystem
      .readFileString(path.join(root, CANVAS_HOST_PAGE_PATH))
      .pipe(Effect.mapError(rendererMissing));
    const executable = yield* previewBrowser.executable;
    // @effect-diagnostics-next-line preferSchemaOverJson:off - the op is plain JSON data for the page.
    const input = new TextEncoder().encode(JSON.stringify(op));
    const result = yield* browsers.withPermits(1)(
      HeadlessChrome.evaluatePage({
        executable,
        noSandbox,
        html,
        resources: resourcesFor(root, input),
        expression: "window.t3Canvas.runInput()",
      }).pipe(
        Effect.provideContext(services),
        Effect.catchTags({
          HtmlRenderBrowserError: (error) =>
            error.output === undefined
              ? Effect.fail(new CanvasRenderError({ reason: "render-failed", cause: error }))
              : PreviewBrowserHost.diagnoseLaunchFailure({
                  executable,
                  setupCommand,
                  output: error.output,
                }).pipe(
                  Effect.provideContext(services),
                  Effect.flatMap((hostError) =>
                    Effect.fail(
                      hostError ??
                        new CanvasRenderError({ reason: "browser-unavailable", cause: error }),
                    ),
                  ),
                ),
        }),
      ),
    );
    const value = result as CanvasHostResult | undefined;
    if (value === undefined || value === null || typeof value !== "object") {
      return yield* new CanvasRenderError({ reason: "render-failed" });
    }
    if ("error" in value) {
      return yield* new CanvasRenderError({ reason: "invalid", detail: value.error });
    }
    return value;
  });

  const expect = <K extends string>(key: K) =>
    Effect.flatMap((value: CanvasHostResult) =>
      key in value
        ? Effect.succeed(value as Extract<CanvasHostResult, Record<K, unknown>>)
        : Effect.fail(new CanvasRenderError({ reason: "render-failed" })),
    );

  return CanvasRenderer.of({
    render: (input) => run({ op: "render", ...input }).pipe(expect("png")),
    convert: (input) =>
      run({ op: "convert", ...input }).pipe(
        expect("elements"),
        Effect.map((value) => value.elements),
      ),
    normalize: (elements) =>
      run({ op: "normalize", elements }).pipe(
        expect("elements"),
        Effect.map((value) => value.elements),
      ),
    downscale: (input) => run({ op: "downscale", ...input }).pipe(expect("dataURL")),
  });
});

export const layer = Layer.effect(CanvasRenderer, make);
