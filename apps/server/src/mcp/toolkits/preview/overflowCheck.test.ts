import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  overflowScanExpression,
  runOverflowCheck,
  type OverflowCheckCall,
} from "./overflowCheck.ts";

const fakeBroker = (scans: ReadonlyArray<unknown>, viewportSetting?: unknown) => {
  const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const timeouts: Array<number | undefined> = [];
  const pending = [...scans];
  const call: OverflowCheckCall<{ message: string }, never> = (operation, input, timeoutMs) => {
    calls.push({ operation, input });
    if (operation === "status") return Effect.succeed({ viewportSetting });
    if (operation === "evaluate") {
      timeouts.push(timeoutMs);
      const next = pending.shift();
      return next instanceof Error ? Effect.fail({ message: next.message }) : Effect.succeed(next);
    }
    if (operation === "navigate" && String(input.url).includes("unreachable")) {
      return Effect.fail({ message: "net::ERR_CONNECTION_REFUSED\nmore detail" });
    }
    return Effect.succeed({});
  };
  return { call, calls, timeouts };
};

describe("runOverflowCheck", () => {
  it.effect(
    "resizes through the default widths and joins the reports like browser_overflow_check",
    () =>
      Effect.gen(function* () {
        const { call, calls } = fakeBroker([
          { report: "375px: 1 overflow\n  spill    span in p  +257px right", overflows: 1 },
          { report: "768px: clean", overflows: 0 },
          { report: "1440px: 0 overflows (+1 info)\n  truncate p  +20px right", overflows: 0 },
        ]);
        const result = yield* runOverflowCheck(call, {});
        expect(calls.filter((c) => c.operation === "resize").map((c) => c.input)).toEqual([
          { mode: "freeform", width: 375, height: 900 },
          { mode: "freeform", width: 768, height: 900 },
          { mode: "freeform", width: 1440, height: 900 },
        ]);
        // Each width is measured after its resize, never before.
        expect(calls.map((c) => c.operation)).toEqual([
          "resize",
          "evaluate",
          "resize",
          "evaluate",
          "resize",
          "evaluate",
        ]);
        expect(result.overflows).toBe(1);
        expect(result.report).toBe(
          [
            "375px: 1 overflow",
            "  spill    span in p  +257px right",
            "768px: clean",
            "1440px: 0 overflows (+1 info)",
            "  truncate p  +20px right",
            "",
            '1 overflow to fix. Fix the "← cause" element, re-run, then screenshot.',
          ].join("\n"),
        );
      }),
  );

  it.effect("inlines the scanner and the listing cap into one evaluate expression", () =>
    Effect.gen(function* () {
      const { call, calls } = fakeBroker([{ report: "375px: clean", overflows: 0 }]);
      const result = yield* runOverflowCheck(call, { widths: [375], height: 700, max: 3 });
      const evaluate = calls.find((c) => c.operation === "evaluate")!.input;
      expect(evaluate.awaitPromise).toBe(true);
      expect(evaluate.expression).toBe(overflowScanExpression(3));
      expect(evaluate.expression).toContain("globalThis.__overflow = ");
      expect(evaluate.expression).toContain("__overflow.report(3)");
      expect((evaluate.expression as string).length).toBeLessThan(64_000);
      expect(calls[0]!.input).toEqual({ mode: "freeform", width: 375, height: 700 });
      expect(result.report.endsWith("No overflow. Info lines, if any, are for you to judge.")).toBe(
        true,
      );
    }),
  );

  it.effect("restores the previous viewport setting when asked", () =>
    Effect.gen(function* () {
      const fill = fakeBroker([{ report: "375px: clean", overflows: 0 }], { _tag: "fill" });
      yield* runOverflowCheck(fill.call, { widths: [375], restore: true });
      expect(fill.calls[0]!.operation).toBe("status");
      expect(fill.calls.at(-1)).toEqual({ operation: "resize", input: { mode: "fill" } });

      // A preset comes back at its size; the resize input only knows the current catalog's ids.
      const preset = fakeBroker([{ report: "375px: clean", overflows: 0 }], {
        _tag: "preset",
        presetId: "iphone-12-pro",
        width: 390,
        height: 844,
      });
      yield* runOverflowCheck(preset.call, { widths: [375], restore: true });
      expect(preset.calls.at(-1)).toEqual({
        operation: "resize",
        input: { mode: "freeform", width: 390, height: 844 },
      });

      // An older desktop reports no setting; fill is the panel's default.
      const unknown = fakeBroker([{ report: "375px: clean", overflows: 0 }]);
      yield* runOverflowCheck(unknown.call, { widths: [375], restore: true });
      expect(unknown.calls.at(-1)).toEqual({ operation: "resize", input: { mode: "fill" } });
    }),
  );

  it.effect("restores the viewport even when a scan fails", () =>
    Effect.gen(function* () {
      const broker = fakeBroker([new Error("result too large")], { _tag: "fill" });
      const result = yield* Effect.result(
        runOverflowCheck(broker.call, { widths: [375], restore: true }),
      );
      expect(result._tag).toBe("Failure");
      expect(broker.calls.at(-1)).toEqual({ operation: "resize", input: { mode: "fill" } });
    }),
  );

  it.effect("gives each evaluate a budget that covers its settle wait", () =>
    Effect.gen(function* () {
      const broker = fakeBroker([
        { report: "375px: clean", overflows: 0, status: 200 },
        { report: "768px: clean", overflows: 0, status: 200 },
      ]);
      yield* runOverflowCheck(broker.call, {
        urls: ["http://localhost:3000/"],
        widths: [375, 768],
        settle: 20_000,
      });
      expect(broker.timeouts).toEqual([15_000 + 20_400, 15_000 + 400]);
    }),
  );

  it.effect("reports a width whose scan could not be read instead of calling it clean", () =>
    Effect.gen(function* () {
      const { call } = fakeBroker(["not a scan", { report: "768px: clean", overflows: 0 }]);
      const result = yield* runOverflowCheck(call, { widths: [375, 768] });
      expect(result.overflows).toBe(0);
      expect(result.report).toContain("375px: could not read the scanner result: not a scan");
      expect(result.report).toContain("768px: clean");
      expect(result.report.endsWith("The check did not complete at every width; see above.")).toBe(
        true,
      );
    }),
  );

  it.effect("visits each url, collapses clean pages and groups the rest under their url", () =>
    Effect.gen(function* () {
      const { call, calls } = fakeBroker(
        [
          {
            report: "375px: 1 overflow\n  spill    span in p  +257px right",
            overflows: 1,
            status: 200,
          },
          { report: "1440px: clean", overflows: 0, status: 200 },
          { report: "375px: clean", overflows: 0, status: 200 },
          { report: "1440px: clean", overflows: 0, status: 200 },
          { report: "375px: clean", overflows: 0, status: 404 },
          { report: "1440px: clean", overflows: 0, status: 404 },
        ],
        { _tag: "fill" },
      );
      const result = yield* runOverflowCheck(call, {
        urls: ["http://a/bad", "http://a/ok", "http://a/missing", "http://unreachable/"],
        widths: [375, 1440],
        settle: 250,
        restore: true,
      });
      expect(calls.filter((c) => c.operation === "navigate").map((c) => c.input.url)).toEqual([
        "http://a/bad",
        "http://a/ok",
        "http://a/missing",
        "http://unreachable/",
      ]);
      // The settle wait is spent once per page, on its first width.
      const waits = calls
        .filter((c) => c.operation === "evaluate")
        .map((c) => c.input.expression === overflowScanExpression(10, 650));
      expect(waits).toEqual([true, false, true, false, true, false]);
      expect(calls.at(-1)).toEqual({ operation: "resize", input: { mode: "fill" } });
      expect(result.overflows).toBe(1);
      expect(result.report).toBe(
        [
          "http://a/bad",
          "  375px: 1 overflow",
          "    spill    span in p  +257px right",
          "  1440px: clean",
          "http://a/ok: clean",
          "http://a/missing: did not load (HTTP 404)",
          "http://unreachable/: did not load (net::ERR_CONNECTION_REFUSED)",
          "",
          '3 of 4 pages need work: 1 overflow, 2 did not load. Fix the "← cause" elements, re-run, then screenshot.',
        ].join("\n"),
      );
    }),
  );

  it.effect("says so when every page in the batch is clean", () =>
    Effect.gen(function* () {
      const { call } = fakeBroker([
        { report: "375px: clean", overflows: 0, status: 200 },
        { report: "375px: 0 overflows (+1 info)\n  truncate p  +20px right", overflows: 0 },
      ]);
      const result = yield* runOverflowCheck(call, {
        urls: ["http://a/1", "http://a/2"],
        widths: [375],
      });
      expect(result.report).toBe(
        [
          "http://a/1: clean",
          "http://a/2",
          "  375px: 0 overflows (+1 info)",
          "    truncate p  +20px right",
          "",
          "No overflow on 2 pages. Info lines, if any, are for you to judge.",
        ].join("\n"),
      );
    }),
  );
});
