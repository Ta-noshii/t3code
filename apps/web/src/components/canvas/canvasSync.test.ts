import type {
  CanvasBinaryFile,
  CanvasDocument,
  CanvasElement,
  CanvasSaveInput,
  CanvasSaveResult,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { CanvasSync, type CanvasSyncStatus } from "./canvasSync";

const summary = {
  path: "/repo/.canvases/arch.excalidraw",
  projectId: null,
  slug: "arch",
  title: "Arch",
  displayPath: ".canvases/arch.excalidraw",
  format: "excalidraw" as const,
  readOnly: false,
  modifiedAt: "2026-10-13T00:00:00.000Z",
  elementCount: 0,
  imageCount: 0,
};

const box = (id: string, version = 1, extra: Partial<CanvasElement> = {}): CanvasElement => ({
  id,
  type: "rectangle",
  version,
  versionNonce: version,
  ...extra,
});

const file = (id: string): CanvasBinaryFile => ({
  id,
  mimeType: "image/png",
  dataURL: "data:image/png;base64,AA==",
  created: 1,
});

const document = (
  revision: string,
  elements: CanvasElement[],
  files: Record<string, CanvasBinaryFile> = {},
): CanvasDocument => ({
  canvas: summary,
  revision,
  scene: { elements, appState: {}, files },
  omittedFileIds: [],
});

function setup(initial: CanvasDocument) {
  const editor = {
    elements: [...initial.scene.elements],
    appState: { viewBackgroundColor: "#ffffff", scrollX: 0 } as Record<string, unknown>,
    files: { ...initial.scene.files },
  };
  const saves: Omit<CanvasSaveInput, "path">[] = [];
  const reads: string[][] = [];
  const statuses: CanvasSyncStatus[] = [];
  let respond: (
    input: Omit<CanvasSaveInput, "path">,
  ) => CanvasSaveResult | null | Promise<CanvasSaveResult | null> = () => ({
    canvas: summary,
    revision: `r${saves.length}`,
    written: true,
  });
  let remote: CanvasDocument | null = null;
  const sync = new CanvasSync(
    {
      getScene: () => editor,
      signature: () =>
        JSON.stringify([
          editor.elements.map((element) => [element.id, element.version]),
          editor.appState.viewBackgroundColor,
        ]),
      apply: (elements, files) => {
        editor.elements = elements;
        for (const added of files) editor.files[added.id] = added;
      },
      save: async (input) => {
        saves.push(input);
        return respond(input);
      },
      read: async (known) => {
        reads.push(known);
        return remote;
      },
      prepareFiles: async (files) => files,
      onStatus: (status) => statuses.push(status),
    },
    initial,
    500,
  );
  return {
    editor,
    saves,
    reads,
    statuses,
    sync,
    setRemote: (next: CanvasDocument) => {
      remote = next;
    },
    respondWith: (next: typeof respond) => {
      respond = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("CanvasSync", () => {
  it("saves content changes after a quiet period and skips view-only changes", async () => {
    const test = setup(document("r0", [box("a")], { old: file("old") }));
    test.editor.appState.scrollX = 400;
    test.sync.noteChange();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(test.saves).toEqual([]);

    test.editor.elements = [box("a", 2), box("img", 1, { type: "image", fileId: "new" })];
    test.editor.files.new = file("new");
    test.sync.noteChange();
    await vi.advanceTimersByTimeAsync(300);
    test.sync.noteChange();
    await vi.advanceTimersByTimeAsync(300);
    expect(test.saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(300);
    expect(test.saves).toHaveLength(1);
    expect(test.saves[0]).toMatchObject({
      baseRevision: "r0",
      appState: { viewBackgroundColor: "#ffffff" },
      files: { new: { id: "new" } },
    });
    expect(Object.keys(test.saves[0]!.appState ?? {})).not.toContain("scrollX");
    expect(test.statuses.at(-1)).toBe("saved");

    // Its own change event does not read the file back.
    test.sync.remoteChanged("r1");
    await vi.runAllTimersAsync();
    expect(test.reads).toEqual([]);
  });

  it("brings an agent's adds, edits and deletes into a clean editor", async () => {
    const test = setup(document("r0", [box("a"), box("b"), box("gone")]));
    test.setRemote(
      document("r1", [box("a", 3), box("b"), box("new", 1, { fileId: "f" })], { f: file("f") }),
    );
    test.sync.remoteChanged("r1");
    await vi.runAllTimersAsync();
    expect(test.reads).toEqual([[]]);
    expect(test.editor.elements.map((element) => [element.id, element.version])).toEqual([
      ["a", 3],
      ["b", 1],
      ["new", 1],
    ]);
    expect(test.editor.files.f).toBeDefined();
    expect(test.saves).toEqual([]);
  });

  it("merges through the save when the user has unsaved edits", async () => {
    const test = setup(document("r0", [box("a"), box("b")]));
    test.editor.elements = [box("a", 2), box("b")];
    test.sync.noteChange();
    test.respondWith(() => ({
      canvas: summary,
      revision: "r2",
      written: true,
      merged: { elements: [box("a", 2), box("b"), box("agent")], appState: {}, files: {} },
    }));
    test.sync.remoteChanged("r1");
    await vi.runAllTimersAsync();
    expect(test.saves).toHaveLength(1);
    expect(test.reads).toEqual([]);
    expect(test.editor.elements.map((element) => element.id)).toEqual(["a", "b", "agent"]);
    expect(test.statuses.at(-1)).toBe("saved");
  });

  it("keeps edits made while a save is in flight", async () => {
    const test = setup(document("r0", [box("a")]));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    test.respondWith(async () => {
      await gate;
      return { canvas: summary, revision: `r${test.saves.length}`, written: true };
    });
    test.editor.elements = [box("a", 2)];
    test.sync.noteChange();
    const flushing = test.sync.flush();
    await vi.waitFor(() => expect(test.saves).toHaveLength(1));
    test.editor.elements = [box("a", 3)];
    test.sync.noteChange();
    release();
    await flushing;
    await vi.runAllTimersAsync();
    expect(test.saves.map((save) => [save.baseRevision, save.elements[0]!.version])).toEqual([
      ["r0", 2],
      ["r1", 3],
    ]);
  });

  it("retries a failed save", async () => {
    const test = setup(document("r0", [box("a")]));
    test.respondWith(() => null);
    test.editor.elements = [box("a", 2)];
    test.sync.noteChange();
    await vi.advanceTimersByTimeAsync(500);
    expect(test.statuses.at(-1)).toBe("error");
    test.respondWith(() => ({ canvas: summary, revision: "r1", written: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(test.saves).toHaveLength(2);
    expect(test.statuses.at(-1)).toBe("saved");
  });
});
