import { useAtomMount, useAtomSubscribe } from "@effect/atom-react";
import type { CanvasEvent, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { canvasEnvironment } from "~/state/canvas";

const NO_EVENTS = Atom.make(AsyncResult.initial<CanvasEvent, unknown>()).pipe(
  Atom.withLabel("canvas:no-events"),
);

/**
 * Calls `onEvent` for each canvas event the environment sends from now on.
 * Mounting starts the stream; a plain subscribe would not. The last event is
 * not replayed, so a remount never repeats an old `focus`.
 */
export function useCanvasEvents(
  environmentId: EnvironmentId | null,
  onEvent: (event: CanvasEvent) => void,
): void {
  const atom: Atom.Atom<AsyncResult.AsyncResult<CanvasEvent, unknown>> =
    environmentId === null ? NO_EVENTS : canvasEnvironment.events({ environmentId, input: {} });
  useAtomMount(atom);
  useAtomSubscribe(
    atom,
    useCallback(
      (result: AsyncResult.AsyncResult<CanvasEvent, unknown>) => {
        if (AsyncResult.isSuccess(result)) onEvent(result.value);
      },
      [onEvent],
    ),
  );
}
