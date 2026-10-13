// The canvas host page. The server's headless renderer loads it to rasterize
// and convert canvases (window.t3Canvas below); the mobile app loads it in a
// WebView to show the editor (see ./editorHost.tsx).
import { configureExcalidrawAssets } from "../canvas/excalidrawAssets";
import type { CanvasHostOp } from "@t3tools/shared/canvas";

import { runCanvasHostOp } from "./ops";

configureExcalidrawAssets(window.location.origin);

declare global {
  interface Window {
    t3Canvas?: {
      /** Runs the op stored at `/__t3/input.json` by the server. */
      runInput: () => Promise<unknown>;
      run: (op: CanvasHostOp) => Promise<unknown>;
    };
  }
}

window.t3Canvas = {
  run: runCanvasHostOp,
  runInput: async () => {
    const response = await fetch("/__t3/input.json");
    return runCanvasHostOp((await response.json()) as CanvasHostOp);
  },
};

// The headless renderer never posts a load message, so the editor (and React)
// only load inside a WebView.
const isWebView = "ReactNativeWebView" in window;
if (isWebView) {
  void import("./editorHost").then(({ mountEditorHost }) => mountEditorHost());
}
