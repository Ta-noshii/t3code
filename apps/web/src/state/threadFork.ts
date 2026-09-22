import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Server-side fork, advertised by the `threadFork` environment capability. */
export const threadForkCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration:fork-thread",
  tag: ORCHESTRATION_WS_METHODS.forkThread,
});
