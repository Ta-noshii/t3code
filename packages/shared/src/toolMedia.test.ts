import { describe, expect, it } from "vite-plus/test";

import { base64DecodedByteLength, boundToolMedia, toolImageFromValue } from "./toolMedia.ts";

describe("toolImageFromValue", () => {
  it.each([
    [{ type: "image", data: "AAAA", mimeType: "image/png" }, "image/png"],
    [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      "image/jpeg",
    ],
    [{ type: "image", file: { base64: "AAAA", type: "image/webp" } }, "image/webp"],
    ["data:image/gif;base64,AAAA", "image/gif"],
  ])("normalizes provider shape %#", (value, mimeType) => {
    expect(toolImageFromValue(value)).toMatchObject({ type: "image", mimeType, data: "AAAA" });
  });

  it("ignores non-images", () => {
    expect(toolImageFromValue({ type: "text", text: "hi" })).toBeUndefined();
    expect(toolImageFromValue("data:text/plain;base64,AAAA")).toBeUndefined();
    expect(toolImageFromValue({ type: "image" })).toBeUndefined();
  });
});

describe("boundToolMedia", () => {
  it("spends the inline budget in order and drops data after it", () => {
    const image = (data: string) => ({ type: "image", data, mimeType: "image/png" });
    const bounded = boundToolMedia({ content: [image("A".repeat(8)), image("B".repeat(8))] }, 12);
    expect(bounded).toEqual({
      content: [
        { type: "image", mimeType: "image/png", data: "A".repeat(8), byteLength: 6 },
        { type: "image", mimeType: "image/png", byteLength: 6, dataOmitted: true },
      ],
    });
  });

  it("returns values without images unchanged", () => {
    const value = { a: [1, { b: "c" }] };
    expect(boundToolMedia(value, 0)).toBe(value);
  });

  it("is stable when applied to its own output", () => {
    const once = boundToolMedia({ type: "image", data: "AAAA", mimeType: "image/png" }, 0);
    expect(boundToolMedia(once, 0)).toEqual(once);
  });
});

it("measures decoded base64 length", () => {
  expect(base64DecodedByteLength("iVBORw0KGgo=")).toBe(8);
  expect(base64DecodedByteLength("AA==")).toBe(1);
});
