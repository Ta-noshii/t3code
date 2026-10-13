import type {
  CanvasBinaryFile,
  CanvasDocument,
  CanvasElement,
  CanvasSaveInput,
  CanvasSaveResult,
} from "@t3tools/contracts";
import { mergeCanvasElements, storedAppState } from "@t3tools/shared/canvas";

const RETRY_DELAY_MS = 5_000;

export type CanvasSyncStatus = "saved" | "unsaved" | "saving" | "error";

export interface CanvasSyncHost {
  /** The editor's elements, deleted ones included, its app state and image files. */
  readonly getScene: () => {
    readonly elements: ReadonlyArray<CanvasElement>;
    readonly appState: Readonly<Record<string, unknown>>;
    readonly files: Readonly<Record<string, CanvasBinaryFile>>;
  };
  /** Cheap fingerprint of what a save would write; equal fingerprints need no save. */
  readonly signature: () => string;
  /** Replace the editor's elements and add image files it does not have. */
  readonly apply: (elements: CanvasElement[], files: CanvasBinaryFile[]) => void;
  readonly save: (input: Omit<CanvasSaveInput, "path">) => Promise<CanvasSaveResult | null>;
  readonly read: (knownFileIds: string[]) => Promise<CanvasDocument | null>;
  /** Shrinks pasted images before they are sent. */
  readonly prepareFiles: (files: CanvasBinaryFile[]) => Promise<CanvasBinaryFile[]>;
  readonly onStatus: (status: CanvasSyncStatus) => void;
}

/**
 * Keeps an open editor and its file in step. Edits save after `delayMs` of
 * quiet; the server merges them with anything written since. Changes from
 * elsewhere (an agent, another client, the file on disk) merge into the
 * editor with the same element-version rule, so neither side loses work.
 * Saves and reads run one at a time.
 */
export class CanvasSync {
  private revision: string;
  /** The file's elements at `revision`, the common ancestor for merges. */
  private base: ReadonlyArray<CanvasElement>;
  private synced: string;
  private readonly knownFileIds: Set<string>;
  private latestRemote: string | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly host: CanvasSyncHost,
    document: CanvasDocument,
    private readonly delayMs: number,
  ) {
    this.revision = document.revision;
    this.base = document.scene.elements;
    this.knownFileIds = new Set(Object.keys(document.scene.files));
    this.synced = host.signature();
  }

  /** Call after every editor change; only real content changes schedule a save. */
  noteChange(): void {
    if (this.disposed) return;
    if (!this.dirty && this.host.signature() === this.synced) return;
    this.markDirty();
  }

  /** The file changed to `revision`, maybe by this editor's own save. */
  remoteChanged(revision: string): void {
    if (this.disposed) return;
    this.latestRemote = revision;
    this.enqueue(() => this.catchUp());
  }

  /** Save now instead of waiting for the delay. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.enqueue(() => this.saveIfDirty());
  }

  /** Save what is pending, then stop. */
  async close(): Promise<void> {
    if (this.disposed) return;
    await this.flush().catch(() => undefined);
    this.dispose();
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.disposed = true;
  }

  private markDirty(): void {
    if (!this.dirty) {
      this.dirty = true;
      this.host.onStatus("unsaved");
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  private retry(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, RETRY_DELAY_MS);
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(() => (this.disposed ? undefined : task()));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async catchUp(): Promise<void> {
    if (this.latestRemote === null || this.latestRemote === this.revision) return;
    // A save carries its own merge; it also covers this change.
    if (this.dirty) return this.saveIfDirty();
    const document = await this.host.read([...this.knownFileIds]);
    if (this.disposed || document === null || document.revision === this.revision) return;
    this.mergeIn(this.base, document.scene.elements, document.scene.files);
    this.revision = document.revision;
    this.base = document.scene.elements;
  }

  private async saveIfDirty(): Promise<void> {
    if (!this.dirty) return;
    const scene = this.host.getScene();
    const sent = this.host.signature();
    const remoteBefore = this.latestRemote;
    const newFiles = Object.values(scene.files).filter((file) => !this.knownFileIds.has(file.id));
    this.host.onStatus("saving");
    const files = await this.host.prepareFiles(newFiles);
    const result = await this.host.save({
      baseRevision: this.revision,
      elements: [...scene.elements],
      appState: storedAppState(scene.appState),
      ...(files.length > 0
        ? { files: Object.fromEntries(files.map((file) => [file.id, file])) }
        : {}),
    });
    if (this.disposed) return;
    if (result === null) {
      this.host.onStatus("error");
      this.retry();
      return;
    }
    for (const file of newFiles) this.knownFileIds.add(file.id);
    this.dirty = false;
    this.revision = result.revision;
    this.synced = sent;
    if (result.merged) {
      this.mergeIn(scene.elements, result.merged.elements, result.merged.files);
      this.base = result.merged.elements;
    } else {
      this.base = scene.elements;
    }
    // Edits made while the save was in flight still need saving.
    if (this.host.signature() !== this.synced) this.markDirty();
    else this.host.onStatus("saved");
    // The server merged every write it had before this save, so only a change
    // announced while the save was in flight can still be missing here.
    if (this.latestRemote === remoteBefore) this.latestRemote = null;
    if (this.latestRemote !== null && this.latestRemote !== this.revision) {
      void this.enqueue(() => this.catchUp());
    }
  }

  private mergeIn(
    base: ReadonlyArray<CanvasElement>,
    remote: ReadonlyArray<CanvasElement>,
    files: Readonly<Record<string, CanvasBinaryFile>>,
  ): void {
    const local = this.host.getScene().elements;
    const before = this.host.signature();
    const merged = mergeCanvasElements({ base, local, remote });
    const added = Object.values(files).filter((file) => !this.knownFileIds.has(file.id));
    for (const file of added) this.knownFileIds.add(file.id);
    this.host.apply(merged, added);
    // A clean editor now matches the file; a dirty one still has edits to save.
    if (!this.dirty && before === this.synced) this.synced = this.host.signature();
  }
}
