import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as CanvasRenderer from "./CanvasRenderer.ts";

// Real-browser tests run only when this names a chrome-headless-shell and the
// web app is built (they load apps/web/dist/canvas-host.html).
const executable = process.env.T3CODE_TEST_HEADLESS_SHELL;

const layer = CanvasRenderer.layer.pipe(
  Layer.provide(
    Layer.succeed(
      PreviewBrowser.PreviewBrowser,
      PreviewBrowser.PreviewBrowser.of({
        executable:
          executable === undefined
            ? Effect.die("This test has no preview browser.")
            : Effect.succeed(executable),
        installed: Effect.succeed(Option.fromUndefinedOr(executable)),
      }),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-canvas-renderer-" })),
  Layer.provideMerge(NodeServices.layer),
);

const pngSize = (base64: string) => {
  const bytes = Buffer.from(base64, "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

describe.runIf(executable !== undefined)("CanvasRenderer in headless Chrome", () => {
  it.layer(layer, { timeout: 120_000 })((it) => {
    it.effect("converts skeletons, binds arrows to existing shapes, and renders a crop", () =>
      Effect.gen(function* () {
        const renderer = yield* CanvasRenderer.CanvasRenderer;
        const [box] = yield* renderer.convert({
          skeletons: [
            {
              type: "rectangle",
              id: "box",
              x: 0,
              y: 0,
              width: 200,
              height: 100,
              label: { text: "API" },
            },
          ],
          existing: [],
        });
        expect(box?.id).toBe("box");

        const created = yield* renderer.convert({
          skeletons: [
            { type: "ellipse", id: "db", x: 400, y: 0, width: 120, height: 100 },
            { type: "arrow", id: "link", x: 200, y: 50, start: { id: "box" }, end: { id: "db" } },
          ],
          existing: [box!],
        });
        const ids = created.map((element) => element.id);
        expect(ids).toEqual(expect.arrayContaining(["db", "link", "box"]));
        const boundBox = created.find((element) => element.id === "box");
        expect(boundBox?.boundElements).toEqual(
          expect.arrayContaining([{ id: "link", type: "arrow" }]),
        );

        const shot = yield* renderer.render({
          scene: { elements: [...created], appState: {}, files: {} },
          rect: { x: -10, y: -10, width: 540, height: 120 },
          scale: 2,
          background: true,
          dark: false,
        });
        expect({ width: shot.width, height: shot.height }).toEqual({ width: 1080, height: 240 });
        expect(pngSize(shot.png)).toEqual({ width: 1080, height: 240 });
      }),
    );

    it.effect("keeps a frame's box when it has no children", () =>
      Effect.gen(function* () {
        const renderer = yield* CanvasRenderer.CanvasRenderer;
        const [frame] = yield* renderer.convert({
          skeletons: [
            { type: "frame", id: "f", name: "Login", x: 0, y: 0, width: 300, height: 200 },
          ],
          existing: [],
        });
        expect(frame).toMatchObject({ id: "f", x: 0, y: 0, width: 300, height: 200 });
        const [box] = yield* renderer.convert({
          skeletons: [{ type: "rectangle", id: "r", x: 400, y: 0, width: 50, height: 50 }],
          existing: [frame!],
        });
        expect(box?.id).toBe("r");
      }),
    );

    it.effect("remeasures text after its content changes", () =>
      Effect.gen(function* () {
        const renderer = yield* CanvasRenderer.CanvasRenderer;
        const [text] = yield* renderer.convert({
          skeletons: [{ type: "text", id: "t", x: 0, y: 0, text: "Hi" }],
          existing: [],
        });
        const [normalized] = yield* renderer.normalize([
          { ...text!, text: "A much longer line", originalText: "A much longer line" },
        ]);
        expect(normalized?.width as number).toBeGreaterThan((text!.width as number) * 3);
      }),
    );

    it.effect("shrinks large images", () =>
      Effect.gen(function* () {
        const renderer = yield* CanvasRenderer.CanvasRenderer;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1000"><rect width="4000" height="1000" fill="red"/></svg>`;
        const image = yield* renderer.downscale({
          dataURL: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
          maxSize: 2048,
        });
        expect(image).toMatchObject({ mimeType: "image/webp", width: 2048, height: 512 });
      }),
    );
  });
});
