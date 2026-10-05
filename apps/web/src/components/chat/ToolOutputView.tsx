import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ScopedThreadRef,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { ToolImage } from "@t3tools/shared/toolMedia";
import { toolImageDataUrl } from "@t3tools/shared/toolMedia";
import {
  providerLabel,
  type ToolCallDigest,
  type ToolDigest,
  type ToolDigestIcon,
  type ToolDigestKind,
  type ToolDigestMeta,
  type ToolDigestStatus,
  toolResultDigest,
} from "@t3tools/client-runtime/work-log/tool-digest";
import type { ToolOutputBlock, ToolStatusTone } from "@t3tools/client-runtime/work-log/tool-value";
import {
  ArrowUpRightIcon,
  BanIcon,
  BotIcon,
  BoxesIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CirclePauseIcon,
  CircleXIcon,
  ClockIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  HourglassIcon,
  ImageIcon,
  InfoIcon,
  LinkIcon,
  ListIcon,
  type LucideIcon,
  MessageSquareTextIcon,
  MonitorSmartphoneIcon,
  MousePointerClickIcon,
  PauseIcon,
  RepeatIcon,
  RotateCwIcon,
  SendIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { getProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { ProviderInstanceIcon, providerTextColorClassName } from "./ProviderInstanceIcon";

const TONE_VARIANT = {
  success: "success",
  error: "error",
  info: "info",
  warning: "warning",
  neutral: "outline",
} as const satisfies Record<ToolStatusTone, string>;

export interface ToolViewContext {
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  /** Resolves provider instances to their logo and model names. */
  readonly providers?: ReadonlyArray<ServerProvider> | undefined;
}

const KIND_ICON: Record<ToolDigestKind, LucideIcon> = {
  task: BotIcon,
  thread: MessageSquareTextIcon,
  message: SendIcon,
  page: GlobeIcon,
  models: BoxesIcon,
  schedule: CalendarClockIcon,
  project: FolderIcon,
  request: CircleHelpIcon,
  list: ListIcon,
};

const FACT_ICON: Record<ToolDigestIcon, LucideIcon> = {
  clock: HourglassIcon,
  viewport: MonitorSmartphoneIcon,
  branch: GitBranchIcon,
  runs: RotateCwIcon,
  folder: FolderIcon,
  repeat: RepeatIcon,
  calendar: ClockIcon,
  pointer: MousePointerClickIcon,
  alert: CircleAlertIcon,
  link: LinkIcon,
  pause: PauseIcon,
  loading: ClockIcon,
  info: InfoIcon,
};

const TONE_ICON: Record<ToolStatusTone, LucideIcon> = {
  success: CircleCheckIcon,
  error: CircleXIcon,
  info: CircleDotIcon,
  warning: CirclePauseIcon,
  neutral: CircleDotIcon,
};

function statusIcon(status: ToolDigestStatus): LucideIcon {
  return /cancel/iu.test(status.label) ? BanIcon : TONE_ICON[status.tone];
}

function KindIcon({ kind }: { readonly kind: ToolDigestKind | undefined }) {
  const Icon = kind ? KIND_ICON[kind] : null;
  return Icon ? <Icon className="size-3.5 shrink-0 self-center text-muted-foreground" /> : null;
}

/** Instance ids name a driver kind directly unless the user made a custom instance. */
function useProviderView(context: ToolViewContext, instanceId: string) {
  const entry = context.providers
    ? getProviderInstanceEntry(context.providers, ProviderInstanceId.make(instanceId))
    : undefined;
  return {
    entry,
    driverKind: entry?.driverKind ?? ProviderDriverKind.make(instanceId),
    displayName: entry?.displayName ?? providerLabel(instanceId),
  };
}

function ProviderLogo({
  instanceId,
  context,
}: {
  readonly instanceId: string;
  readonly context: ToolViewContext;
}) {
  const provider = useProviderView(context, instanceId);
  return (
    <ProviderInstanceIcon
      driverKind={provider.driverKind}
      displayName={provider.displayName}
      acpRegistryAgentId={provider.entry?.acpRegistryAgentId}
      acpRegistryIconUrl={provider.entry?.acpRegistryIconUrl}
      className="z-auto"
      iconClassName="size-3.5"
    />
  );
}

/** Provider logo, the model's display name in the provider's color, and the effort. */
function ModelMeta({
  meta,
  context,
}: {
  readonly meta: Extract<ToolDigestMeta, { kind: "model" }>;
  readonly context: ToolViewContext;
}) {
  const provider = useProviderView(context, meta.providerInstanceId ?? "");
  const known = meta.model
    ? provider.entry?.models.find((candidate) => candidate.slug === meta.model)
    : undefined;
  const name = known ? getTriggerDisplayModelName(known) : (meta.model ?? provider.displayName);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {meta.providerInstanceId ? (
        <ProviderLogo instanceId={meta.providerInstanceId} context={context} />
      ) : null}
      <span
        className={cn(
          "min-w-0 font-medium break-words",
          meta.providerInstanceId
            ? providerTextColorClassName(provider.driverKind)
            : "text-foreground",
        )}
      >
        {name}
      </span>
      {meta.effort ? <span className="text-muted-foreground">{meta.effort}</span> : null}
    </span>
  );
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

function StatusBadge({ status }: { readonly status: ToolDigestStatus }) {
  const Icon = statusIcon(status);
  return (
    <Badge variant={TONE_VARIANT[status.tone]} size="sm">
      <Icon />
      {status.label}
    </Badge>
  );
}

function CopyableValue({ text }: { readonly text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <button
      type="button"
      className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-sm font-mono text-foreground/80 hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
      aria-label={`Copy ${text}`}
      onClick={() => copyToClipboard(text, undefined)}
    >
      <MiddleTruncate value={text} tail={12} />
      {isCopied ? <CheckIcon className="size-3 shrink-0 text-success" /> : null}
    </button>
  );
}

function ThreadButtons({
  threads,
  context,
}: {
  readonly threads: ToolDigest["threads"];
  readonly context: ToolViewContext;
}) {
  const onOpenThread = context.onOpenThread;
  if (!onOpenThread || threads.length === 0) return null;
  return threads.map((thread) => (
    <Button
      key={thread.threadId}
      variant="outline"
      size="micro"
      onClick={() => onOpenThread(ThreadId.make(thread.threadId))}
    >
      <MessageSquareTextIcon />
      {thread.label}
      <ArrowUpRightIcon />
    </Button>
  ));
}

/** Prompt-sized text, cut to a few lines until opened. */
function LongText({
  label,
  text,
  context,
  muted = false,
}: {
  readonly label: string | undefined;
  readonly text: string;
  readonly context: ToolViewContext;
  readonly muted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const long = text.length > 280 || text.split("\n").length > 5;
  return (
    <div className="space-y-0.5">
      {label ? <div className="text-muted-foreground">{label}</div> : null}
      <div
        className={cn(
          "border-l-2 border-border pl-2.5",
          long && !open && "max-h-28 overflow-hidden mask-b-from-60% [&_.chat-markdown>*]:my-1",
        )}
        // The fade marks the cut; "Show all" opens the rest.
        data-overflow-ok={long && !open ? "" : undefined}
      >
        <ChatMarkdown
          text={text}
          cwd={context.cwd}
          threadRef={context.threadRef}
          className={cn(
            "text-xs leading-normal",
            muted ? "text-muted-foreground" : "text-foreground/90",
          )}
        />
      </div>
      {long ? (
        <Button variant="ghost-muted" size="micro" onClick={() => setOpen((value) => !value)}>
          {open ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  );
}

function Meta({
  items,
  context,
}: {
  readonly items: readonly ToolDigestMeta[];
  readonly context: ToolViewContext;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-muted-foreground">
      {items.map((item, index) => {
        if (item.kind === "model") {
          return <ModelMeta key={`model-${index}`} meta={item} context={context} />;
        }
        const Icon = item.icon ? FACT_ICON[item.icon] : null;
        return (
          <span key={item.text} className="inline-flex min-w-0 items-center gap-1">
            {Icon ? <Icon className="size-3 shrink-0 opacity-80" /> : null}
            <span className="min-w-0 break-words">{item.text}</span>
          </span>
        );
      })}
    </div>
  );
}

/** The arguments a T3 tool was called with, as the prompt and a line of settings. */
export function ToolCallDigestView({
  digest,
  context,
}: {
  readonly digest: ToolCallDigest;
  readonly context: ToolViewContext;
}) {
  const settings: ToolDigestMeta[] = [
    ...digest.meta,
    ...digest.args.map(([label, value]) => ({
      kind: "fact" as const,
      text: value ? `${label} ${value}` : label,
    })),
  ];
  if (!digest.title && !digest.text && settings.length === 0) return null;
  return (
    <div className="space-y-1.5 font-sans">
      {digest.title ? <div className="font-medium text-foreground">{digest.title}</div> : null}
      <Meta items={settings} context={context} />
      {digest.text ? (
        <LongText label={digest.textLabel} text={digest.text} context={context} muted />
      ) : null}
    </div>
  );
}

function DigestRows({
  rows,
  context,
}: {
  readonly rows: NonNullable<ToolDigest["rows"]>;
  readonly context: ToolViewContext;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, 8);
  return (
    <div className="space-y-1">
      <ul className="divide-y divide-border/50 rounded-md border border-border/50">
        {shown.map((row, index) => (
          <li key={`${row.title}-${index}`} className="flex min-w-0 gap-2 px-2 py-1.5">
            <span className="flex h-4 shrink-0 items-center">
              {row.providerInstanceId ? (
                <ProviderLogo instanceId={row.providerInstanceId} context={context} />
              ) : (
                <KindIcon kind={row.kind} />
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
              {row.href ? (
                <a
                  href={row.href}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 break-words text-foreground hover:underline"
                >
                  {row.title}
                </a>
              ) : row.threadId && context.onOpenThread ? (
                <button
                  type="button"
                  className="min-w-0 text-left break-words text-foreground hover:underline"
                  onClick={() => context.onOpenThread?.(ThreadId.make(row.threadId!))}
                >
                  {row.title}
                </button>
              ) : (
                <span
                  className={cn(
                    "min-w-0 break-words text-foreground",
                    row.providerInstanceId && "font-medium",
                  )}
                >
                  {row.title}
                </span>
              )}
              {row.status ? <StatusBadge status={row.status} /> : null}
              {row.detail ? (
                <span className="basis-full text-muted-foreground">{row.detail}</span>
              ) : null}
              {row.chips?.length ? (
                <span className="flex basis-full flex-wrap gap-1">
                  {row.chips.map((chip) => (
                    <Badge key={chip} variant="outline" size="sm">
                      {chip}
                    </Badge>
                  ))}
                </span>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {rows.length > shown.length ? (
        <Button variant="ghost-muted" size="micro" onClick={() => setShowAll(true)}>
          Show {rows.length - shown.length} more
        </Button>
      ) : null}
    </div>
  );
}

function DigestView({
  digest,
  context,
}: {
  readonly digest: ToolDigest;
  readonly context: ToolViewContext;
}) {
  const hasHead = Boolean(digest.status || digest.title || digest.threads.length);
  return (
    <div className="space-y-2">
      {hasHead ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <KindIcon kind={digest.kind} />
          {digest.title ? (
            digest.href ? (
              <a
                href={digest.href}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 font-medium break-all text-foreground hover:underline"
              >
                {digest.title}
              </a>
            ) : (
              <span className="min-w-0 font-medium break-words text-foreground">
                {digest.title}
              </span>
            )
          ) : null}
          {digest.status ? <StatusBadge status={digest.status} /> : null}
          <span className="ml-auto flex gap-1">
            <ThreadButtons threads={digest.threads} context={context} />
          </span>
        </div>
      ) : null}
      <Meta items={digest.meta} context={context} />
      {digest.error ? <div className="text-destructive">{digest.error}</div> : null}
      {digest.text ? (
        <LongText label={digest.textLabel} text={digest.text} context={context} />
      ) : null}
      {digest.rows?.length ? <DigestRows rows={digest.rows} context={context} /> : null}
      {digest.empty ? <div className="text-muted-foreground">{digest.empty}</div> : null}
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

/** Collapsed IDs and leftovers, plus the raw result for anything the digest leaves out. */
function DetailsDisclosure({
  details,
  raw,
}: {
  readonly details: ToolDigest["details"];
  readonly raw: unknown;
}) {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="space-y-1.5">
      <Button
        variant="ghost-muted"
        size="micro"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
        Details
      </Button>
      {open ? (
        <div className="space-y-1.5 pl-1">
          {details.length > 0 ? (
            <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5">
              {details.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="min-w-0">
                    <CopyableValue text={value} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          <Button variant="ghost-muted" size="micro" onClick={() => setShowRaw((value) => !value)}>
            {showRaw ? "Hide JSON" : "Show JSON"}
          </Button>
          {showRaw ? (
            <pre className="max-h-80 overflow-auto font-mono whitespace-pre-wrap break-words text-muted-foreground">
              {typeof raw === "string" ? raw : JSON.stringify(raw, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A tool result as a digest (outcome, subject, links, text), its images, and
 * plain text, with IDs and the raw value one click away.
 */
export const ToolOutputView = memo(function ToolOutputView({
  blocks,
  raw,
  toolName,
  input,
  context,
  hideImages = false,
}: {
  readonly blocks: readonly ToolOutputBlock[];
  readonly raw: unknown;
  readonly toolName: string | null | undefined;
  readonly input: unknown;
  readonly context: ToolViewContext;
  /** The row already previews the image, so image blocks would repeat it. */
  readonly hideImages?: boolean | undefined;
}) {
  const visible = hideImages ? blocks.filter((block) => block.kind !== "image") : blocks;
  if (blocks.length === 0) {
    const digest = toolResultDigest(toolName, null, input);
    return digest ? (
      <div className="font-sans text-xs" data-tool-output>
        <DigestView digest={digest} context={context} />
      </div>
    ) : null;
  }
  if (visible.length === 0) return null;
  const digests = visible.map((block) =>
    block.kind === "data" || (block.kind === "text" && /^error:/iu.test(block.text.trim()))
      ? toolResultDigest(toolName, block.kind === "data" ? block.value : block.text, input)
      : null,
  );
  const details = digests.flatMap((digest) => digest?.details ?? []);
  const structured = digests.some((digest) => digest !== null);
  return (
    <div className="space-y-2 font-sans text-xs" data-tool-output>
      <div className="max-h-[32rem] space-y-2 overflow-auto">
        {visible.map((block, index) => {
          const digest = digests[index];
          if (digest) return <DigestView key={index} digest={digest} context={context} />;
          switch (block.kind) {
            case "image":
              return <ImageBlock key={index} image={block.image} />;
            case "text":
              return (
                <pre
                  key={index}
                  className="font-mono whitespace-pre-wrap break-words text-muted-foreground"
                >
                  {block.text}
                </pre>
              );
            case "data":
              return (
                <pre
                  key={index}
                  className="font-mono whitespace-pre-wrap break-words text-muted-foreground"
                >
                  {JSON.stringify(block.value, null, 2)}
                </pre>
              );
          }
        })}
      </div>
      {structured ? <DetailsDisclosure details={details} raw={raw} /> : null}
    </div>
  );
});
