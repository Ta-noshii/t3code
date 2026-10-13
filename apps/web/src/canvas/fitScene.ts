import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/**
 * Brings the whole drawing into view, zooming out as far as it needs but
 * never in past 100%. Excalidraw's own `scrollToContent` only centres the
 * scene, which leaves most of a drawing outside a side panel or a phone.
 */
export function fitCanvasScene(api: ExcalidrawImperativeAPI): void {
  const elements = api.getSceneElements();
  if (elements.length === 0) return;
  api.scrollToContent(elements, { fitToContent: true, viewportZoomFactor: 0.9, animate: false });
}
