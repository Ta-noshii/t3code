import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Cross-environment clone, advertised by the `threadTransfer` environment capability. */
export const threadExportCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration:export-thread",
  tag: ORCHESTRATION_WS_METHODS.exportThread,
});

export const threadImportCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration:import-thread",
  tag: ORCHESTRATION_WS_METHODS.importThread,
});
