import type { ToolImage } from "@t3tools/shared/toolMedia";
import { toolImageDataUrl } from "@t3tools/shared/toolMedia";
import {
  type ToolOutputBlock,
  type ToolStatusTone,
  toolFieldLabel,
  toolFields,
  toolListIsInline,
  toolRecordTitle,
  toolScalarView,
} from "@t3tools/client-runtime/work-log/tool-value";
import { CheckIcon, ImageIcon } from "lucide-react";
import { memo, useState, type ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";

const MAX_DEPTH = 4;
const MAX_LIST_ITEMS = 50;

const TONE_VARIANT = {
  success: "success",
  error: "error",
  info: "info",
  warning: "warning",
  neutral: "outline",
} as const satisfies Record<ToolStatusTone, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function imageCaption(image: ToolImage): string {
  const format = image.mimeType?.replace(/^image\//u, "").toUpperCase() ?? "Image";
  const size = image.width && image.height ? `${image.width}×${image.height} ` : "";
  return `${size}${format}${image.byteLength ? `, ${formatBytes(image.byteLength)}` : ""}`;
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function CopyableId({ text }: { readonly text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <button
      type="button"
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm font-mono text-foreground/85 hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
      aria-label={`Copy ${text}`}
      onClick={() => copyToClipboard(text, undefined)}
    >
      <MiddleTruncate value={text} tail={6} />
      {isCopied ? <CheckIcon className="size-3 shrink-0 text-success" /> : null}
    </button>
  );
}

function ScalarValue({
  fieldKey,
  value,
}: {
  readonly fieldKey: string;
  readonly value: string | number | boolean;
}) {
  const view = toolScalarView(fieldKey, value);
  switch (view.kind) {
    case "status":
      return (
        <Badge variant={TONE_VARIANT[view.tone]} size="sm">
          {view.text.replace(/_/gu, " ")}
        </Badge>
      );
    case "time": {
      const date = new Date(view.iso);
      return (
        <span>
          {timeFormatter.format(date)}
          <span className="text-muted-foreground"> ({formatRelativeTimeLabel(view.iso)})</span>
        </span>
      );
    }
    case "url":
      return (
        <a
          href={view.href}
          target="_blank"
          rel="noreferrer"
          className="break-all text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
        >
          {view.href}
        </a>
      );
    case "id":
      return <CopyableId text={view.text} />;
    case "path":
      return <span className="font-mono break-all">{view.text}</span>;
    case "longText":
      return (
        <pre className="max-h-48 overflow-auto font-mono whitespace-pre-wrap break-words text-foreground/85">
          {view.text}
        </pre>
      );
    case "boolean":
      return (
        <span className={view.value ? "" : "text-muted-foreground"}>
          {view.value ? "Yes" : "No"}
        </span>
      );
    case "number":
    case "text":
      return <span className="break-words">{view.text}</span>;
  }
}

function FieldValue({
  fieldKey,
  value,
  depth,
}: {
  readonly fieldKey: string;
  readonly value: unknown;
  readonly depth: number;
}): ReactNode {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <ScalarValue fieldKey={fieldKey} value={value} />;
  }
  if (depth >= MAX_DEPTH) {
    return <pre className="font-mono whitespace-pre-wrap break-words">{JSON.stringify(value)}</pre>;
  }
  if (Array.isArray(value)) {
    if (toolListIsInline(value)) {
      return (
        <span className="flex flex-wrap gap-1">
          {value.map((entry, index) => (
            <Badge key={index} variant="outline" size="sm">
              {String(entry)}
            </Badge>
          ))}
        </span>
      );
    }
    const shown = value.slice(0, MAX_LIST_ITEMS);
    return (
      <div className="space-y-1.5">
        {shown.map((entry, index) =>
          isRecord(entry) ? (
            <RecordCard key={index} value={entry} depth={depth + 1} />
          ) : (
            <div key={index}>
              <FieldValue fieldKey={fieldKey} value={entry} depth={depth + 1} />
            </div>
          ),
        )}
        {value.length > shown.length ? (
          <div className="text-muted-foreground">{value.length - shown.length} more not shown</div>
        ) : null}
      </div>
    );
  }
  if (isRecord(value)) {
    return (
      <div className="border-l border-border/60 pl-2">
        <RecordFields value={value} depth={depth + 1} />
      </div>
    );
  }
  return null;
}

function RecordFields({
  value,
  depth,
  skipKey,
}: {
  readonly value: Record<string, unknown>;
  readonly depth: number;
  readonly skipKey?: string | undefined;
}) {
  const fields = toolFields(value).filter(([key]) => key !== skipKey);
  if (fields.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1">
      {fields.map(([key, entry]) => {
        const nested = isRecord(entry) || (Array.isArray(entry) && !toolListIsInline(entry));
        return (
          <div
            key={key}
            className={cn("contents", nested && "[&>dd]:col-span-2 [&>dt]:col-span-2")}
          >
            <dt className="max-w-40 truncate text-muted-foreground">{toolFieldLabel(key)}</dt>
            <dd className="min-w-0 text-foreground/90">
              <FieldValue fieldKey={key} value={entry} depth={depth} />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** One object in a list, headed by its name-like field. */
function RecordCard({
  value,
  depth,
}: {
  readonly value: Record<string, unknown>;
  readonly depth: number;
}) {
  const title = toolRecordTitle(value);
  const titleKey =
    title === undefined ? undefined : Object.keys(value).find((key) => value[key] === title);
  return (
    <div className="rounded-md border border-border/50 px-2 py-1.5">
      {title ? <div className="mb-1 truncate font-medium text-foreground">{title}</div> : null}
      <RecordFields value={value} depth={depth} skipKey={titleKey} />
    </div>
  );
}

function ImageBlock({ image }: { readonly image: ToolImage }) {
  const src = toolImageDataUrl(image);
  if (!src) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <ImageIcon className="size-3.5 shrink-0" />
        <span>{imageCaption(image)}, too large to show here</span>
      </div>
    );
  }
  return (
    <figure className="space-y-1">
      <img
        src={src}
        alt={imageCaption(image)}
        className="max-h-64 max-w-full rounded-md border border-border/50 object-contain"
      />
      <figcaption className="text-muted-foreground">{imageCaption(image)}</figcaption>
    </figure>
  );
}

/**
 * A tool result as fields, text, and images. A toggle shows the raw JSON for
 * the cases the structured view does not explain.
 */
export const ToolOutputView = memo(function ToolOutputView({
  blocks,
  raw,
  hideImages = false,
}: {
  readonly blocks: readonly ToolOutputBlock[];
  readonly raw: unknown;
  /** The row already previews the image, so image blocks would repeat it. */
  readonly hideImages?: boolean | undefined;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const visible = hideImages ? blocks.filter((block) => block.kind !== "image") : blocks;
  if (visible.length === 0) return null;
  const hasData = visible.some((block) => block.kind === "data");
  return (
    <div className="relative space-y-2 font-sans text-xs" data-tool-output>
      {hasData ? (
        <Button
          variant="ghost-muted"
          size="micro"
          className="absolute top-0 right-0"
          aria-pressed={showRaw}
          onClick={() => setShowRaw((value) => !value)}
        >
          {showRaw ? "Fields" : "JSON"}
        </Button>
      ) : null}
      {showRaw ? (
        <pre className="max-h-80 overflow-auto pr-10 font-mono whitespace-pre-wrap break-words text-muted-foreground">
          {typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)}
        </pre>
      ) : (
        <div className={cn("max-h-96 space-y-2 overflow-auto", hasData && "pr-10")}>
          {visible.map((block, index) => {
            switch (block.kind) {
              case "text":
                return (
                  <pre
                    key={index}
                    className="font-mono whitespace-pre-wrap break-words text-muted-foreground"
                  >
                    {block.text}
                  </pre>
                );
              case "image":
                return <ImageBlock key={index} image={block.image} />;
              case "data":
                return isRecord(block.value) ? (
                  <RecordFields key={index} value={block.value} depth={0} />
                ) : (
                  <FieldValue key={index} fieldKey="" value={block.value} depth={0} />
                );
            }
          })}
        </div>
      )}
    </div>
  );
});
