import { useAtomSubscribe } from "@effect/atom-react";
import type { CanvasEvent, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { canvasEnvironment } from "~/state/canvas";

const NO_EVENTS = Atom.make(AsyncResult.initial<CanvasEvent, unknown>()).pipe(
  Atom.withLabel("canvas:no-events"),
);

/** Shows the canvas an agent opens with canvas_open in this thread's Canvas tab. */
export function useCanvasFocus(threadRef: ScopedThreadRef | null): void {
  useAtomSubscribe(
    threadRef === null
      ? NO_EVENTS
      : canvasEnvironment.events({ environmentId: threadRef.environmentId, input: {} }),
    useCallback(
      (result: AsyncResult.AsyncResult<CanvasEvent, unknown>) => {
        if (threadRef === null || !AsyncResult.isSuccess(result)) return;
        const event = result.value;
        if (event.type !== "focus" || event.threadId !== threadRef.threadId) return;
        useRightPanelStore.getState().openCanvas(threadRef, event.canvas.path, true);
      },
      [threadRef],
    ),
  );
}
