// Copies ~/pbf-e2e-harness/overflow.js into the server's OVERFLOW_SCAN_SOURCE string.
// Run from the repo root after editing overflow.js; the header of the target file stays.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const target = "apps/server/src/mcp/toolkits/preview/overflowScanSource.ts";
const source = process.argv[2] ?? NodePath.join(NodeOS.homedir(), "pbf-e2e-harness", "overflow.js");
const current = NodeFS.readFileSync(target, "utf8");
const header = current.slice(0, current.indexOf("export const OVERFLOW_SCAN_SOURCE"));
const scanner = NodeFS.readFileSync(source, "utf8");
NodeFS.writeFileSync(
  target,
  // The same shape `vp fmt` produces, so the generated file passes the format check as written.
  `${header}export const OVERFLOW_SCAN_SOURCE =\n  ${JSON.stringify(scanner)};\n`,
);
console.log(`${target}: ${scanner.length} chars from ${source}`);
