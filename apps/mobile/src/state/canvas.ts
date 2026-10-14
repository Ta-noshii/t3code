import { useAtomMount, useAtomSubscribe } from "@effect/atom-react";
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
  const events: Atom.Atom<AsyncResult.AsyncResult<CanvasEvent, unknown>> =
    environmentId === null ? NO_EVENTS : canvasEnvironment.events({ environmentId, input: {} });
  // A listener alone never reads the atom, so the subscription would not start.
  // Mounting starts it without replaying the last event to a new listener.
  useAtomMount(events);
  useAtomSubscribe(
    events,
    useCallback((result: AsyncResult.AsyncResult<CanvasEvent, unknown>) => {
      if (AsyncResult.isSuccess(result)) handler.current(result.value);
    }, []),
  );
}
