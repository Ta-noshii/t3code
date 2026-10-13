import "@excalidraw/excalidraw/index.css";

import { CaptureUpdateAction, Excalidraw, hashElementsVersion } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import {
  CanvasHostMessage,
  type CanvasBinaryFile,
  type CanvasDocument,
  type CanvasElement,
} from "@t3tools/contracts";
import { mergeCanvasElements, storedAppState } from "@t3tools/shared/canvas";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

const CHANGE_DELAY_MS = 800;
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(CanvasHostMessage));

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

function post(message: CanvasHostMessage): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

function signatureOf(
  elements: readonly ExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): string {
  const stored = storedAppState(appState as unknown as Record<string, unknown>);
  return `${hashElementsVersion(elements)}:${Object.keys(files).length}:${JSON.stringify(stored)}`;
}

type Loaded = Extract<CanvasHostMessage, { type: "load" }>;

/**
 * The editor for a native WebView, speaking `CanvasHostMessage`. Native
 * sends `load`, then `update` whenever the file changes (its own saves
 * included); the page sends `change` after edits settle. Updates merge into
 * the editor by element version, so edits made while a save was in flight
 * survive the echo.
 */
function EditorHost() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const stateRef = useRef<{
    path: string;
    revision: string | null;
    base: ReadonlyArray<CanvasElement>;
    knownFileIds: Set<string>;
    sent: string;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);

  useEffect(() => {
    const adopt = (document: CanvasDocument) => {
      const state = stateRef.current;
      if (!state) return;
      state.revision = document.revision;
      state.base = document.scene.elements;
      for (const id of Object.keys(document.scene.files)) state.knownFileIds.add(id);
    };
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const message = decodeMessage(event.data);
      if (message._tag === "None") return;
      const value = message.value;
      if (value.type === "load") {
        stateRef.current = {
          path: value.document.canvas.path,
          revision: null,
          base: [],
          knownFileIds: new Set(),
          sent: "",
          timer: null,
        };
        adopt(value.document);
        setLoaded(value);
      } else if (value.type === "update") {
        const api = apiRef.current;
        const state = stateRef.current;
        if (!api || !state || value.document.canvas.path !== state.path) return;
        const merged = mergeCanvasElements({
          base: state.base,
          local: api.getSceneElementsIncludingDeleted() as unknown as CanvasElement[],
          remote: value.document.scene.elements,
        });
        const added = Object.values(value.document.scene.files).filter(
          (file) => !state.knownFileIds.has(file.id),
        );
        adopt(value.document);
        if (added.length > 0) api.addFiles(added as unknown as BinaryFileData[]);
        api.updateScene({
          elements: merged as unknown as ExcalidrawElement[],
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }
    };
    // react-native-webview delivers to `document` on Android and `window` on iOS.
    window.addEventListener("message", onMessage);
    document.addEventListener("message", onMessage as EventListener);
    post({ type: "ready" });
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("message", onMessage as EventListener);
    };
  }, []);

  const onChange = (
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const state = stateRef.current;
    if (!state || loaded?.document.canvas.readOnly || appState.isLoading) return;
    const signature = signatureOf(elements, appState, files);
    if (state.sent === "") state.sent = signature;
    if (signature === state.sent) return;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      const api = apiRef.current;
      if (!api) return;
      const scene = api.getSceneElementsIncludingDeleted();
      const current = api.getFiles();
      state.sent = signatureOf(scene, api.getAppState(), current);
      const newFiles = Object.values(current).filter((file) => !state.knownFileIds.has(file.id));
      for (const file of newFiles) state.knownFileIds.add(file.id);
      post({
        type: "change",
        path: state.path,
        baseRevision: state.revision,
        elements: scene as unknown as CanvasElement[],
        appState: storedAppState(api.getAppState() as unknown as Record<string, unknown>),
        files: Object.fromEntries(
          newFiles.map((file) => [file.id, file as unknown as CanvasBinaryFile]),
        ),
      });
    }, CHANGE_DELAY_MS);
  };

  if (!loaded) return null;
  const { scene, canvas } = loaded.document;
  return (
    <Excalidraw
      initialData={{
        elements: scene.elements as unknown as ExcalidrawElement[],
        appState: { ...scene.appState, name: canvas.title },
        files: scene.files as unknown as BinaryFiles,
      }}
      excalidrawAPI={(api) => {
        apiRef.current = api;
      }}
      onChange={onChange}
      theme={loaded.theme}
      viewModeEnabled={canvas.readOnly}
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
          toggleTheme: null,
        },
      }}
    />
  );
}

export function mountEditorHost(): void {
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<EditorHost />);
}
