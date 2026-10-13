// @effect-diagnostics nodeBuiltinImport:off - Vite plugins run in Node.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";

import type { Plugin } from "vite-plus";

/** Where the canvas editor and the canvas host page load Excalidraw's fonts from. */
export const EXCALIDRAW_ASSETS_PATH = "/excalidraw-assets/";

// Xiaolai (CJK, about 13 MB) stays out of the bundle. Excalidraw falls back to
// its CDN for fonts it cannot find here, so CJK text still renders when online.
const SKIPPED_FONTS = new Set(["Xiaolai"]);

const CONTENT_TYPES: Record<string, string> = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function fontsDir(): string {
  const require = NodeModule.createRequire(import.meta.url);
  const entry = require.resolve("@excalidraw/excalidraw");
  // The package's main entry sits in dist/prod (or dist/dev); fonts live next to it.
  return NodePath.join(NodePath.dirname(entry), "..", "prod", "fonts");
}

/**
 * Serves Excalidraw's fonts under `/excalidraw-assets/fonts` in dev and copies
 * them into the build, so canvases render offline with the hand-drawn fonts
 * on every origin that serves the web app, including the headless renderer.
 */
export function excalidrawAssetsPlugin(): Plugin {
  let outDir = "dist";
  return {
    name: "t3code:excalidraw-assets",
    configResolved(config) {
      outDir = NodePath.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      const root = fontsDir();
      server.middlewares.use(`${EXCALIDRAW_ASSETS_PATH}fonts`, (req, res, next) => {
        const relative = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
        const file = NodePath.join(root, relative);
        if (!file.startsWith(`${root}${NodePath.sep}`) || !NodeFS.existsSync(file)) {
          next();
          return;
        }
        res.setHeader(
          "Content-Type",
          CONTENT_TYPES[NodePath.extname(file)] ?? "application/octet-stream",
        );
        NodeFS.createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      const root = fontsDir();
      const target = NodePath.join(outDir, EXCALIDRAW_ASSETS_PATH, "fonts");
      for (const family of NodeFS.readdirSync(root)) {
        if (SKIPPED_FONTS.has(family)) continue;
        NodeFS.cpSync(NodePath.join(root, family), NodePath.join(target, family), {
          recursive: true,
        });
      }
    },
  };
}
