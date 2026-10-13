import "@excalidraw/excalidraw/index.css";
import "./canvasEditor.css";

import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  WelcomeScreen,
  getVisibleSceneBounds,
  hashElementsVersion,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
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
  CanvasEvent,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { canvasElementBounds, storedAppState, unionCanvasRects } from "@t3tools/shared/canvas";
import * as Schema from "effect/Schema";
import { ChevronLeftIcon, HighlighterIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { configureExcalidrawAssets } from "~/canvas/excalidrawAssets";
import { fitCanvasScene } from "~/canvas/fitScene";
import { shrinkCanvasImage } from "~/canvas/shrinkCanvasImage";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useTheme } from "~/hooks/useTheme";
import { canvasEnvironment } from "~/state/canvas";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CanvasSync, type CanvasSyncStatus } from "./canvasSync";
import { useCanvasEvents } from "./useCanvasEvents";

configureExcalidrawAssets(window.location.origin);

const SAVE_DELAY_MS = 800;
const HIGHLIGHT_STORAGE_KEY = "t3code:canvas:highlight-agent-changes";

export interface CanvasEditorProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
  readonly onBack: () => void;
}

/** One canvas in the Excalidraw editor, saved as you draw and kept in step with the file. */
export default function CanvasEditor(props: CanvasEditorProps) {
  const read = useAtomCommand(canvasEnvironment.read, { reportFailure: false });
  const [loaded, setLoaded] = useState<
    { readonly document: CanvasDocument } | { readonly error: string } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void read({
      environmentId: props.environmentId,
      input: { canvas: { path: props.path, projectId: props.projectId } },
    }).then((result) => {
      if (cancelled) return;
      setLoaded(
        result._tag === "Success"
          ? { document: result.value }
          : { error: formatEnvironmentQueryError(result.cause) },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [props.environmentId, props.path, props.projectId, read]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {loaded !== null && "document" in loaded ? (
        <CanvasEditorSurface {...props} initial={loaded.document} />
      ) : (
        <>
          <CanvasToolbar title="" subtitle={props.path} onBack={props.onBack} />
          {loaded !== null ? (
            <p className="p-4 text-xs text-muted-foreground">{loaded.error}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

function CanvasToolbar(props: {
  title: string;
  subtitle: string;
  onBack: () => void;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/60 px-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="All canvases"
              onClick={props.onBack}
            />
          }
        >
          <ChevronLeftIcon />
        </TooltipTrigger>
        <TooltipPopup>All canvases</TooltipPopup>
      </Tooltip>
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-sm font-medium">{props.title}</span>
        <span className="min-w-0 truncate text-2xs text-muted-foreground max-sm:hidden">
          {props.subtitle}
        </span>
      </div>
      {props.children}
    </header>
  );
}

function CanvasEditorSurface(props: CanvasEditorProps & { readonly initial: CanvasDocument }) {
  const { initial } = props;
  const readOnly = initial.canvas.readOnly;
  const { resolvedTheme } = useTheme();
  const read = useAtomCommand(canvasEnvironment.read, { reportFailure: false });
  const save = useAtomCommand(canvasEnvironment.save, { reportFailure: false });
  const [status, setStatus] = useState<CanvasSyncStatus>("saved");
  const [highlight, setHighlight] = useLocalStorage(HIGHLIGHT_STORAGE_KEY, true, Schema.Boolean);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const syncRef = useRef<CanvasSync | null>(null);
  const closedRef = useRef(false);
  const pendingHighlightRef = useRef<ReadonlyArray<string> | null>(null);
  const highlightRef = useRef(highlight);
  const fittedRef = useRef(false);
  useEffect(() => {
    highlightRef.current = highlight;
  }, [highlight]);

  const initialData = useMemo(
    () => ({
      elements: initial.scene.elements as unknown as ExcalidrawElement[],
      appState: {
        ...initial.scene.appState,
        name: initial.scene.appState.name ?? initial.canvas.title,
      } as Partial<AppState>,
      files: initial.scene.files as unknown as BinaryFiles,
      scrollToContent: true,
    }),
    [initial],
  );

  const readLatest = useCallback(
    async (knownFileIds: string[]) => {
      const result = await read({
        environmentId: props.environmentId,
        input: { canvas: { path: props.path }, knownFileIds },
      });
      return result._tag === "Success" ? result.value : null;
    },
    [props.environmentId, props.path, read],
  );

  // Selects what an agent just changed, and brings it into view when none of
  // it is visible. Skipped while the user has a selection or is typing.
  const showHighlight = useCallback((api: ExcalidrawImperativeAPI) => {
    const ids = pendingHighlightRef.current;
    pendingHighlightRef.current = null;
    if (!ids || !highlightRef.current) return;
    const appState = api.getAppState();
    if (Object.keys(appState.selectedElementIds).length > 0 || appState.editingTextElement) return;
    const targets = api
      .getSceneElements()
      .filter((element) => ids.includes(element.id) && !element.isDeleted);
    if (targets.length === 0) return;
    api.updateScene({
      appState: {
        selectedElementIds: Object.fromEntries(targets.map((element) => [element.id, true])),
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const bounds = unionCanvasRects(
      targets.flatMap((element) => {
        const rect = canvasElementBounds(element as unknown as CanvasElement);
        return rect ? [rect] : [];
      }),
    );
    const [minX, minY, maxX, maxY] = getVisibleSceneBounds(appState);
    const visible =
      bounds !== null &&
      bounds.x < maxX &&
      bounds.x + bounds.width > minX &&
      bounds.y < maxY &&
      bounds.y + bounds.height > minY;
    if (!visible) api.scrollToContent(targets, { fitToContent: false, animate: false });
  }, []);

  const startSync = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      const live = () => ({
        elements: api.getSceneElementsIncludingDeleted() as unknown as CanvasElement[],
        appState: api.getAppState() as unknown as Record<string, unknown>,
        files: api.getFiles() as unknown as Record<string, CanvasBinaryFile>,
      });
      return new CanvasSync(
        {
          getScene: live,
          signature: () =>
            `${hashElementsVersion(api.getSceneElementsIncludingDeleted())}:${
              Object.keys(api.getFiles()).length
            }:${JSON.stringify(storedAppState(api.getAppState() as unknown as Record<string, unknown>))}`,
          apply: (elements, files) => {
            if (closedRef.current) return;
            if (files.length > 0) api.addFiles(files as unknown as BinaryFileData[]);
            api.updateScene({
              elements: elements as unknown as ExcalidrawElement[],
              captureUpdate: CaptureUpdateAction.NEVER,
            });
            showHighlight(api);
          },
          save: async (input) => {
            const result = await save({
              environmentId: props.environmentId,
              input: { path: props.path, ...input },
            });
            return result._tag === "Success" ? result.value : null;
          },
          read: readLatest,
          prepareFiles: (files) => Promise.all(files.map(shrinkCanvasImage)),
          onStatus: setStatus,
        },
        initial,
        SAVE_DELAY_MS,
      );
    },
    [initial, props.environmentId, props.path, readLatest, save, showHighlight],
  );

  const handleChange = useCallback(
    (_elements: unknown, appState: AppState) => {
      const api = apiRef.current;
      if (!api || appState.isLoading) return;
      if (!fittedRef.current) {
        fittedRef.current = true;
        fitCanvasScene(api);
      }
      if (readOnly) return;
      // Created on the first change after the scene loads, so loading it is
      // not mistaken for an edit.
      if (syncRef.current === null) {
        syncRef.current = startSync(api);
        return;
      }
      syncRef.current.noteChange();
    },
    [readOnly, startSync],
  );

  useEffect(() => {
    const onPageHide = () => void syncRef.current?.flush();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void syncRef.current?.close().finally(() => {
        closedRef.current = true;
      });
    };
  }, []);

  useCanvasEvents(
    props.environmentId,
    useCallback(
      (event: CanvasEvent) => {
        if (event.type !== "changed" || event.path !== props.path) return;
        if (event.source === "agent" && event.elementIds && event.elementIds.length > 0) {
          pendingHighlightRef.current = event.elementIds;
        }
        if (syncRef.current) {
          syncRef.current.remoteChanged(event.revision);
          return;
        }
        // Read-only files are never saved here; show the new version as is.
        if (readOnly) {
          void readLatest(Object.keys(apiRef.current?.getFiles() ?? {})).then((document) => {
            const api = apiRef.current;
            if (!api || !document) return;
            api.addFiles(Object.values(document.scene.files) as unknown as BinaryFileData[]);
            api.updateScene({
              elements: document.scene.elements as unknown as ExcalidrawElement[],
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          });
        }
      },
      [props.path, readLatest, readOnly],
    ),
  );

  return (
    <>
      <CanvasToolbar
        title={initial.canvas.title}
        subtitle={initial.canvas.displayPath}
        onBack={props.onBack}
      >
        {readOnly ? (
          <span className="shrink-0 text-2xs text-muted-foreground">Read-only</span>
        ) : status === "error" ? (
          <span className="shrink-0 text-2xs text-destructive-foreground">Not saved, retrying</span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                size="xs"
                variant="ghost"
                aria-label="Highlight agent changes"
                pressed={highlight}
                onPressedChange={setHighlight}
              />
            }
          >
            <HighlighterIcon />
          </TooltipTrigger>
          <TooltipPopup>
            {highlight ? "Agent changes are selected as they land" : "Highlight agent changes"}
          </TooltipPopup>
        </Tooltip>
      </CanvasToolbar>
      {/* Excalidraw's phone layout docks its side tools against the edge on purpose. */}
      <div data-canvas-editor data-overflow-ok className="relative min-h-0 flex-1">
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={(api) => {
            apiRef.current = api;
          }}
          onChange={handleChange}
          theme={resolvedTheme}
          viewModeEnabled={readOnly}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              export: false,
              toggleTheme: null,
            },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.SearchMenu />
            <MainMenu.DefaultItems.Help />
            {readOnly ? null : <MainMenu.DefaultItems.ClearCanvas />}
            <MainMenu.Separator />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
          <WelcomeScreen>
            <WelcomeScreen.Hints.MenuHint />
            <WelcomeScreen.Hints.ToolbarHint />
            <WelcomeScreen.Hints.HelpHint />
          </WelcomeScreen>
        </Excalidraw>
      </div>
    </>
  );
}
