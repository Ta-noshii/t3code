import { describe, expect, it } from "vite-plus/test";

import {
  decideProgressPush,
  PROGRESS_PUSH_INTERVAL_MS,
  type ProgressPushRow,
} from "./progressPushThrottle.ts";

const row = (
  key: string,
  completed: number,
  patch: Partial<ProgressPushRow & { phase: string }> = {},
) => ({
  key,
  total: 50,
  completed,
  status: `Migrate · ${completed}/50`,
  phase: "working",
  ...patch,
});

describe("decideProgressPush", () => {
  it("defers a count-only change inside the interval and sends it once due", () => {
    const last = new Map([["a", 1_000]]);
    expect(decideProgressPush([row("a", 1)], [row("a", 2)], last, 3_000)).toEqual({
      kind: "defer",
      untilMs: 1_000 + PROGRESS_PUSH_INTERVAL_MS,
    });
    expect(
      decideProgressPush([row("a", 1)], [row("a", 3)], last, 1_000 + PROGRESS_PUSH_INTERVAL_MS),
    ).toEqual({ kind: "send", progressKeys: ["a"] });
  });

  it("sends the first count change for a thread at once", () => {
    expect(decideProgressPush([row("a", 1)], [row("a", 2)], new Map(), 0)).toEqual({
      kind: "send",
      progressKeys: ["a"],
    });
  });

  it("throttles each thread on its own clock", () => {
    const last = new Map([["a", 9_000]]);
    expect(
      decideProgressPush([row("a", 1), row("b", 1)], [row("a", 1), row("b", 2)], last, 10_000),
    ).toEqual({ kind: "send", progressKeys: ["b"] });
    expect(
      decideProgressPush([row("a", 1), row("b", 1)], [row("a", 2), row("b", 2)], last, 10_000),
    ).toEqual({ kind: "defer", untilMs: 9_000 + PROGRESS_PUSH_INTERVAL_MS });
  });

  it("sends other changes at once, even with a count change inside the interval", () => {
    const last = new Map([["a", 1_000]]);
    expect(
      decideProgressPush([row("a", 1)], [row("a", 2, { phase: "attention" })], last, 1_500),
    ).toEqual({ kind: "send", progressKeys: ["a"] });
    expect(decideProgressPush([row("a", 1)], [row("a", 1), row("b", 0)], last, 1_500)).toEqual({
      kind: "send",
      progressKeys: [],
    });
    expect(
      decideProgressPush(
        [row("a", 1)],
        [row("a", 0, { total: 0, status: "Agent is working" })],
        last,
        1_500,
      ),
    ).toEqual({ kind: "send", progressKeys: [] });
  });

  it("reports unchanged rows", () => {
    expect(decideProgressPush([row("a", 1)], [row("a", 1)], new Map(), 0)).toEqual({
      kind: "unchanged",
    });
  });
});
