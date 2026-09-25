/**
 * Agents right-panel surface: the fleet view over the native subagent fold.
 * The chat carries one expandable row per spawn batch and links here.
 *
 * Visualization rules (from live-test feedback):
 * - Spawn order is stable. Activity and completion update rows in place.
 * - Agent rows reserve three fixed lines for identity, activity, and metrics;
 *   changing data must never change their height.
 * - Workflow expansion is presentation state. A live run stays expanded when
 *   it settles; older collapsed runs can still be opened at run granularity.
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 */
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  OrchestrationAgentTranscriptEntry,
  ThreadId,
} from "@t3tools/contracts";
import { ArrowLeft, Bot, Braces, Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "./ChatMarkdown";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";

/**
 * In-flight states all present as Working (one steady state, per the
 * monitoring-pill design: detail belongs in the activity sub-line, and a
 * stalled/waiting/queued subagent is still the fleet doing its job, not a
 * user problem). Only settled states differentiate.
 */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed — live-test: sky idle dots read as stuck in-progress.
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

/** Agent status line. Opens the agent's detail view. */
function AgentRow({ agent, onOpen }: { agent: RuntimeSubagent; onOpen: (id: string) => void }) {
  const visuals = STATUS_VISUALS[agent.status];
  const statusLabel =
    agent.kind === "subagent_batch" && agent.status === "idle" ? "Idle" : visuals.label;
  const activity = agentActivityText(agent);
  const live = isLiveStatus(agent.status);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const metadata = [
    modelLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);

  return (
    <button
      type="button"
      onClick={() => onOpen(agent.id)}
      aria-label={`${agent.title}, ${statusLabel}. Show details`}
      className="group grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-3xs text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-2xs text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <AgentElapsed agent={agent} />
          {agent.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : null}
          <ChevronRight
            aria-hidden
            className="size-3 text-muted-foreground/40 group-hover:text-foreground"
          />
        </span>
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        <span className={cn("font-medium", live ? "text-info-foreground" : "text-foreground/80")}>
          {statusLabel}
        </span>
        {activity ? ` · ${activity}` : null}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-2xs tabular-nums text-muted-foreground/70">
        {metadata.join(" · ")}
      </span>
    </button>
  );
}

function isLiveStatus(status: RuntimeSubagent["status"]): boolean {
  return status === "running" || status === "pending" || status === "waiting";
}

function formatClockTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function DetailFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-foreground/90 tabular-nums">{children}</dd>
    </>
  );
}

/** Text that shows its first lines until the reader asks for the rest. */
function ExpandableMarkdown({
  text,
  cwd,
  collapsedChars = 700,
}: {
  text: string;
  cwd: string | undefined;
  collapsedChars?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > collapsedChars;
  return (
    <div className="min-w-0">
      <div className={cn("relative min-w-0", long && !expanded && "max-h-40 overflow-hidden")}>
        <ChatMarkdown text={text} cwd={cwd} className="text-xs" />
        {long && !expanded ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
        ) : null}
      </div>
      {long ? (
        <Button variant="link" size="xs" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}

/** One tool call and the result the agent got back, which opens on click. */
function ToolStep({
  call,
  result,
}: {
  call: OrchestrationAgentTranscriptEntry;
  result: OrchestrationAgentTranscriptEntry | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        disabled={!result}
        className="flex w-full min-w-0 items-start gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-accent/40 disabled:hover:bg-transparent"
      >
        {open ? (
          <ChevronDown aria-hidden className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight
            aria-hidden
            className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground", !result && "opacity-0")}
          />
        )}
        <span
          className={cn(
            "shrink-0 rounded-sm border px-1 font-mono text-3xs",
            result?.isError
              ? "border-destructive/40 text-destructive-foreground"
              : "border-border/60 text-muted-foreground",
          )}
        >
          {call.toolName ?? "tool"}
        </span>
        <span className="line-clamp-2 min-w-0 break-all font-mono text-2xs text-foreground/85">
          {call.text}
        </span>
      </button>
      {open && result ? (
        <pre className="mt-1 mb-1 ml-5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border/50 bg-background/60 p-2 font-mono text-2xs text-foreground/80">
          {result.text || "(no output)"}
        </pre>
      ) : null}
    </li>
  );
}

type TranscriptStep =
  | { kind: "text"; entry: OrchestrationAgentTranscriptEntry }
  | {
      kind: "tool";
      call: OrchestrationAgentTranscriptEntry;
      result: OrchestrationAgentTranscriptEntry | undefined;
    };

/** Splits a transcript into its task, the steps in between, and the final answer. */
function splitTranscript(
  entries: ReadonlyArray<OrchestrationAgentTranscriptEntry>,
  settled: boolean,
) {
  const prompt = entries[0]?.kind === "prompt" ? entries[0] : null;
  const rest = prompt ? entries.slice(1) : entries;
  const last = rest.at(-1);
  const answer = settled && last?.kind === "text" ? last : null;
  const body = answer ? rest.slice(0, -1) : rest;
  const steps: TranscriptStep[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const entry = body[index]!;
    if (entry.kind === "tool_call") {
      const next = body[index + 1];
      const result = next?.kind === "tool_result" ? next : undefined;
      if (result) index += 1;
      steps.push({ kind: "tool", call: entry, result });
    } else if (entry.kind === "text" || entry.kind === "prompt") {
      steps.push({ kind: "text", entry });
    }
  }
  return { prompt, steps, answer };
}

const TRANSCRIPT_POLL_MS = 4_000;

/** The agent's own conversation, polled while it runs. */
function AgentTranscript({
  agent,
  environmentId,
  threadId,
  toolUseId,
  cwd,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  toolUseId: string;
  cwd: string | undefined;
}) {
  const atom = orchestrationEnvironment.agentTranscript({
    environmentId,
    input: { threadId, toolUseId },
  });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const live = isLiveStatus(agent.status);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(refresh, TRANSCRIPT_POLL_MS);
    return () => clearInterval(id);
  }, [live, refresh]);

  // One last read when the agent settles, so the final answer shows up.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) refresh();
    wasLive.current = live;
  }, [live, refresh]);

  const transcript = result._tag === "Success" ? result.value : null;
  const parts = useMemo(
    () => (transcript?.available ? splitTranscript(transcript.entries, !live) : null),
    [transcript, live],
  );

  if (result._tag === "Failure") {
    return <FallbackActivity agent={agent} note="Could not read this agent's transcript." />;
  }
  if (!transcript) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">Loading transcript…</p>;
  }
  if (!parts) {
    return (
      <FallbackActivity
        agent={agent}
        note="The transcript isn't on disk yet, or this provider doesn't keep one."
      />
    );
  }
  const toolCount = parts.steps.filter((step) => step.kind === "tool").length;
  return (
    <>
      {parts.prompt ? (
        <DetailSection title="Task">
          <ExpandableMarkdown text={parts.prompt.text} cwd={cwd} />
        </DetailSection>
      ) : null}
      {parts.answer || agent.error ? (
        <DetailSection title={agent.status === "failed" ? "Error" : "Result"}>
          {agent.status === "failed" && agent.error ? (
            <p className="text-xs text-destructive-foreground">{agent.error}</p>
          ) : null}
          {parts.answer ? (
            <ExpandableMarkdown text={parts.answer.text} cwd={cwd} collapsedChars={1_500} />
          ) : null}
        </DetailSection>
      ) : null}
      <DetailSection
        title={live ? "Steps so far" : "Steps"}
        aside={`${toolCount} tool ${toolCount === 1 ? "call" : "calls"}`}
      >
        {transcript.truncated ? (
          <p className="mb-1 text-2xs text-muted-foreground">Older steps are not shown.</p>
        ) : null}
        {parts.steps.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {live ? "Nothing yet. Steps appear as the agent works." : "No steps recorded."}
          </p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {parts.steps.map((step, index) =>
              step.kind === "tool" ? (
                <ToolStep key={index} call={step.call} result={step.result} />
              ) : (
                <li key={index} className="my-1 border-l-2 border-border/60 pl-2">
                  <ChatMarkdown text={step.entry.text} cwd={cwd} className="text-xs" />
                </li>
              ),
            )}
          </ol>
        )}
      </DetailSection>
    </>
  );
}

function DetailSection({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-border/50 px-3 py-2.5">
      <h3 className="mb-1.5 flex items-baseline gap-2 text-xs font-semibold text-foreground">
        {title}
        {aside ? (
          <span className="font-normal text-muted-foreground tabular-nums">{aside}</span>
        ) : null}
      </h3>
      {children}
    </section>
  );
}

/** What the activity stream alone says, for agents without a readable transcript. */
function FallbackActivity({ agent, note }: { agent: RuntimeSubagent; note: string }) {
  return (
    <>
      {agent.result || agent.error ? (
        <DetailSection title={agent.error ? "Error" : "Result"}>
          <p
            className={cn(
              "whitespace-pre-wrap text-xs",
              agent.error ? "text-destructive-foreground" : "text-foreground/90",
            )}
          >
            {agent.error ?? agent.result}
          </p>
        </DetailSection>
      ) : null}
      <DetailSection title="Recent activity">
        {agent.recentActivity.length === 0 ? (
          <p className="text-xs text-muted-foreground">No activity reported.</p>
        ) : (
          <ol className="flex flex-col gap-1">
            {agent.recentActivity.map((entry, index) => (
              <li key={index} className="flex gap-2 text-xs">
                <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
                  {formatClockTime(entry.at)}
                </span>
                <span className="min-w-0 break-words text-foreground/85">{entry.summary}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 text-2xs text-muted-foreground">{note}</p>
      </DetailSection>
    </>
  );
}

/** Everything known about one agent: what it was asked, what it did, what it cost. */
function AgentDetail({
  agent,
  environmentId,
  threadId,
  cwd,
  transcriptsSupported,
  onBack,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  cwd: string | undefined;
  transcriptsSupported: boolean;
  onBack: () => void;
}) {
  const visuals = STATUS_VISUALS[agent.status];
  const live = isLiveStatus(agent.status);
  const usage = agent.usage;
  const breakdown = usage
    ? [
        usage.inputTokens !== undefined
          ? `${formatSubagentTokenCount(usage.inputTokens)} in`
          : null,
        usage.cachedInputTokens !== undefined
          ? `${formatSubagentTokenCount(usage.cachedInputTokens)} cached`
          : null,
        usage.outputTokens !== undefined
          ? `${formatSubagentTokenCount(usage.outputTokens)} out`
          : null,
        usage.reasoningOutputTokens
          ? `${formatSubagentTokenCount(usage.reasoningOutputTokens)} reasoning`
          : null,
      ].filter((value): value is string => value !== null)
    : [];
  const canReadTranscript =
    transcriptsSupported && environmentId !== null && threadId !== null && agent.toolUseId !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1 border-b border-border/60 px-1.5 py-1">
        <Button size="xs" variant="ghost-muted" onClick={onBack}>
          <ArrowLeft aria-hidden className="size-3.5" />
          All agents
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-3 pt-3 pb-2.5">
          <div className="flex items-start gap-2">
            <span className="mt-1.5">
              <StatusDot status={agent.status} />
            </span>
            <h2 className="min-w-0 flex-1 text-sm font-semibold leading-snug">{agent.title}</h2>
            {agent.role ? (
              <span className="shrink-0 rounded-sm border border-border/60 px-1 font-mono text-3xs text-muted-foreground">
                {agent.role}
              </span>
            ) : null}
          </div>
          <p
            className={cn(
              "mt-1 pl-3.5 text-xs",
              live ? "text-info-foreground" : "text-muted-foreground",
            )}
          >
            {visuals.label}
            {agent.startedAt ? (
              <>
                {live ? " for " : " after "}
                <AgentElapsed agent={agent} />
              </>
            ) : null}
            {live && agent.progress ? ` · ${agent.progress}` : null}
          </p>
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
            {agent.model || agent.effort ? (
              <DetailFact label="Model">
                {formatSubagentModelLabel(agent.model, agent.effort)}
              </DetailFact>
            ) : null}
            {agent.startedAt ? (
              <DetailFact label="Started">{formatClockTime(agent.startedAt)}</DetailFact>
            ) : null}
            {agent.completedAt && !live ? (
              <DetailFact label="Finished">{formatClockTime(agent.completedAt)}</DetailFact>
            ) : null}
            <DetailFact label="Tokens">
              {usage ? formatSubagentTokenCount(usage.totalTokens) : "—"}
              {breakdown.length > 0 ? (
                <span className="text-muted-foreground"> ({breakdown.join(", ")})</span>
              ) : null}
            </DetailFact>
            {usage?.toolUses !== undefined ? (
              <DetailFact label="Tool calls">{usage.toolUses}</DetailFact>
            ) : null}
            {agent.activationCount > 1 ? (
              <DetailFact label="Runs">{agent.activationCount}</DetailFact>
            ) : null}
            {agent.phaseTitle ? <DetailFact label="Phase">{agent.phaseTitle}</DetailFact> : null}
            {agent.outputFile ? <DetailFact label="Output">{agent.outputFile}</DetailFact> : null}
          </dl>
        </div>
        {canReadTranscript ? (
          <AgentTranscript
            agent={agent}
            environmentId={environmentId}
            threadId={threadId}
            toolUseId={agent.toolUseId!}
            cwd={cwd}
          />
        ) : (
          <FallbackActivity
            agent={agent}
            note={
              transcriptsSupported
                ? "This agent has no transcript T3 can read."
                : "Update this environment to see the agent's full transcript."
            }
          />
        )}
      </ScrollArea>
    </div>
  );
}

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/**
 * Phase rail: the run's shape at a glance. One segment per phase in order,
 * separated by chevrons; each segment shows title + one dot per member.
 * The whole arc (done → live → pending) is visible without scrolling the
 * member list.
 */
function PhaseRail({ group }: { group: AgentPanelWorkflowGroup }) {
  if (group.phases.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1 pt-1.5">
      {group.phases.map((phase, index) => (
        <div key={phase.index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRight aria-hidden className="size-3 text-muted-foreground/40" />
          ) : null}
          <div
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info/40"
                : phase.state === "done"
                  ? "border-success/30"
                  : "border-border/50",
            )}
          >
            <span
              className={cn(
                "font-mono text-3xs",
                phase.state === "running"
                  ? "text-info-foreground"
                  : phase.state === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground/70",
              )}
            >
              {phase.state === "done" ? "✓ " : ""}
              {phase.title}
            </span>
            <span className="flex items-center gap-0.5">
              {phase.members.length === 0 ? (
                <span className="font-mono text-3xs text-muted-foreground/50">–</span>
              ) : (
                phase.members.map((member) => <StatusDot key={member.id} status={member.status} />)
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-3xs text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-2xs leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible phase section. A phase opens when it becomes active, then keeps
 * that shape as it settles so completion never yanks rows out from under the
 * user. Manual toggles stick until a later activation begins.
 */
function PhaseSection({
  phase,
  defaultOpen = false,
  onOpenAgent,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  defaultOpen?: boolean;
  onOpenAgent: (id: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen || phase.state === "running");
  const previousState = useRef(phase.state);

  useEffect(() => {
    if (previousState.current !== "running" && phase.state === "running") {
      setOpen(true);
    }
    previousState.current = phase.state;
  }, [phase.state]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-3xs font-medium uppercase tracking-wider hover:bg-accent/40",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        )}
        {phase.state === "done" ? <Check aria-hidden className="size-3" /> : null}
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">
          {phase.state === "pending" && phase.members.length === 0
            ? "pending"
            : phase.state === "done"
              ? `${phase.settledCount} done`
              : `${phase.activeCount} active · ${phase.settledCount} done`}
        </span>
        {!open && phase.members.length > 0 ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open
        ? phase.members.map((member) => (
            <AgentRow key={member.id} agent={member} onOpen={onOpenAgent} />
          ))
        : null}
    </div>
  );
}

/** Expanded workflow: phase rail + full phase tree. */
function ExpandedWorkflowSection({
  group,
  environmentId,
  threadId,
  onCollapse,
  onOpenAgent,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onCollapse: () => void;
  onOpenAgent: (id: string) => void;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
        <StatusDot status={group.workflow.status} />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "rounded-sm border border-border/60 px-1 font-mono normal-case hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onCollapse}
          aria-label="Collapse workflow"
        >
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </div>
      <PhaseRail group={group} />
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptOpen(false)}
        />
      ) : null}
      {group.phases.map((phase) => (
        <PhaseSection
          key={phase.index}
          phase={phase}
          defaultOpen={!workflowIsLive(group)}
          onOpenAgent={onOpenAgent}
        />
      ))}
      {group.unphasedMembers.map((member) => (
        <AgentRow key={member.id} agent={member} onOpen={onOpenAgent} />
      ))}
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
        <AgentRow agent={group.workflow} onOpen={onOpenAgent} />
      ) : null}
    </section>
  );
}

/**
 * Collapsed workflow: one summary line. The parent owns expansion so a live
 * workflow keeps its shape when it settles.
 */
function CollapsedWorkflowSection({
  group,
  onExpand,
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}) {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-expanded={false}
      >
        <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
        <span className="truncate text-sm">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-2xs text-muted-foreground/80">
          {failed > 0 ? <span className="text-destructive-foreground">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </button>
    </section>
  );
}

/** A workflow's open state is presentation state, not a status derivative. */
function WorkflowSection({
  group,
  environmentId,
  threadId,
  onOpenAgent,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onOpenAgent: (id: string) => void;
}) {
  const [open, setOpen] = useState(() => workflowIsLive(group));
  return open ? (
    <ExpandedWorkflowSection
      group={group}
      environmentId={environmentId}
      threadId={threadId}
      onCollapse={() => setOpen(false)}
      onOpenAgent={onOpenAgent}
    />
  ) : (
    <CollapsedWorkflowSection group={group} onExpand={() => setOpen(true)} />
  );
}

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  cwd,
  transcriptsSupported = false,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  /** Project root, for resolving file links in agent prompts and results. */
  cwd?: string | undefined;
  /** The environment serves `orchestration.getAgentTranscript`. */
  transcriptsSupported?: boolean;
}) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = useMemo(() => {
    if (selectedAgentId === null) return null;
    const all = [
      ...model.directAgents,
      ...model.workflows.flatMap((group) => [group.workflow, ...workflowMembers(group)]),
    ];
    return all.find((agent) => agent.id === selectedAgentId) ?? null;
  }, [model, selectedAgentId]);

  if (selectedAgent) {
    return (
      <AgentDetail
        agent={selectedAgent}
        environmentId={environmentId}
        threadId={threadId}
        cwd={cwd}
        transcriptsSupported={transcriptsSupported}
        onBack={() => setSelectedAgentId(null)}
      />
    );
  }

  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents or runs a workflow, they show up here with live status,
          activity, and token usage.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          {model.workflows.map((group) => (
            <WorkflowSection
              key={group.workflow.id}
              group={group}
              environmentId={environmentId}
              threadId={threadId}
              onOpenAgent={setSelectedAgentId}
            />
          ))}
          {model.directAgents.length > 0 ? (
            <section>
              <div className="px-1.5 pt-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground">
                Spawned by this chat
              </div>
              {model.directAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} onOpen={setSelectedAgentId} />
              ))}
            </section>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-2xs text-muted-foreground">
        <span className="flex items-center gap-2">
          {model.runningCount + model.waitingCount > 0 ? (
            <span className="text-info-foreground">
              ● {model.runningCount + model.waitingCount} working
            </span>
          ) : null}
          {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
          {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
        </span>
        <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
      </footer>
    </div>
  );
}
