import type {
  OrchestrationV2AgentProgressItemStatus,
  OrchestrationV2AgentProgressSummary,
} from "@t3tools/contracts";
import {
  type AgentProgressItem,
  agentProgressFinished,
  agentProgressListOrder,
  agentProgressSegmentStatus,
  isAgentProgressComplete,
} from "@t3tools/shared/agentProgress";
import {
  CheckIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  CircleMinusIcon,
  CircleXIcon,
  ListChecksIcon,
} from "lucide-react";
import { memo, useId, useState } from "react";

import { cn } from "~/lib/utils";
import { ComposerBanner } from "./ComposerBanner";

// Past this many items one segment per item is thinner than a few pixels.
const MAX_ITEM_SEGMENTS = 60;

const segmentColor: Record<OrchestrationV2AgentProgressItemStatus, string> = {
  done: "bg-success",
  failed: "bg-destructive",
  running: "bg-primary",
  skipped: "bg-muted-foreground/45",
  pending: "bg-muted-foreground/15",
};

const statusLabel: Record<OrchestrationV2AgentProgressItemStatus, string> = {
  done: "Done",
  failed: "Failed",
  running: "Running",
  skipped: "Skipped",
  pending: "Pending",
};

const statusIcon: Record<OrchestrationV2AgentProgressItemStatus, typeof CircleIcon> = {
  done: CircleCheckIcon,
  failed: CircleXIcon,
  running: CircleDotIcon,
  skipped: CircleMinusIcon,
  pending: CircleIcon,
};

const statusIconColor: Record<OrchestrationV2AgentProgressItemStatus, string> = {
  done: "text-success",
  failed: "text-destructive",
  running: "text-primary",
  skipped: "text-muted-foreground/60",
  pending: "text-muted-foreground/40",
};

function ProgressBar({ summary }: { readonly summary: OrchestrationV2AgentProgressSummary }) {
  if (summary.total === 0) {
    return <span className="block h-1 rounded-full bg-muted-foreground/15" />;
  }
  if (summary.total <= MAX_ITEM_SEGMENTS) {
    return (
      <span className="flex h-1 gap-px">
        {Array.from(summary.segments, (segment, index) => (
          <span
            // The tracker keeps item order, so a position is a stable key.
            key={index}
            className={cn(
              "min-w-0 flex-1 rounded-full transition-colors duration-200",
              segmentColor[agentProgressSegmentStatus(segment)],
            )}
          />
        ))}
      </span>
    );
  }
  const pending = summary.total - agentProgressFinished(summary) - summary.running;
  const parts = [
    ["done", summary.done],
    ["failed", summary.failed],
    ["skipped", summary.skipped],
    ["running", summary.running],
    ["pending", pending],
  ] as const;
  return (
    <span className="flex h-1 overflow-hidden rounded-full">
      {parts.map(([status, count]) => (
        <span
          key={status}
          className={cn("h-full transition-[width] duration-300 ease-out", segmentColor[status])}
          style={{ width: `${(count / summary.total) * 100}%` }}
        />
      ))}
    </span>
  );
}

/**
 * The agent-controlled progress tracker, shown in the composer banner stack.
 * The header and bar come from the shell summary; the item list needs the
 * thread detail, so it is only offered once `items` is loaded.
 */
export const AgentProgressStrip = memo(function AgentProgressStrip({
  summary,
  items,
  dismissDisabled,
  onDismiss,
}: {
  readonly summary: OrchestrationV2AgentProgressSummary;
  readonly items: ReadonlyArray<AgentProgressItem> | null;
  readonly dismissDisabled: boolean;
  readonly onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const complete = isAgentProgressComplete(summary);
  const finished = agentProgressFinished(summary);
  const canExpand = items !== null && items.length > 0;
  const showList = expanded && canExpand;
  const countLabel = complete
    ? `${summary.total}/${summary.total} done`
    : `${finished}/${summary.total}`;

  return (
    <div data-chat-composer-collapsed-controls="true">
      <div className="flex min-w-0 items-start gap-1">
        <ComposerBanner.Row
          render={<button type="button" disabled={!canExpand} />}
          className="min-w-0 flex-1 gap-y-1 pb-1 disabled:cursor-default"
          aria-expanded={canExpand ? showList : undefined}
          aria-controls={canExpand ? listId : undefined}
          aria-label={`${summary.title}: ${finished} of ${summary.total} finished${summary.failed > 0 ? `, ${summary.failed} failed` : ""}${summary.running > 0 ? `, ${summary.running} running` : ""}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setExpanded((value) => !value)}
        >
          <ComposerBanner.Icon className={complete ? "text-success" : undefined}>
            {complete ? <CheckIcon /> : <ListChecksIcon />}
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="min-w-0 truncate font-medium">{summary.title}</span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions className="flex-nowrap">
            {summary.failed > 0 ? (
              <span className="whitespace-nowrap text-destructive tabular-nums">
                {summary.failed} failed
              </span>
            ) : null}
            <span
              className={cn(
                "whitespace-nowrap font-medium tabular-nums",
                complete ? "text-success" : "text-muted-foreground",
              )}
            >
              {countLabel}
            </span>
            {canExpand ? <ComposerBanner.ToggleIcon expanded={showList} /> : null}
          </ComposerBanner.Actions>
          <span aria-hidden className="col-start-2 col-end-4 row-start-2 block pe-1">
            <ProgressBar summary={summary} />
          </span>
        </ComposerBanner.Row>
        <ComposerBanner.Dismiss
          aria-label="Dismiss progress"
          disabled={dismissDisabled}
          onClick={onDismiss}
        />
      </div>
      {showList ? (
        <ComposerBanner.Scroll className="max-h-48">
          <ComposerBanner.Children render={<ul role="list" />} id={listId}>
            {agentProgressListOrder(items).map((item) => {
              const Icon = statusIcon[item.status];
              return (
                <ComposerBanner.Row
                  key={item.id}
                  render={<li />}
                  className="items-start py-0.5 pe-2"
                >
                  <ComposerBanner.Icon className={cn("h-4", statusIconColor[item.status])}>
                    <Icon />
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content
                    className={cn(
                      "block wrap-anywhere",
                      item.status === "done" || item.status === "skipped"
                        ? "text-muted-foreground/60"
                        : "text-foreground/90",
                    )}
                  >
                    <span className="sr-only">{statusLabel[item.status]}: </span>
                    {item.label ?? item.id}
                  </ComposerBanner.Content>
                </ComposerBanner.Row>
              );
            })}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      ) : null}
    </div>
  );
});
