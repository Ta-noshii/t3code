import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

export interface SubagentTreeNode {
  readonly thread: OrchestrationV2ThreadShell;
  readonly children: ReadonlyArray<SubagentTreeNode>;
}

/**
 * The subagent threads under `parentThreadId`, nested by lineage, oldest first. A thread
 * family holds every thread sharing a root, so forks and side chats are left out here.
 */
export function buildSubagentTree(
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  parentThreadId: ThreadId,
): ReadonlyArray<SubagentTreeNode> {
  const byParent = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  for (const thread of threads) {
    const { parentThreadId: parent, relationshipToParent } = thread.lineage;
    if (parent === null || relationshipToParent !== "subagent" || thread.deletedAt != null) {
      continue;
    }
    const siblings = byParent.get(parent);
    if (siblings) siblings.push(thread);
    else byParent.set(parent, [thread]);
  }
  // Guards against a lineage cycle in a corrupt family.
  const seen = new Set<ThreadId>([parentThreadId]);
  const childrenOf = (id: ThreadId): SubagentTreeNode[] => {
    const nodes: SubagentTreeNode[] = [];
    const siblings = (byParent.get(id) ?? []).toSorted(
      (a, b) => a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds,
    );
    for (const thread of siblings) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      nodes.push({ thread, children: childrenOf(thread.id) });
    }
    return nodes;
  };
  return childrenOf(parentThreadId);
}

/** Keeps running subagents, and finished ones only while a running subagent sits below them. */
export function runningSubagentTree(
  nodes: ReadonlyArray<SubagentTreeNode>,
): ReadonlyArray<SubagentTreeNode> {
  const kept: SubagentTreeNode[] = [];
  for (const node of nodes) {
    const children = runningSubagentTree(node.children);
    if (node.thread.activityRunStatus != null || children.length > 0) {
      kept.push({ thread: node.thread, children });
    }
  }
  return kept;
}
