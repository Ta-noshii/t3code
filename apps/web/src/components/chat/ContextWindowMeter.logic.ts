import type { ModelSelection, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
  isClaudeResumeCompactionQuestion,
} from "@t3tools/shared/claudeCompaction";
import {
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { getTriggerDisplayModelName, type ModelEsque } from "./providerIconUtils";

const CLAUDE_RESUME_COMPACTION_MINUTES = 70;
const CLAUDE_RESUME_COMPACTION_TOKENS = 100_000;

export function providerSupportsManualCompaction(
  provider: ProviderInstanceEntry | null | undefined,
): boolean {
  return provider?.snapshot.slashCommands.some((command) => command.name === "compact") ?? false;
}

export function hasAvailableCompactionProvider(input: {
  readonly providers: ReadonlyArray<ProviderInstanceEntry>;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly lockedInstanceId: ProviderInstanceId | null;
}): boolean {
  const driverProviders = input.providers.filter(
    (provider) => provider.driverKind === input.driverKind,
  );
  const lockedContinuationGroupKey = input.lockedInstanceId
    ? driverProviders.find((provider) => provider.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey
    : undefined;
  const compatibleProviders = lockedContinuationGroupKey
    ? driverProviders.filter(
        (provider) => provider.continuationGroupKey === lockedContinuationGroupKey,
      )
    : driverProviders;

  return providerSupportsManualCompaction(
    resolveSelectableProviderInstanceEntry(compatibleProviders, input.instanceId ?? undefined),
  );
}

export function hasDismissedResumeCompaction(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): boolean {
  return activities.some((activity) => {
    if (activity.kind !== "user-input.resolved") return false;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object") return false;
    const answers = (payload as { readonly answers?: unknown }).answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false;

    return Object.entries(answers).some(
      ([question, answer]) =>
        isClaudeResumeCompactionQuestion(question) &&
        answer === CLAUDE_RESUME_COMPACTION_NEVER_ANSWER,
    );
  });
}

export function shouldOfferResumeCompaction(input: {
  readonly provider: string | null | undefined;
  readonly usedTokens: number | null | undefined;
  readonly updatedAt: string | null | undefined;
  readonly now: string;
}): boolean {
  if (
    input.provider !== "claudeAgent" ||
    (input.usedTokens ?? 0) < CLAUDE_RESUME_COMPACTION_TOKENS
  ) {
    return false;
  }

  const updatedAt = Date.parse(input.updatedAt ?? "");
  const now = Date.parse(input.now);
  return (
    Number.isFinite(updatedAt) &&
    Number.isFinite(now) &&
    now - updatedAt >= CLAUDE_RESUME_COMPACTION_MINUTES * 60_000
  );
}

export function resolveContextWindowModelDisplayName(
  selection: ModelSelection | null | undefined,
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): string | null {
  if (!selection) {
    return null;
  }

  const selectedModel = modelOptionsByInstance
    .get(selection.instanceId)
    ?.find((model) => model.slug === selection.model);

  return selectedModel ? getTriggerDisplayModelName(selectedModel) : selection.model;
}

/**
 * @param autoCompactThreshold The exact threshold the provider reported, if any.
 * @param autoCompactWindow The Claude instance's configured auto-compact window.
 *   Claude compacts as the context nears it, so it is not an exact threshold.
 */
export function formatContextWindowCompactionMessage(
  modelDisplayName: string | null | undefined,
  autoCompactThreshold?: number | null,
  autoCompactWindow?: number | null,
): string {
  if (typeof autoCompactThreshold === "number" && autoCompactThreshold > 0) {
    return `Compacts automatically at ${autoCompactThreshold.toLocaleString("en-US")} tokens.`;
  }
  if (typeof autoCompactWindow === "number" && autoCompactWindow > 0) {
    return `Compacts automatically as context nears ${autoCompactWindow.toLocaleString("en-US")} tokens.`;
  }
  return modelDisplayName
    ? `Context for ${modelDisplayName} compacts automatically when needed.`
    : "Context compacts automatically when needed.";
}

/**
 * Whether the footer should hold the meter's slot before a snapshot exists.
 *
 * The snapshot comes from thread activities, which load after the shell.
 * Reserving the slot while the detail loads, for a started thread, keeps the
 * attach button still until the meter mounts. Once the detail is in, a
 * missing snapshot means there is no usage to show and nothing is reserved.
 *
 * The meter renders from stored activities whatever the provider's state, so
 * only a provider known not to stream usage skips the reservation. An unknown
 * provider (catalog still loading, or the thread's provider disabled) reserves.
 */
export function shouldReserveContextWindowMeter(input: {
  readonly meterEnabled: boolean;
  readonly detailLoading: boolean;
  readonly threadStarted: boolean;
  /** `null` while the thread's provider is not in the catalog. */
  readonly providerReportsContextWindow: boolean | null;
}): boolean {
  return (
    input.meterEnabled &&
    input.detailLoading &&
    input.threadStarted &&
    input.providerReportsContextWindow !== false
  );
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
  100_000, 150_000, 200_000, 300_000, 400_000, 500_000, 750_000, 1_000_000,
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
