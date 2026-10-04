import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewAutomationOperation,
  type PreviewAutomationStatus,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OVERFLOW_SCAN_SOURCE } from "./overflowScanSource.ts";
import { OVERFLOW_CHECK_DEFAULT_WIDTHS } from "./tools.ts";

export interface OverflowCheckInput {
  readonly urls?: readonly string[] | undefined;
  readonly settle?: number | undefined;
  readonly widths?: readonly number[] | undefined;
  readonly height?: number | undefined;
  readonly max?: number | undefined;
  readonly restore?: boolean | undefined;
}

/** Runs one broker operation against the tab under test and returns its raw result. */
export type OverflowCheckCall<E, R> = (
  operation: PreviewAutomationOperation,
  input: Record<string, unknown>,
) => Effect.Effect<unknown, E, R>;

/**
 * The page-side half of the check: load the scanner, let the layout settle,
 * finish entrance animations so they are measured at rest, then report.
 * `status` is the document's HTTP status, so an error page is not read as clean.
 */
export const overflowScanExpression = (max: number, waitMs = 400) =>
  `(async () => {
${OVERFLOW_SCAN_SOURCE};
await new Promise((resolve) => setTimeout(resolve, ${waitMs}));
document.getAnimations().forEach((animation) => { try { animation.finish(); } catch {} });
return {
  report: __overflow.report(${max}),
  overflows: __overflow().filter((f) => f.kind !== "truncate" && f.kind !== "scroll").length,
  status: performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0,
};
})()`;

const isScan = (value: unknown): value is { report: string; overflows: number; status?: number } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { report?: unknown }).report === "string" &&
  typeof (value as { overflows?: unknown }).overflows === "number";

/** A preset is restored by its size; the resize input takes the current catalog's ids only. */
const resizeInputFor = (setting: PreviewViewportSetting): Record<string, unknown> =>
  setting._tag === "fill"
    ? { mode: "fill" }
    : { mode: "freeform", width: setting.width, height: setting.height };

const describeFailure = (failure: unknown): string => {
  const message =
    typeof failure === "object" && failure !== null
      ? (failure as { message?: unknown }).message
      : failure;
  const line = String(message ?? "navigation failed").split("\n")[0] ?? "";
  return line.slice(0, 160) || "navigation failed";
};

/** One page's scan at every width: its report blocks, or why they could not be read. */
const scanWidths = <E, R>(
  call: OverflowCheckCall<E, R>,
  widths: readonly number[],
  height: number,
  max: number,
  settle: number,
) =>
  Effect.gen(function* () {
    const blocks: string[] = [];
    let overflows = 0;
    let complete = true;
    let status = 0;
    for (const [index, width] of widths.entries()) {
      yield* call("resize", { mode: "freeform", width, height });
      const value = yield* call("evaluate", {
        expression: overflowScanExpression(max, index === 0 ? 400 + settle : 400),
        awaitPromise: true,
      });
      if (!isScan(value)) {
        blocks.push(
          `${width}px: could not read the scanner result: ${String(value).slice(0, 400)}`,
        );
        complete = false;
        continue;
      }
      blocks.push(value.report);
      overflows += value.overflows;
      status = value.status ?? 0;
    }
    return { blocks, overflows, complete, status };
  });

/**
 * Drives the tab through each width and stitches the per-width reports into
 * the same text `browser_overflow_check` prints, so agents read one format
 * inside and outside T3 Code. With `urls`, the tab visits each page in turn
 * and the report is grouped by page.
 */
export const runOverflowCheck = <E, R>(call: OverflowCheckCall<E, R>, input: OverflowCheckInput) =>
  Effect.gen(function* () {
    const widths =
      input.widths && input.widths.length > 0 ? input.widths : OVERFLOW_CHECK_DEFAULT_WIDTHS;
    const height = input.height ?? 900;
    const max = input.max ?? 10;
    const previous = input.restore
      ? (((yield* call("status", {})) as PreviewAutomationStatus).viewportSetting ??
        FILL_PREVIEW_VIEWPORT)
      : undefined;

    if (!input.urls || input.urls.length === 0) {
      const scan = yield* scanWidths(call, widths, height, max, 0);
      if (previous) yield* call("resize", resizeInputFor(previous));
      const verdict = !scan.complete
        ? "The check did not complete at every width; see above."
        : scan.overflows > 0
          ? `${scan.overflows} overflow${scan.overflows === 1 ? "" : "s"} to fix. Fix the "← cause" element, re-run, then screenshot.`
          : "No overflow. Info lines, if any, are for you to judge.";
      return { report: [...scan.blocks, "", verdict].join("\n"), overflows: scan.overflows };
    }

    const settle = input.settle ?? 1500;
    const lines: string[] = [];
    let overflows = 0;
    let needWork = 0;
    let notLoaded = 0;
    for (const url of input.urls) {
      // A page that fails to open is reported and the rest are still checked.
      const navigation = yield* Effect.result(call("navigate", { url }));
      if (navigation._tag === "Failure") {
        lines.push(`${url}: did not load (${describeFailure(navigation.failure)})`);
        needWork += 1;
        notLoaded += 1;
        continue;
      }
      const scan = yield* scanWidths(call, widths, height, max, settle);
      if (!scan.complete || scan.status >= 400) {
        const reason = scan.complete
          ? `HTTP ${scan.status}`
          : (scan.blocks.find((block) => block.includes("could not read")) ?? "scan failed");
        lines.push(`${url}: did not load (${reason.split("\n")[0]})`);
        needWork += 1;
        notLoaded += 1;
        continue;
      }
      if (scan.blocks.every((block) => block.endsWith(": clean"))) {
        lines.push(`${url}: clean`);
      } else {
        lines.push(url, ...scan.blocks.flatMap((block) => block.split("\n").map((l) => `  ${l}`)));
      }
      if (scan.overflows > 0) needWork += 1;
      overflows += scan.overflows;
    }
    if (previous) yield* call("resize", resizeInputFor(previous));
    const total = input.urls.length;
    const verdict =
      needWork > 0
        ? `${needWork} of ${total} pages need work: ${overflows} overflow${overflows === 1 ? "" : "s"}${notLoaded > 0 ? `, ${notLoaded} did not load` : ""}.${overflows > 0 ? ' Fix the "← cause" elements, re-run, then screenshot.' : ""}`
        : `No overflow on ${total} pages. Info lines, if any, are for you to judge.`;
    return { report: [...lines, "", verdict].join("\n"), overflows };
  });
