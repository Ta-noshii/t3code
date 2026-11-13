// @effect-diagnostics nodeBuiltinImport:off - Shared with the backend host, which has no Effect runtime.
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

const BUSY_SQL = `
  SELECT thread_id FROM orchestration_v2_projection_runs
  WHERE status IN ('preparing', 'starting', 'running', 'waiting')
  UNION
  SELECT thread_id FROM orchestration_v2_projection_provider_threads
  WHERE CASE WHEN json_valid(payload_json)
    THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0 ELSE 0 END
`;

/**
 * Threads a server stop would cut: a run in flight or background work a turn left running.
 * Undefined when the state database cannot be read.
 */
export const countBusyThreads = (stateDir: string): number | undefined => {
  try {
    const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "statev2.sqlite"), {
      readOnly: true,
    });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      return db.prepare(BUSY_SQL).all().length;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
};
