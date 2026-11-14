import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type {
  EnvironmentId,
  OrchestrationV2SubagentCount,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { useState, type SyntheticEvent } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { threadFamilies } from "../../state/threads";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Spinner } from "../ui/spinner";
import {
  buildSubagentTree,
  runningSubagentTree,
  type SubagentTreeNode,
} from "./SidebarSubagents.logic";
import type { SidebarProviderEntry } from "./SidebarThreadRow";

const TREE_ORIGIN_PX = 7;
const TREE_INDENT_PX = 14;

function SubagentProviderIcon(props: {
  readonly instanceId: string;
  readonly driver: OrchestrationV2SubagentCount["driver"];
  readonly providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  readonly className?: string | undefined;
}) {
  const entry = props.providerEntryByInstanceId.get(props.instanceId);
  return (
    <ProviderInstanceIcon
      driverKind={entry?.driverKind ?? props.driver}
      displayName={entry?.displayName ?? props.driver}
      accentColor={entry?.accentColor}
      acpRegistryAgentId={entry?.acpRegistryAgentId}
      acpRegistryIconUrl={entry?.acpRegistryIconUrl}
      size="compact"
      iconClassName={cn("size-3", props.className)}
    />
  );
}

/** The elbow and through-lines tying a nested row to its parent. */
function TreeGuides(props: { readonly guides: ReadonlyArray<boolean>; readonly last: boolean }) {
  const ownX = TREE_ORIGIN_PX + props.guides.length * TREE_INDENT_PX;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 start-0">
      {props.guides.map((through, level) =>
        through ? (
          <span
            // oxlint-disable-next-line react/no-array-index-key -- levels are positional
            key={level}
            className="absolute inset-y-0 w-px bg-muted-foreground/25"
            style={{ insetInlineStart: TREE_ORIGIN_PX + level * TREE_INDENT_PX }}
          />
        ) : null,
      )}
      <span
        className={cn(
          "absolute top-0 w-px bg-muted-foreground/25",
          props.last ? "h-1/2" : "bottom-0",
        )}
        style={{ insetInlineStart: ownX }}
      />
      <span
        className="absolute top-1/2 h-px w-1.5 bg-muted-foreground/25"
        style={{ insetInlineStart: ownX }}
      />
    </span>
  );
}

function SubagentTreeRows(props: {
  readonly nodes: ReadonlyArray<SubagentTreeNode>;
  readonly guides: ReadonlyArray<boolean>;
  readonly environmentId: EnvironmentId;
  readonly providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  readonly driverByInstanceId: ReadonlyMap<string, OrchestrationV2SubagentCount["driver"]>;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  return props.nodes.map((node, index) => {
    const last = index === props.nodes.length - 1;
    const { thread } = node;
    const working = thread.activityRunStatus != null;
    const failed = !working && thread.status === "failed";
    const title = formatSubagentDisplayTitle(thread.title.trim()) || "Subagent";
    const instanceId = thread.providerInstanceId;
    const driver =
      props.providerEntryByInstanceId.get(instanceId)?.driverKind ??
      props.driverByInstanceId.get(instanceId);
    return (
      <li key={thread.id} className="list-none">
        <button
          type="button"
          onClick={() => props.onOpen(scopeThreadRef(props.environmentId, thread.id))}
          className="relative flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm pe-1 text-left text-xs text-secondary-label outline-none hover:bg-foreground/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          style={{
            paddingInlineStart: TREE_ORIGIN_PX + (props.guides.length + 1) * TREE_INDENT_PX - 4,
          }}
        >
          <TreeGuides guides={props.guides} last={last} />
          {driver === undefined ? null : (
            <SubagentProviderIcon
              instanceId={instanceId}
              driver={driver}
              providerEntryByInstanceId={props.providerEntryByInstanceId}
              className={working ? undefined : "opacity-60"}
            />
          )}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {working ? (
            <Spinner size="xs" aria-label="Working" />
          ) : failed ? (
            <CircleAlertIcon aria-label="Failed" className="size-3 text-destructive-foreground" />
          ) : null}
        </button>
        {node.children.length > 0 ? (
          <ul>
            <SubagentTreeRows {...props} nodes={node.children} guides={[...props.guides, !last]} />
          </ul>
        ) : null}
      </li>
    );
  });
}

function SubagentTree(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rootThreadId: ThreadId;
  readonly counts: ReadonlyArray<OrchestrationV2SubagentCount>;
  readonly providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  readonly onOpen: (ref: ScopedThreadRef) => void;
}) {
  // The shell leaves idle subagents out, so the tree reads the whole family on expand.
  const family = useEnvironmentQuery(
    threadFamilies.familyAtom(props.environmentId, props.rootThreadId),
  );
  const nodes = family.data
    ? runningSubagentTree(buildSubagentTree(family.data.threads, props.threadId))
    : null;
  if (nodes === null || nodes.length === 0) {
    return (
      <p className="flex h-6 items-center gap-1.5 ps-2 text-xs text-secondary-label">
        {nodes === null ? <Spinner size="xs" /> : null}
        {nodes === null ? "Loading subagents" : "No subagents running"}
      </p>
    );
  }
  return (
    <ul aria-label="Subagents">
      <SubagentTreeRows
        nodes={nodes}
        guides={[]}
        environmentId={props.environmentId}
        providerEntryByInstanceId={props.providerEntryByInstanceId}
        driverByInstanceId={
          new Map(props.counts.map((entry) => [entry.providerInstanceId, entry.driver]))
        }
        onOpen={props.onOpen}
      />
    </ul>
  );
}

/**
 * A collapsed line under a thread row: a chevron, then one provider icon and count per
 * provider its subagents ran on. Expanding it shows the subagent threads as a tree.
 */
export function SidebarSubagents(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly rootThreadId: ThreadId;
  readonly counts: ReadonlyArray<OrchestrationV2SubagentCount>;
  readonly providerEntryByInstanceId: ReadonlyMap<string, SidebarProviderEntry>;
  readonly onOpen: (ref: ScopedThreadRef) => void;
  readonly className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = props.counts.filter((entry) => entry.active > 0);
  const total = running.reduce((sum, entry) => sum + entry.active, 0);
  if (total === 0) return null;
  // The strip sits inside the thread row, so its clicks must not also open the parent thread.
  const contain = (event: SyntheticEvent) => event.stopPropagation();
  const label = `${total} ${total === 1 ? "subagent" : "subagents"} running`;
  return (
    <div className={props.className} onClick={contain} onDoubleClick={contain}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} ${label}`}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-5 w-full cursor-pointer items-center gap-1 rounded-sm px-1 text-xs text-secondary-label outline-none hover:bg-foreground/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <span className="ms-auto inline-flex items-center gap-2 tabular-nums">
          {running.map((entry) => (
            <span
              key={`${entry.providerInstanceId}:${entry.driver}`}
              className="inline-flex items-center gap-0.5 text-sidebar-foreground"
            >
              <SubagentProviderIcon
                instanceId={entry.providerInstanceId}
                driver={entry.driver}
                providerEntryByInstanceId={props.providerEntryByInstanceId}
              />
              {entry.active}
            </span>
          ))}
        </span>
      </button>
      {expanded ? (
        <SubagentTree
          environmentId={props.environmentId}
          threadId={props.threadId}
          rootThreadId={props.rootThreadId}
          counts={props.counts}
          providerEntryByInstanceId={props.providerEntryByInstanceId}
          onOpen={props.onOpen}
        />
      ) : null}
    </div>
  );
}
