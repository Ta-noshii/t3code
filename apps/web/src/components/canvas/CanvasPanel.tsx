import { useAtomValue } from "@effect/atom-react";
import type {
  CanvasEvent,
  CanvasSummary,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { FolderOpenIcon, MoreHorizontalIcon, PlusIcon, Shapes } from "lucide-react";
import { lazy, Suspense, useCallback, useState, type KeyboardEvent } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useRightPanelStore } from "~/rightPanelStore";
import { canvasEnvironment } from "~/state/canvas";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCanvasEvents } from "./useCanvasEvents";

const CanvasEditor = lazy(() => import("./CanvasEditor"));

export interface CanvasPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadRef: ScopedThreadRef;
  /** The open canvas file, or null for the project's library. */
  readonly path: string | null;
}

/** The Canvas tab: the project's canvas library, or one canvas in the editor. */
export default function CanvasPanel(props: CanvasPanelProps) {
  const open = useCallback(
    (path: string | null) => useRightPanelStore.getState().openCanvas(props.threadRef, path),
    [props.threadRef],
  );
  if (props.path !== null) {
    return (
      <Suspense fallback={null}>
        <CanvasEditor
          key={`${props.environmentId}:${props.path}`}
          environmentId={props.environmentId}
          projectId={props.projectId}
          path={props.path}
          onBack={() => open(null)}
        />
      </Suspense>
    );
  }
  return (
    <CanvasLibrary environmentId={props.environmentId} projectId={props.projectId} onOpen={open} />
  );
}

type LibraryDraft =
  | { readonly kind: "new" }
  | { readonly kind: "open" }
  | { readonly kind: "rename"; readonly canvas: CanvasSummary };

function CanvasLibrary(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onOpen: (path: string) => void;
}) {
  const listAtom = canvasEnvironment.list({
    environmentId: props.environmentId,
    input: { projectId: props.projectId },
  });
  const list = useEnvironmentQuery(listAtom);
  const canWrite = useAtomValue(canvasEnvironment.create.permissionAtom(props.environmentId));
  const create = useAtomCommand(canvasEnvironment.create);
  const rename = useAtomCommand(canvasEnvironment.rename);
  const remove = useAtomCommand(canvasEnvironment.delete);
  const read = useAtomCommand(canvasEnvironment.read);
  const [draft, setDraft] = useState<LibraryDraft | null>(null);

  const canvases = list.data?.canvases ?? [];
  useCanvasEvents(
    props.environmentId,
    useCallback(
      (event: CanvasEvent) => {
        if (
          (event.type === "library-changed" && event.projectId === props.projectId) ||
          (event.type === "changed" && canvases.some((canvas) => canvas.path === event.path))
        ) {
          list.refresh();
        }
      },
      [canvases, list, props.projectId],
    ),
  );

  const submitDraft = async (value: string) => {
    const text = value.trim();
    if (!draft || text.length === 0) return;
    const target = { environmentId: props.environmentId };
    if (draft.kind === "new") {
      const result = await create({
        ...target,
        input: { projectId: props.projectId, title: text },
      });
      if (result._tag === "Success") {
        setDraft(null);
        props.onOpen(result.value.path);
      }
    } else if (draft.kind === "open") {
      const result = await read({
        ...target,
        input: { canvas: { path: text, projectId: props.projectId }, knownFileIds: [] },
      });
      if (result._tag === "Success") {
        setDraft(null);
        props.onOpen(result.value.canvas.path);
      }
    } else {
      const result = await rename({
        ...target,
        input: { path: draft.canvas.path, title: text },
      });
      if (result._tag === "Success") setDraft(null);
    }
  };

  const confirmDelete = async (canvas: CanvasSummary) => {
    const confirmed =
      (await requestConfirmDialog(
        `Delete "${canvas.title}"?\n${canvas.displayPath} will be removed from the project.`,
        { variant: "destructive" },
      )) ?? window.confirm(`Delete "${canvas.title}"?`);
    if (!confirmed) return;
    await remove({ environmentId: props.environmentId, input: { path: canvas.path } });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        {draft !== null && draft.kind !== "rename" ? (
          <DraftField
            key={draft.kind}
            placeholder={draft.kind === "new" ? "Canvas title" : "Path to an .excalidraw file"}
            initialValue=""
            onSubmit={submitDraft}
            onCancel={() => setDraft(null)}
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {list.data?.folder ?? ""}
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Open canvas file"
                    onClick={() => setDraft({ kind: "open" })}
                  />
                }
              >
                <FolderOpenIcon />
              </TooltipTrigger>
              <TooltipPopup>Open an .excalidraw file by path</TooltipPopup>
            </Tooltip>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canWrite}
              onClick={() => setDraft({ kind: "new" })}
            >
              <PlusIcon />
              New
            </Button>
          </>
        )}
      </header>
      {list.error !== null && canvases.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">{list.error}</p>
      ) : canvases.length === 0 && list.isSuccess ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Shapes aria-hidden className="size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium">No canvases yet</p>
          <p className="max-w-64 text-xs text-muted-foreground">
            Sketch diagrams here, or ask the agent to draw one. They are saved as Excalidraw files
            in {list.data?.folder ?? "the project"}.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!canWrite}
            onClick={() => setDraft({ kind: "new" })}
          >
            <PlusIcon />
            New canvas
          </Button>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col p-1.5">
            {canvases.map((canvas) =>
              draft?.kind === "rename" && draft.canvas.path === canvas.path ? (
                <li key={canvas.path} className="flex h-12 items-center px-1">
                  <DraftField
                    placeholder="Canvas title"
                    initialValue={canvas.title}
                    onSubmit={submitDraft}
                    onCancel={() => setDraft(null)}
                  />
                </li>
              ) : (
                <CanvasRow
                  key={canvas.path}
                  canvas={canvas}
                  canWrite={canWrite}
                  onOpen={() => props.onOpen(canvas.path)}
                  onRename={() => setDraft({ kind: "rename", canvas })}
                  onDelete={() => void confirmDelete(canvas)}
                />
              ),
            )}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function CanvasRow(props: {
  canvas: CanvasSummary;
  canWrite: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { canvas } = props;
  return (
    <li className="group relative flex items-center rounded-md hover:bg-accent/60">
      <button
        type="button"
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={props.onOpen}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{canvas.title}</span>
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {formatRelativeTimeLabel(canvas.modifiedAt)}
          </span>
        </span>
        <span className="flex min-w-0 items-baseline gap-2 text-2xs text-muted-foreground">
          <MiddleTruncate value={canvas.displayPath} className="min-w-0 flex-1" />
          <span className="shrink-0 tabular-nums">
            {canvas.elementCount === 1 ? "1 element" : `${canvas.elementCount} elements`}
          </span>
        </span>
      </button>
      <Menu>
        <div className="mr-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 has-data-popup-open:opacity-100 [@media(hover:none)]:opacity-100">
          <MenuTrigger
            render={
              <Button size="icon-xs" variant="ghost" aria-label={`${canvas.title} actions`} />
            }
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
        </div>
        <MenuPopup align="end">
          <MenuItem disabled={!props.canWrite || canvas.slug === null} onClick={props.onRename}>
            Rename
          </MenuItem>
          <MenuItem onClick={() => void writeTextToClipboard(canvas.path)}>Copy path</MenuItem>
          <MenuItem
            variant="destructive"
            disabled={!props.canWrite || canvas.slug === null}
            onClick={props.onDelete}
          >
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
}

function DraftField(props: {
  placeholder: string;
  initialValue: string;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initialValue);
  const [busy, setBusy] = useState(false);
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onCancel();
    } else if (event.key === "Enter" && !busy) {
      event.preventDefault();
      setBusy(true);
      void props.onSubmit(value).finally(() => setBusy(false));
    }
  };
  return (
    <Input
      size="compact"
      autoFocus
      value={value}
      disabled={busy}
      placeholder={props.placeholder}
      aria-label={props.placeholder}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!busy) props.onCancel();
      }}
    />
  );
}
