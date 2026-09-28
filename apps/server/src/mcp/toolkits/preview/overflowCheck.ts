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
 */
export const overflowScanExpression = (max: number) =>
  `(async () => {
${OVERFLOW_SCAN_SOURCE};
await new Promise((resolve) => setTimeout(resolve, 400));
document.getAnimations().forEach((animation) => { try { animation.finish(); } catch {} });
return {
  report: __overflow.report(${max}),
  overflows: __overflow().filter((f) => f.kind !== "truncate" && f.kind !== "scroll").length,
};
})()`;

const isScan = (value: unknown): value is { report: string; overflows: number } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { report?: unknown }).report === "string" &&
  typeof (value as { overflows?: unknown }).overflows === "number";

/** A preset is restored by its size; the resize input takes the current catalog's ids only. */
const resizeInputFor = (setting: PreviewViewportSetting): Record<string, unknown> =>
  setting._tag === "fill"
    ? { mode: "fill" }
    : { mode: "freeform", width: setting.width, height: setting.height };

/**
 * Drives the tab through each width and stitches the per-width reports into
 * the same text `browser_overflow_check` prints, so agents read one format
 * inside and outside T3 Code.
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
    const blocks: string[] = [];
    let overflows = 0;
    let complete = true;
    for (const width of widths) {
      yield* call("resize", { mode: "freeform", width, height });
      const value = yield* call("evaluate", {
        expression: overflowScanExpression(max),
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
    }
    if (previous) yield* call("resize", resizeInputFor(previous));
    const verdict = !complete
      ? "The check did not complete at every width; see above."
      : overflows > 0
        ? `${overflows} overflow${overflows === 1 ? "" : "s"} to fix. Fix the "← cause" element, re-run, then screenshot.`
        : "No overflow. Info lines, if any, are for you to judge.";
    return { report: [...blocks, "", verdict].join("\n"), overflows };
  });
