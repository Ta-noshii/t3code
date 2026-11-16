import { formatContextWindowCompactionMessage } from "./compaction.logic";

/**
 * Prefers the exact threshold the provider reported, then the Claude
 * instance's auto-compact window, which Claude compacts near, not at.
 */
export function formatMeterCompactionMessage(
  autoCompactThreshold: number | null | undefined,
  autoCompactWindow: number | null,
): string {
  if (
    !(typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) &&
    autoCompactWindow !== null
  ) {
    return `Compacts automatically as context nears ${autoCompactWindow.toLocaleString("en-US")} tokens.`;
  }
  return formatContextWindowCompactionMessage(autoCompactThreshold);
}

export function formatContextWindowCost(cost: {
  readonly amount: number;
  readonly currency: string;
}): string {
  const fractionDigits = Math.abs(cost.amount) > 0 && Math.abs(cost.amount) < 0.01 ? 4 : 2;
  return `${cost.currency} ${cost.amount.toFixed(fractionDigits)}`;
}

// Bounds of Claude's `autoCompactWindow` setting (CLAUDE_AUTO_COMPACT_WINDOW_PATTERN).
const AUTO_COMPACT_WINDOW_MIN = 100_000;
const AUTO_COMPACT_WINDOW_MAX = 1_000_000;
const AUTO_COMPACT_WINDOW_PRESETS = [
  100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 750_000, 1_000_000,
] as const;

export interface AutoCompactWindowOption {
  /** The stored setting value. `""` means Claude's own default. */
  readonly value: string;
  readonly label: string;
}

/** Parses a stored `autoCompactWindow` value. `""` and anything invalid read as Claude's default. */
export function parseAutoCompactWindow(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number(value.trim());
  return parsed >= AUTO_COMPACT_WINDOW_MIN && parsed <= AUTO_COMPACT_WINDOW_MAX ? parsed : null;
}

function formatAutoCompactWindowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}

/**
 * Choices for the auto-compact select: Claude's default, then the presets
 * that fit the model's context window. A window larger than the model's
 * context never triggers, so those presets are left out. A saved value that
 * is not a preset (typed in Settings) stays listed so the select can show it.
 */
export function buildAutoCompactWindowOptions(input: {
  readonly maxTokens: number | null | undefined;
  readonly current: string;
}): ReadonlyArray<AutoCompactWindowOption> {
  const maxTokens =
    typeof input.maxTokens === "number" && input.maxTokens > 0
      ? input.maxTokens
      : AUTO_COMPACT_WINDOW_MAX;
  const values = new Set<number>(
    AUTO_COMPACT_WINDOW_PRESETS.filter((preset) => preset <= maxTokens),
  );
  const current = parseAutoCompactWindow(input.current);
  if (current !== null) {
    values.add(current);
  }
  return [
    { value: "", label: "Claude default" },
    ...[...values]
      .toSorted((left, right) => left - right)
      .map((tokens) => ({ value: String(tokens), label: formatAutoCompactWindowLabel(tokens) })),
  ];
}
