import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { mergeQueuedMessages, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-01-01T${time}Z`);
const delegatedCompletion = {
  generation: 1,
  parentRunId: "run:parent",
  taskIds: ["task:child"],
};

describe("queued run delivery order", () => {
  it("delivers completions and queued messages in request order, keeping manual queue order", () => {
    const projection = {
      messages: [
        { id: "message:old" },
        { id: "message:moved" },
        { id: "message:earlier-completion", delegatedCompletion },
        { id: "message:later-completion", delegatedCompletion },
      ],
      runs: [
        {
          id: "run:old",
          ordinal: 3,
          queuePosition: 2,
          requestedAt: at("10:00:00"),
          status: "queued",
          userMessageId: "message:old",
        },
        {
          id: "run:moved",
          ordinal: 4,
          queuePosition: 1,
          requestedAt: at("10:02:00"),
          status: "queued",
          userMessageId: "message:moved",
        },
        {
          id: "run:earlier-completion",
          ordinal: 2,
          queuePosition: 3,
          requestedAt: at("09:59:00"),
          status: "queued",
          userMessageId: "message:earlier-completion",
        },
        {
          id: "run:later-completion",
          ordinal: 5,
          queuePosition: 4,
          requestedAt: at("10:03:00"),
          status: "queued",
          userMessageId: "message:later-completion",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:earlier-completion",
      "run:moved",
      "run:old",
      "run:later-completion",
    ]);
  });
});

describe("merging queued messages", () => {
  const image = (id: string) =>
    ({ type: "image", id, name: `${id}.png`, mimeType: "image/png", sizeBytes: 1 }) as const;
  const mention = (contextId: string) =>
    ({ contextId, kind: "mention", label: contextId, path: `src/${contextId}.ts` }) as never;

  it("joins texts in order with a blank line and keeps every attachment", () => {
    const merged = mergeQueuedMessages([
      { text: "First\n", attachments: [image("a")] },
      { text: "   ", attachments: [image("b")] },
      { text: "Second", attachments: [image("c"), image("a")] },
    ]);
    expect(merged.text).toBe("First\n\nSecond");
    expect(merged.attachments.map((attachment) => attachment.id)).toEqual(["a", "b", "c"]);
    expect(merged).not.toHaveProperty("context");
  });

  it("carries each message's context records once", () => {
    const merged = mergeQueuedMessages([
      { text: "One", attachments: [], context: { version: 1, records: [mention("x")] } },
      { text: "Two", attachments: [] },
      {
        text: "Three",
        attachments: [],
        context: { version: 1, records: [mention("y"), mention("x")] },
      },
    ]);
    expect(merged.context?.records.map((record) => record.contextId)).toEqual(["x", "y"]);
  });
});
