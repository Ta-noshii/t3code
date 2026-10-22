import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import type { TimelineEntriesInput, TimelineEntry } from "../session-logic";
import { makeStreamingTimelineFixture } from "../test-fixtures";
import { useIncrementalTimelineEntries } from "./useIncrementalTimelineEntries";

let renderer: ReactTestRenderer | null = null;
let entries: TimelineEntry[];
let renders = 0;
let visibleTurnItems: TimelineEntriesInput["visibleTurnItems"] = [];
let anchoredMessages: NonNullable<TimelineEntriesInput["anchoredMessages"]> = [];

function Probe({ threadKey }: { threadKey: string }) {
  "use no memo";
  // ChatView can supply newly derived arrays and maps on every render.
  const input: TimelineEntriesInput = {
    visibleTurnItems: [...visibleTurnItems],
    optimisticMessages: [],
    anchoredMessages: anchoredMessages.map((message) => ({ ...message })),
    attachmentUrlById: new Map(),
  };
  const current = useIncrementalTimelineEntries(threadKey, input);
  useLayoutEffect(() => {
    renders += 1;
    entries = current;
  });
  return null;
}

async function render(threadKey: string) {
  await act(() => {
    if (renderer) renderer.update(<Probe threadKey={threadKey} />);
    else renderer = create(<Probe threadKey={threadKey} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renders = 0;
  visibleTurnItems = [];
  anchoredMessages = [];
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("incremental timeline rendering", () => {
  it("settles when a draft rerenders with fresh empty collections", async () => {
    await render("draft");
    const initial = entries;
    await render("draft");
    expect(entries).toEqual([]);
    expect(entries).toBe(initial);
    expect(renders).toBe(2);
  });

  it("settles when switching to a different draft", async () => {
    await render("first");
    await render("second");
    expect(entries).toEqual([]);
    expect(renders).toBe(2);
  });

  it("updates streaming text while preserving unchanged history rows", async () => {
    const initial = makeStreamingTimelineFixture("Hello");
    visibleTurnItems = initial.visibleTurnItems;
    await render("thread");
    const history = entries[0];
    const updated = makeStreamingTimelineFixture("Hello world");
    visibleTurnItems = initial.visibleTurnItems.map((row, index) =>
      index === initial.visibleTurnItems.length - 1 ? updated.visibleTurnItems[index]! : row,
    );
    await render("thread");
    expect(entries[0]).toBe(history);
    expect(entries.at(-1)).toMatchObject({ message: { text: "Hello world" } });
    visibleTurnItems = [];
    await render("draft");
    expect(entries).toEqual([]);
    expect(renders).toBe(3);
  });

  it("accepts recreated feedback messages and still displays their updates", async () => {
    const message = {
      id: MessageId.make("feedback"),
      role: "assistant" as const,
      text: "Sending feedback...",
      runId: null,
      streaming: false,
      createdAt: "2026-10-22T20:40:00Z",
      updatedAt: "2026-10-22T20:40:00Z",
    };
    anchoredMessages = [message];
    await render("thread");
    const initial = entries;
    await render("thread");
    expect(entries).toBe(initial);
    anchoredMessages = [{ ...message, text: "Feedback sent" }];
    await render("thread");
    expect(entries.at(-1)).toMatchObject({ message: { text: "Feedback sent" } });
  });
});
