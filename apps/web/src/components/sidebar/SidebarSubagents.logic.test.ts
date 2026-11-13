import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vitest";

import { buildSubagentTree, type SubagentTreeNode } from "./SidebarSubagents.logic";

const shell = (
  id: string,
  parent: string | null,
  createdMs: number,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) =>
  ({
    id: ThreadId.make(id),
    lineage: {
      parentThreadId: parent === null ? null : ThreadId.make(parent),
      relationshipToParent: parent === null ? null : "subagent",
      rootThreadId: ThreadId.make("root"),
    },
    createdAt: DateTime.makeUnsafe(createdMs),
    deletedAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const ids = (nodes: ReadonlyArray<SubagentTreeNode>): unknown =>
  nodes.map((node) =>
    node.children.length === 0 ? node.thread.id : [node.thread.id, ids(node.children)],
  );

describe("buildSubagentTree", () => {
  it("nests subagents under the thread, oldest first, without forks or deleted threads", () => {
    const threads = [
      shell("root", null, 0),
      shell("late", "root", 30),
      shell("early", "root", 10),
      shell("nested", "early", 20),
      shell("deleted", "root", 15, { deletedAt: DateTime.makeUnsafe(40) }),
      shell("fork", "root", 5, {
        lineage: {
          parentThreadId: ThreadId.make("root"),
          relationshipToParent: "fork",
          rootThreadId: ThreadId.make("root"),
        },
      }),
    ];
    expect(ids(buildSubagentTree(threads, ThreadId.make("root")))).toEqual([
      ["early", ["nested"]],
      "late",
    ]);
  });

  it("starts from a subagent's own children when the row is a subagent", () => {
    const threads = [shell("a", "root", 1), shell("b", "a", 2)];
    expect(ids(buildSubagentTree(threads, ThreadId.make("a")))).toEqual(["b"]);
  });

  it("stops at a lineage cycle", () => {
    const threads = [shell("a", "b", 1), shell("b", "a", 2), shell("c", "root", 3)];
    expect(ids(buildSubagentTree(threads, ThreadId.make("root")))).toEqual(["c"]);
  });
});
