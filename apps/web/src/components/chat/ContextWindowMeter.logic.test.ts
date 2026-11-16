import { describe, expect, it } from "vite-plus/test";
import {
  buildAutoCompactWindowOptions,
  formatMeterCompactionMessage,
  parseAutoCompactWindow,
} from "./ContextWindowMeter.logic";

describe("formatMeterCompactionMessage", () => {
  it("prefers the provider's exact threshold", () => {
    expect(formatMeterCompactionMessage(180_000, 300_000)).toBe(
      "Compacts automatically at about 180,000 tokens.",
    );
  });

  it("falls back to the configured window", () => {
    expect(formatMeterCompactionMessage(null, 300_000)).toBe(
      "Compacts automatically as context nears 300,000 tokens.",
    );
  });

  it("says nothing specific without either", () => {
    expect(formatMeterCompactionMessage(null, null)).toBe(
      "Context compacts automatically when needed.",
    );
  });
});

describe("parseAutoCompactWindow", () => {
  it("reads values inside the setting's range", () => {
    expect(parseAutoCompactWindow("100000")).toBe(100_000);
    expect(parseAutoCompactWindow(" 1000000 ")).toBe(1_000_000);
  });

  it("treats empty and out-of-range values as Claude's default", () => {
    expect(parseAutoCompactWindow("")).toBeNull();
    expect(parseAutoCompactWindow(undefined)).toBeNull();
    expect(parseAutoCompactWindow("99999")).toBeNull();
    expect(parseAutoCompactWindow("1000001")).toBeNull();
    expect(parseAutoCompactWindow("300k")).toBeNull();
  });
});

describe("buildAutoCompactWindowOptions", () => {
  const values = (options: ReturnType<typeof buildAutoCompactWindowOptions>) =>
    options.map((option) => option.value);

  it("offers every preset up to a 1M context window", () => {
    const options = buildAutoCompactWindowOptions({ maxTokens: 1_000_000, current: "" });
    expect(options.map((option) => option.label)).toEqual([
      "Claude default",
      "100k",
      "150k",
      "200k",
      "250k",
      "300k",
      "400k",
      "500k",
      "750k",
      "1M",
    ]);
  });

  it("leaves out presets above the model's context window", () => {
    expect(values(buildAutoCompactWindowOptions({ maxTokens: 200_000, current: "" }))).toEqual([
      "",
      "100000",
      "150000",
      "200000",
    ]);
  });

  it("offers every preset when the context window is unknown", () => {
    expect(buildAutoCompactWindowOptions({ maxTokens: null, current: "" })).toHaveLength(10);
  });

  it("keeps a saved value that is not a preset, in order", () => {
    const options = buildAutoCompactWindowOptions({ maxTokens: 200_000, current: "350000" });
    expect(values(options)).toEqual(["", "100000", "150000", "200000", "350000"]);
    expect(options.at(-1)?.label).toBe("350k");
  });
});
