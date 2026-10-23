import type {
  OrchestrationV2AgentProgress,
  OrchestrationV2AgentProgressUpdate,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentProgressListOrder,
  applyAgentProgressUpdate,
  isAgentProgressComplete,
  summarizeAgentProgress,
} from "./agentProgress.ts";

const at = "2026-10-24T12:00:00.000Z";

function apply(
  current: OrchestrationV2AgentProgress | null,
  ...updates: ReadonlyArray<OrchestrationV2AgentProgressUpdate>
): OrchestrationV2AgentProgress | null {
  return updates.reduce<OrchestrationV2AgentProgress | null>((progress, update) => {
    const result = applyAgentProgressUpdate(progress, update, at);
    if (result._tag === "rejected") throw new Error(result.message);
    return result.progress;
  }, current);
}

const declared = apply(null, {
  title: "Fix bugs",
  items: [
    { id: "a", label: "Bug A" },
    { id: "b", label: "Bug B" },
    { id: "c", label: "Bug C" },
  ],
});

describe("applyAgentProgressUpdate", () => {
  it("declares items as pending in the order given", () => {
    expect(declared).toEqual({
      title: "Fix bugs",
      items: [
        { id: "a", label: "Bug A", status: "pending" },
        { id: "b", label: "Bug B", status: "pending" },
        { id: "c", label: "Bug C", status: "pending" },
      ],
      updatedAt: at,
    });
  });

  it("keeps the label and position of an item a call only marks", () => {
    const next = apply(declared, { items: [{ id: "b", status: "done" }] });
    expect(next?.items).toEqual([
      { id: "a", label: "Bug A", status: "pending" },
      { id: "b", label: "Bug B", status: "done" },
      { id: "c", label: "Bug C", status: "pending" },
    ]);
    expect(next?.title).toBe("Fix bugs");
  });

  it("merges out-of-order updates from different callers to the same result", () => {
    const first: OrchestrationV2AgentProgressUpdate = {
      items: [
        { id: "c", status: "done" },
        { id: "a", status: "running" },
      ],
    };
    const second: OrchestrationV2AgentProgressUpdate = {
      items: [
        { id: "b", status: "failed" },
        { id: "d", label: "Bug D", status: "running" },
      ],
    };
    const oneWay = apply(declared, first, second);
    const otherWay = apply(declared, second, first);
    expect(oneWay?.items).toEqual(otherWay?.items);
    expect(summarizeAgentProgress(oneWay)?.segments).toBe("rfdr");
  });

  it("replaces the tracker when clear and items come in one call", () => {
    const next = apply(declared, { clear: true, items: [{ id: "x" }] });
    expect(next).toEqual({
      title: "Progress",
      items: [{ id: "x", status: "pending" }],
      updatedAt: at,
    });
  });

  it("drops removed ids after applying items", () => {
    const next = apply(declared, { items: [{ id: "d" }], remove: ["a", "d", "missing"] });
    expect(next?.items.map((item) => item.id)).toEqual(["b", "c"]);
  });

  it("clears to nothing and reports no change when nothing was tracked", () => {
    expect(applyAgentProgressUpdate(declared, { clear: true }, at)).toEqual({
      _tag: "applied",
      progress: null,
      changed: true,
    });
    expect(applyAgentProgressUpdate(null, { clear: true, remove: ["a"] }, at)).toEqual({
      _tag: "applied",
      progress: null,
      changed: false,
    });
  });

  it("reports a repeated call as unchanged", () => {
    const result = applyAgentProgressUpdate(declared, { items: [{ id: "a", label: "Bug A" }] }, at);
    expect(result).toEqual({ _tag: "applied", progress: declared, changed: false });
  });

  it("rejects a call that would exceed the item cap and counts removals first", () => {
    const full = apply(null, {
      items: Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` })),
    });
    const over = applyAgentProgressUpdate(full, { items: [{ id: "extra" }] }, at);
    expect(over._tag).toBe("rejected");
    const swapped = applyAgentProgressUpdate(
      full,
      { items: [{ id: "extra" }], remove: ["item-0"] },
      at,
    );
    expect(swapped._tag === "applied" && swapped.progress?.items.length).toBe(200);
  });
});

describe("summarizeAgentProgress", () => {
  it("counts statuses and completes only when every item is terminal", () => {
    const partial = summarizeAgentProgress(
      apply(declared, {
        items: [
          { id: "a", status: "done" },
          { id: "b", status: "skipped" },
        ],
      }),
    )!;
    expect(partial).toMatchObject({ total: 3, done: 1, skipped: 1, failed: 0, segments: "dsp" });
    expect(isAgentProgressComplete(partial)).toBe(false);
    const finished = summarizeAgentProgress(
      apply(declared, {
        items: [
          { id: "a", status: "done" },
          { id: "b", status: "skipped" },
          { id: "c", status: "failed" },
        ],
      }),
    )!;
    expect(isAgentProgressComplete(finished)).toBe(true);
    expect(isAgentProgressComplete(summarizeAgentProgress(apply(null, { title: "Empty" }))!)).toBe(
      false,
    );
  });
});

describe("agentProgressListOrder", () => {
  it("lists running, failed, pending, then done", () => {
    const next = apply(declared, {
      items: [
        { id: "a", status: "done" },
        { id: "c", status: "running" },
        { id: "d", status: "failed" },
      ],
    });
    expect(agentProgressListOrder(next!.items).map((item) => item.id)).toEqual([
      "c",
      "d",
      "b",
      "a",
    ]);
  });
});
