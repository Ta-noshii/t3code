// @effect-diagnostics nodeBuiltinImport:off - Builds a real SQLite file and record on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import * as DesktopHostedBackend from "./DesktopHostedBackend.ts";

const withDir = (run: (dir: string) => void) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hosted-backend-"));
  try {
    run(dir);
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

describe("busyThreadCount", () => {
  it("counts threads with a run in flight or background work left running", () =>
    withDir((dir) => {
      const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "statev2.sqlite"));
      db.exec(`
        CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT);
        CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, payload_json TEXT);
        INSERT INTO orchestration_v2_projection_runs VALUES
          ('running', 'running'), ('waiting', 'waiting'), ('done', 'completed'), ('both', 'starting');
        INSERT INTO orchestration_v2_projection_provider_threads VALUES
          ('background', '{"pendingBackgroundTasks":[{"id":"task"}]}'),
          ('both', '{"pendingBackgroundTasks":[{"id":"task"}]}'),
          ('idle', '{"pendingBackgroundTasks":[]}'),
          ('none', '{}'),
          ('broken', 'not json');
      `);
      db.close();
      assert.deepStrictEqual(DesktopHostedBackend.busyThreadCount(dir), Option.some(4));
    }));

  it("reports nothing when the database cannot be read", () =>
    withDir((dir) => {
      assert.isTrue(Option.isNone(DesktopHostedBackend.busyThreadCount(dir)));
    }));
});

describe("readLiveHostSync", () => {
  it("ignores a record whose pid is not a backend host", () =>
    withDir((dir) => {
      NodeFS.writeFileSync(
        DesktopHostedBackend.recordPathFor(dir),
        JSON.stringify({
          version: 1,
          hostPid: process.pid,
          serverPid: process.pid,
          socketPath: NodePath.join(dir, "host.sock"),
          runtimeKey: "runtime",
          runtimeDir: dir,
          appVersion: "0.0.0",
          port: 3773,
          bootstrapSecret: "secret",
          startedAt: "2026-11-13T00:00:00.000Z",
        }),
      );
      assert.isTrue(Option.isNone(DesktopHostedBackend.readLiveHostSync(dir)));
    }));
});
