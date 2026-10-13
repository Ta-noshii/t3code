import type { CanvasEvent, ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useCanvasEvents } from "./useCanvasEvents";

/** Shows the canvas an agent opens with canvas_open in this thread's Canvas tab. */
export function useCanvasFocus(threadRef: ScopedThreadRef | null): void {
  useCanvasEvents(
    threadRef?.environmentId ?? null,
    useCallback(
      (event: CanvasEvent) => {
        if (threadRef === null) return;
        if (event.type !== "focus" || event.threadId !== threadRef.threadId) return;
        useRightPanelStore.getState().openCanvas(threadRef, event.canvas.path, true);
      },
      [threadRef],
    ),
  );
}
