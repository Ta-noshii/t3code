import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  buildAutoCompactWindowOptions,
  formatContextWindowCompactionMessage,
  formatContextWindowCost,
  parseAutoCompactWindow,
} from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import { composerFloatingLayerProps } from "./composerEventScope";
import { useClaudeAutoCompactWindow } from "./useClaudeAutoCompactWindow";

/** The provider instance whose auto-compact setting the popover edits. */
export interface ContextWindowAutoCompactTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
}

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
  /** While a turn runs, the button queues the compaction to start once the turn ends. */
  compactAfterTurn?: boolean | undefined;
  /** Shows the auto-compact choice when this is a Claude instance. */
  autoCompactTarget?: ContextWindowAutoCompactTarget | null | undefined;
}) {
  const {
    usage,
    modelDisplayName,
    onCompact,
    compactDisabled,
    compactDisabledReason,
    compactAfterTurn,
    autoCompactTarget,
  } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        // Interactive content needs a moment to move the pointer into it.
        closeDelay={onCompact || autoCompactTarget ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="size-7"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  className="stroke-muted-foreground/24"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-2xs tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">Cost</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {autoCompactTarget ? (
            <ContextWindowAutoCompactSection
              target={autoCompactTarget}
              usage={usage}
              modelDisplayName={modelDisplayName}
            />
          ) : usage.compactsAutomatically ? (
            <ContextWindowCompactionMessage>
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </ContextWindowCompactionMessage>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                {compactAfterTurn ? "Compact after this turn" : "Compact context"}
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-2xs">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ContextWindowCompactionMessage(props: { children: string }) {
  return (
    <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
      {props.children}
    </div>
  );
}

/**
 * Mounted only while the popover is open, so the settings subscription costs
 * nothing for a closed meter. Without a Claude instance it falls back to the
 * plain compaction message.
 */
function ContextWindowAutoCompactSection(props: {
  target: ContextWindowAutoCompactTarget;
  usage: ContextWindowSnapshot;
  modelDisplayName: string | null | undefined;
}) {
  const { target, usage, modelDisplayName } = props;
  const control = useClaudeAutoCompactWindow(target);
  const message = usage.compactsAutomatically ? (
    <ContextWindowCompactionMessage>
      {formatContextWindowCompactionMessage(
        modelDisplayName,
        usage.autoCompactThreshold,
        parseAutoCompactWindow(control?.value),
      )}
    </ContextWindowCompactionMessage>
  ) : null;
  if (control === null) {
    return message;
  }
  const options = buildAutoCompactWindowOptions({
    maxTokens: usage.maxTokens,
    current: control.value,
  });
  return (
    <>
      {message}
      <div className="flex items-center justify-between gap-3 text-2xs leading-4">
        <span className="text-secondary-label">Auto-compact at</span>
        <Select
          value={control.value}
          onValueChange={(next) => {
            if (typeof next === "string") control.setValue(next);
          }}
        >
          <SelectTrigger size="xs" variant="ghost" aria-label="Auto-compact at">
            <SelectValue>
              {options.find((option) => option.value === control.value)?.label ?? control.value}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup {...composerFloatingLayerProps} alignItemWithTrigger={false} align="end">
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="text-pretty text-secondary-label text-2xs">
        Takes effect when Claude starts a new session for this thread, after 30 minutes idle or a
        server restart.
      </div>
    </>
  );
}

/** Holds the meter's footprint while a thread's activities are still loading. */
export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
