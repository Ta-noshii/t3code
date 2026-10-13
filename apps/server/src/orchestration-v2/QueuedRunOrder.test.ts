import { describe, expect, it } from "vite-plus/test";

import { mergeQueuedMessages, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

describe("queued run delivery order", () => {
  it("keeps automatic completion delivery ahead of visible queued messages", () => {
    const projection = {
      messages: [
        { id: "message:visible-first" },
        {
          id: "message:automatic",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message:visible-second" },
      ],
      runs: [
        {
          id: "run:visible-first",
          ordinal: 2,
          queuePosition: 1,
          status: "queued",
          userMessageId: "message:visible-first",
        },
        {
          id: "run:automatic",
          ordinal: 4,
          queuePosition: 3,
          status: "queued",
          userMessageId: "message:automatic",
        },
        {
          id: "run:visible-second",
          ordinal: 3,
          queuePosition: 2,
          status: "queued",
          userMessageId: "message:visible-second",
        },
      ],
    } as never;

    expect(queuedRunsInDeliveryOrder(projection).map((run) => run.id)).toEqual([
      "run:automatic",
      "run:visible-first",
      "run:visible-second",
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
