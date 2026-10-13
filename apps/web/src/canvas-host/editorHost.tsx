import "@excalidraw/excalidraw/index.css";

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  hashElementsVersion,
  MainMenu,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  CanvasBinaryFile,
  CanvasDocument,
  CanvasElement,
  CanvasHostPageMessage,
  CanvasHostTheme,
} from "@t3tools/contracts";
import { storedAppState } from "@t3tools/shared/canvas";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { shrinkCanvasImage } from "../canvas/shrinkCanvasImage";
import { CanvasSync } from "../components/canvas/canvasSync";
import { NativeBridge, readNativeMessage } from "./nativeBridge";

const SAVE_DELAY_MS = 800;
// Room for Excalidraw's bottom toolbar when fitting the drawing on open.
const FIT_OFFSETS = { top: 24, right: 24, bottom: 96, left: 24 };

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

function post(message: CanvasHostPageMessage): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message));
}

const bridge = new NativeBridge(post);

function sceneOf(api: ExcalidrawImperativeAPI) {
  return {
    elements: api.getSceneElementsIncludingDeleted() as unknown as CanvasElement[],
    appState: api.getAppState() as unknown as Record<string, unknown>,
    files: api.getFiles() as unknown as Record<string, CanvasBinaryFile>,
  };
}

function signatureOf(api: ExcalidrawImperativeAPI): string {
  const stored = storedAppState(api.getAppState() as unknown as Record<string, unknown>);
  return `${hashElementsVersion(api.getSceneElementsIncludingDeleted())}:${
    Object.keys(api.getFiles()).length
  }:${JSON.stringify(stored)}`;
}

function replaceScene(api: ExcalidrawImperativeAPI, document: CanvasDocument): void {
  api.addFiles(Object.values(document.scene.files) as unknown as BinaryFileData[]);
  api.updateScene({
    elements: document.scene.elements as unknown as ExcalidrawElement[],
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

async function imageSize(dataURL: string): Promise<{ width: number; height: number } | null> {
  const image = new Image();
  image.src = dataURL;
  try {
    await image.decode();
  } catch {
    return null;
  }
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/** Adds an image in the middle of the view, at most 60% of it, and selects it. */
async function insertImage(
  api: ExcalidrawImperativeAPI,
  source: { dataURL: string; mimeType: string },
): Promise<void> {
  const file = await shrinkCanvasImage({
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
    mimeType: source.mimeType,
    dataURL: source.dataURL,
    created: Date.now(),
  });
  const size = await imageSize(file.dataURL);
  if (!size) return;
  const appState = api.getAppState();
  const zoom = appState.zoom.value;
  const viewWidth = appState.width / zoom;
  const viewHeight = appState.height / zoom;
  const scale = Math.min(1, (viewWidth * 0.6) / size.width, (viewHeight * 0.6) / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  api.addFiles([file as unknown as BinaryFileData]);
  const [element] = convertToExcalidrawElements([
    {
      type: "image",
      fileId: file.id as FileId,
      status: "saved",
      x: -appState.scrollX + viewWidth / 2 - width / 2,
      y: -appState.scrollY + viewHeight / 2 - height / 2,
      width,
      height,
    },
  ]);
  if (!element) return;
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), element],
    appState: { selectedElementIds: { [element.id]: true } },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}

type Loaded = { readonly document: CanvasDocument; readonly theme: CanvasHostTheme };

/**
 * The editor for a native WebView. It keeps the drawing and its file in step
 * with the same `CanvasSync` the web editor uses; native runs the save and
 * read RPCs it asks for and forwards changes to the file.
 */
function EditorHost() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [theme, setTheme] = useState<CanvasHostTheme>("light");
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const syncRef = useRef<CanvasSync | null>(null);
  // A change announced before the first edit created the sync.
  const pendingRevisionRef = useRef<string | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  const fittedRef = useRef(false);

  const readOnly = loaded?.document.canvas.readOnly ?? true;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = readNativeMessage(event.data);
      if (message === null || bridge.answer(message)) return;
      const api = apiRef.current;
      switch (message.type) {
        case "load":
          // Only the first document loads; the page reloads to open another.
          if (loadedRef.current !== null) return;
          loadedRef.current = { document: message.document, theme: message.theme };
          setTheme(message.theme);
          setLoaded(loadedRef.current);
          return;
        case "theme":
          setTheme(message.theme);
          return;
        case "changed":
          if (syncRef.current) {
            syncRef.current.remoteChanged(message.revision);
          } else if (loadedRef.current?.document.canvas.readOnly) {
            // Read-only files are never saved here; show the new version as is.
            void bridge.read([]).then((document) => {
              if (apiRef.current && document) replaceScene(apiRef.current, document);
            });
          } else {
            pendingRevisionRef.current = message.revision;
          }
          return;
        case "insert-image":
          if (api && !loadedRef.current?.document.canvas.readOnly) {
            void insertImage(api, message);
          }
          return;
        case "flush":
          void syncRef.current?.flush();
          return;
      }
    };
    // react-native-webview delivers to `document` on Android and `window` on iOS.
    window.addEventListener("message", onMessage);
    document.addEventListener("message", onMessage as EventListener);
    const onHide = () => void syncRef.current?.flush();
    window.addEventListener("pagehide", onHide);
    post({ type: "ready" });
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("message", onMessage as EventListener);
      window.removeEventListener("pagehide", onHide);
      syncRef.current?.dispose();
    };
  }, []);

  const handleChange = useCallback((_elements: unknown, appState: AppState) => {
    const api = apiRef.current;
    const current = loadedRef.current;
    if (!api || !current || appState.isLoading) return;
    if (!fittedRef.current) {
      fittedRef.current = true;
      // The whole drawing in view on open, never zoomed in past 100%.
      api.scrollToContent(undefined, {
        fitToViewport: true,
        viewportZoomFactor: 0.9,
        maxZoom: 1,
        animate: false,
        canvasOffsets: FIT_OFFSETS,
      });
    }
    if (current.document.canvas.readOnly) return;
    // Created on the first change after the scene loads, so loading it is
    // not mistaken for an edit.
    if (syncRef.current === null) {
      syncRef.current = new CanvasSync(
        {
          getScene: () => sceneOf(api),
          signature: () => signatureOf(api),
          apply: (elements, files) => {
            if (files.length > 0) api.addFiles(files as unknown as BinaryFileData[]);
            api.updateScene({
              elements: elements as unknown as ExcalidrawElement[],
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          },
          save: (input) => bridge.save(input),
          read: (knownFileIds) => bridge.read(knownFileIds),
          prepareFiles: (files) => Promise.all(files.map(shrinkCanvasImage)),
          onStatus: (status) => post({ type: "status", status }),
        },
        current.document,
        SAVE_DELAY_MS,
      );
      const pending = pendingRevisionRef.current;
      pendingRevisionRef.current = null;
      if (pending !== null) syncRef.current.remoteChanged(pending);
      return;
    }
    syncRef.current.noteChange();
  }, []);

  const initialData = useMemo(() => {
    if (!loaded) return null;
    const { scene, canvas } = loaded.document;
    return {
      elements: scene.elements as unknown as ExcalidrawElement[],
      appState: {
        ...scene.appState,
        name: scene.appState.name ?? canvas.title,
      } as Partial<AppState>,
      files: scene.files as unknown as BinaryFiles,
    };
  }, [loaded]);

  if (!loaded || !initialData) return null;
  return (
    <Excalidraw
      initialData={initialData}
      excalidrawAPI={(api) => {
        apiRef.current = api;
      }}
      onChange={handleChange}
      theme={theme}
      viewModeEnabled={readOnly}
      UIOptions={{
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          export: false,
          saveAsImage: false,
          toggleTheme: null,
        },
      }}
    >
      <MainMenu>
        <MainMenu.DefaultItems.SearchMenu />
        <MainMenu.DefaultItems.Help />
        {readOnly ? null : <MainMenu.DefaultItems.ClearCanvas />}
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
      </MainMenu>
    </Excalidraw>
  );
}

export function mountEditorHost(): void {
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<EditorHost />);
}
