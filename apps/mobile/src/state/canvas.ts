import { useAtomSubscribe } from "@effect/atom-react";
import { createCanvasEnvironmentAtoms } from "@t3tools/client-runtime/state/canvas";
import type { CanvasEvent, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useRef } from "react";

import { connectionAtomRuntime } from "../connection/runtime";

export const canvasEnvironment = createCanvasEnvironmentAtoms(connectionAtomRuntime);

const NO_EVENTS = Atom.make(AsyncResult.initial<CanvasEvent, unknown>()).pipe(
  Atom.withLabel("mobile-canvas:no-events"),
);

/** Calls `onEvent` for each canvas event from the environment while mounted. */
export function useCanvasEvents(
  environmentId: EnvironmentId | null,
  onEvent: (event: CanvasEvent) => void,
): void {
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useAtomSubscribe(
    environmentId === null ? NO_EVENTS : canvasEnvironment.events({ environmentId, input: {} }),
    useCallback((result: AsyncResult.AsyncResult<CanvasEvent, unknown>) => {
      if (AsyncResult.isSuccess(result)) handler.current(result.value);
    }, []),
  );
}
