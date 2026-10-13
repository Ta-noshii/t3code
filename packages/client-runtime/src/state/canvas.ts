import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Canvas library and editor data. Saves to one file run in order, so a
 * debounced save never lands before the one it follows.
 */
export function createCanvasEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:canvas:list",
      tag: WS_METHODS.canvasList,
      staleTimeMs: 5_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:canvas:events",
      tag: WS_METHODS.subscribeCanvasEvents,
    }),
    read: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:read",
      tag: WS_METHODS.canvasRead,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:save",
      tag: WS_METHODS.canvasSave,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.path]),
      },
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:create",
      tag: WS_METHODS.canvasCreate,
    }),
    rename: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:rename",
      tag: WS_METHODS.canvasRename,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:delete",
      tag: WS_METHODS.canvasDelete,
    }),
    screenshot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:canvas:screenshot",
      tag: WS_METHODS.canvasScreenshot,
    }),
  };
}
