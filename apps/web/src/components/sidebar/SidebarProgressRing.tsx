import type { OrchestrationV2AgentProgressSummary } from "@t3tools/contracts";
import { agentProgressFinished } from "@t3tools/shared/agentProgress";

import { cn } from "~/lib/utils";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * A 16px ring that fills as an agent tracker's items finish, drawn in the
 * status color. Failed items get their own red arc after the finished ones,
 * so the row's status icon carries the progress and the label keeps its
 * "Working 3m" text.
 */
export function SidebarProgressRing(props: {
  summary: OrchestrationV2AgentProgressSummary;
  className?: string;
}) {
  const { summary } = props;
  const finished = agentProgressFinished(summary);
  const total = Math.max(summary.total, 1);
  const okLength = ((finished - summary.failed) / total) * CIRCUMFERENCE;
  const failedLength = (summary.failed / total) * CIRCUMFERENCE;
  return (
    <svg
      role="img"
      aria-label={`Progress ${finished} of ${summary.total}`}
      data-sidebar-progress-ring="true"
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0 -rotate-90", props.className)}
    >
      <circle
        cx="8"
        cy="8"
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="opacity-25"
      />
      {okLength > 0 ? (
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${okLength} ${CIRCUMFERENCE}`}
        />
      ) : null}
      {failedLength > 0 ? (
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          strokeWidth="2"
          strokeDasharray={`0 ${okLength} ${failedLength} ${CIRCUMFERENCE}`}
          className="stroke-destructive"
        />
      ) : null}
    </svg>
  );
}
