import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useWorktreeSetup } from "./useWorktreeSetup";

vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { retryWorkspacePreparation: {} },
}));
vi.mock("../../state/vcs", () => ({ vcsEnvironment: { cancelWorktreeSetup: {} } }));
vi.mock("../../terminalUiStateStore", () => ({
  useTerminalUiStateStore: () => vi.fn(),
}));
vi.mock("./MessagesTimeline.logic", () => ({ worktreeSetupAgentStarted: () => false }));

let renderer: ReactTestRenderer | null = null;
let renders = 0;
let setup: ReturnType<typeof useWorktreeSetup>;

function Probe({ environment }: { environment: string }) {
  "use no memo";
  const current = useWorktreeSetup({
    routeThreadRef: {
      environmentId: EnvironmentId.make(environment),
      threadId: ThreadId.make("draft-thread"),
    },
    ownerKey: "draft",
    activeThread: undefined,
    threadRef: null,
    serverProjection: null,
    activityRun: null,
    localPreparing: false,
    sendQueuesBehindSetup: false,
    followUpSent: false,
  });
  useLayoutEffect(() => {
    renders += 1;
    setup = current;
  });
  return null;
}

async function render(environment: string) {
  await act(() => {
    if (renderer) renderer.update(<Probe environment={environment} />);
    else renderer = create(<Probe environment={environment} />);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renders = 0;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("worktree setup route identity", () => {
  it("settles with a freshly allocated reference to the same draft thread", async () => {
    await render("local");
    await render("local");
    expect(renders).toBe(2);
    expect(setup.worktreeSetup).toBeNull();
  });

  it("settles after changing environments with the same thread id", async () => {
    await render("local");
    await render("remote");
    expect(renders).toBeLessThan(5);
    expect(setup.worktreeSetup).toBeNull();
  });
});
