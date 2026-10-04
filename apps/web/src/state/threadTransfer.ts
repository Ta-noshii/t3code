import { THREAD_TRANSFER_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Copying a chat to another environment, advertised by the `threadTransfer` capability. */
export const threadExportCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration:export-thread",
  tag: THREAD_TRANSFER_WS_METHODS.exportThread,
});

export const threadImportCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration:import-thread",
  tag: THREAD_TRANSFER_WS_METHODS.importThread,
});
