/** Where the web build serves Excalidraw's fonts (see vite/excalidrawAssets.ts). */
const CANVAS_ASSET_PATH = "/excalidraw-assets/";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

/**
 * Point Excalidraw at the fonts this origin serves. Excalidraw still falls
 * back to its CDN for anything missing here (the CJK font is not bundled).
 * Call before the first canvas renders.
 */
export function configureExcalidrawAssets(origin: string): void {
  window.EXCALIDRAW_ASSET_PATH = new URL(CANVAS_ASSET_PATH, origin).toString();
}
