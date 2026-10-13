import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
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
import type { EnvironmentId } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { type ReactNode, useState } from "react";
import { Linking, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { getProviderClient } from "../../lib/providerClients";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export interface ToolDigestContext {
  readonly environmentId: EnvironmentId;
  readonly renderMarkdown: (text: string) => ReactNode;
  readonly onOpenThread: (threadId: string) => void;
}

const KIND_ICON: Record<ToolDigestKind, AppSymbolName> = {
  task: "sparkles",
  thread: "text.bubble",
  message: "arrow.up.circle",
  page: "globe",
  models: "cube",
  schedule: "clock",
  project: "folder",
  request: "questionmark.bubble",
  list: "list.number",
};

const FACT_ICON: Record<ToolDigestIcon, AppSymbolName> = {
  clock: "timer",
  viewport: "iphone",
  branch: "arrow.triangle.branch",
  runs: "arrow.clockwise",
  folder: "folder",
  repeat: "arrow.clockwise",
  calendar: "clock",
  pointer: "target",
  alert: "exclamationmark.circle",
  link: "link",
  pause: "stop.fill",
  loading: "clock",
  info: "info.circle",
};

const TONE_ICON: Record<ToolStatusTone, AppSymbolName> = {
  success: "checkmark.circle",
  error: "xmark.circle.fill",
  info: "circle.inset.filled",
  warning: "exclamationmark.triangle",
  neutral: "circle",
};

const TONE_TEXT: Record<ToolStatusTone, string> = {
  success: "text-adaptive-emerald-600-400",
  error: "text-adaptive-rose-600-400",
  info: "text-adaptive-sky-600-400",
  warning: "text-adaptive-amber-700-300",
  neutral: "text-foreground-muted",
};

const TONE_ACCENT: Record<ToolStatusTone, string> = {
  success: "accent-adaptive-emerald-600-400",
  error: "accent-adaptive-rose-600-400",
  info: "accent-adaptive-sky-600-400",
  warning: "accent-adaptive-amber-700-300",
  neutral: "accent-foreground-muted",
};

const ROW_LIMIT = 8;

function useProvider(environmentId: EnvironmentId, instanceId: string | undefined) {
  const config = useEnvironmentServerConfig(environmentId);
  const provider = instanceId
    ? config?.providers.find((candidate) => candidate.instanceId === instanceId)
    : undefined;
  return {
    provider,
    driver: provider?.driver ?? instanceId,
    displayName: provider
      ? resolveProviderInstanceDisplayName(provider)
      : instanceId
        ? providerLabel(instanceId)
        : "",
  };
}

/** The provider's logo color, so a model name reads as belonging to it. */
function useProviderTint(driver: string | undefined): string | undefined {
  const { themeAppearance } = useAppearancePreferences();
  if (driver === "claudeAgent") return "#D97757";
  const fill = getProviderClient(driver)?.icon?.fill;
  return fill ? (themeAppearance === "dark" ? fill.dark : fill.light) : undefined;
}

function ProviderLogo(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string;
}) {
  const { provider, driver } = useProvider(props.environmentId, props.instanceId);
  return <ProviderIcon provider={driver} iconUrl={provider?.iconUrl} size={13} />;
}

function ModelMeta(props: {
  readonly meta: Extract<ToolDigestMeta, { kind: "model" }>;
  readonly context: ToolDigestContext;
}) {
  const { meta } = props;
  const { provider, driver, displayName } = useProvider(
    props.context.environmentId,
    meta.providerInstanceId,
  );
  const tint = useProviderTint(meta.providerInstanceId ? driver : undefined);
  const known = meta.model
    ? provider?.models.find((candidate) => candidate.slug === meta.model)
    : undefined;
  const name = known ? known.shortName || known.name : (meta.model ?? displayName);
  return (
    <View className="min-w-0 shrink flex-row items-center gap-1.5">
      {meta.providerInstanceId ? (
        <ProviderLogo
          environmentId={props.context.environmentId}
          instanceId={meta.providerInstanceId}
        />
      ) : null}
      <Text
        className={cn("shrink font-t3-medium text-xs", !tint && "text-foreground")}
        style={tint ? { color: tint } : undefined}
      >
        {name}
      </Text>
      {meta.effort ? <Text className="text-xs text-foreground-muted">{meta.effort}</Text> : null}
    </View>
  );
}

function Meta(props: {
  readonly items: readonly ToolDigestMeta[];
  readonly context: ToolDigestContext;
}) {
  if (props.items.length === 0) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-x-3.5 gap-y-1">
      {props.items.map((item, index) =>
        item.kind === "model" ? (
          <ModelMeta key={`model-${index}`} meta={item} context={props.context} />
        ) : (
          <View
            key={`${index}:${item.text}`}
            className="min-w-0 shrink flex-row items-center gap-1"
          >
            {item.icon ? (
              <SymbolView
                name={FACT_ICON[item.icon]}
                size={11}
                tintColorClassName="accent-icon-subtle"
              />
            ) : null}
            <Text className="shrink text-xs text-foreground-muted">{item.text}</Text>
          </View>
        ),
      )}
    </View>
  );
}

function StatusBadge(props: { readonly status: ToolDigestStatus }) {
  const { tone, label } = props.status;
  const icon = /cancel/iu.test(label) ? "xmark" : TONE_ICON[tone];
  return (
    <View className="flex-row items-center gap-1 rounded-full border border-border px-1.5 py-px">
      <SymbolView name={icon} size={10} tintColorClassName={TONE_ACCENT[tone]} />
      <Text className={cn("font-t3-medium text-3xs", TONE_TEXT[tone])}>{label}</Text>
    </View>
  );
}

function SmallButton(props: {
  readonly label: string;
  readonly icon?: AppSymbolName;
  readonly onPress: () => void;
  readonly outlined?: boolean;
  readonly accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      hitSlop={6}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-1 self-start active:opacity-60",
        props.outlined && "rounded-md border border-border px-2 py-1",
      )}
    >
      {props.icon ? (
        <SymbolView name={props.icon} size={10} tintColorClassName="accent-icon-muted" />
      ) : null}
      <Text className="font-t3-medium text-2xs text-foreground-muted">{props.label}</Text>
    </Pressable>
  );
}

/** Prompt-sized text, cut to a few lines until opened. */
function LongText(props: {
  readonly label: string | undefined;
  readonly text: string;
  readonly context: ToolDigestContext;
}) {
  const [open, setOpen] = useState(false);
  const long = props.text.length > 280 || props.text.split("\n").length > 5;
  return (
    <View className="gap-0.5">
      {props.label ? <Text className="text-xs text-foreground-muted">{props.label}</Text> : null}
      <View
        className={cn(
          "border-l-2 border-border pl-2.5",
          long && !open && "max-h-28 overflow-hidden",
        )}
      >
        {props.context.renderMarkdown(props.text)}
      </View>
      {long ? (
        <SmallButton label={open ? "Show less" : "Show all"} onPress={() => setOpen(!open)} />
      ) : null}
    </View>
  );
}

function ThreadButtons(props: {
  readonly threads: ToolDigest["threads"];
  readonly context: ToolDigestContext;
}) {
  if (props.threads.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1.5">
      {props.threads.map((thread) => (
        <SmallButton
          key={thread.threadId}
          outlined
          icon="text.bubble"
          label={thread.label}
          onPress={() => props.context.onOpenThread(thread.threadId)}
        />
      ))}
    </View>
  );
}

function openLink(href: string) {
  void Linking.openURL(href).catch(() => undefined);
}

/** The arguments a T3 tool was called with, as the prompt and a line of settings. */
export function ToolCallDigestView(props: {
  readonly digest: ToolCallDigest;
  readonly context: ToolDigestContext;
}) {
  const { digest } = props;
  const settings: ToolDigestMeta[] = [
    ...digest.meta,
    ...digest.args.map(([label, value]) => ({
      kind: "fact" as const,
      text: value ? `${label} ${value}` : label,
    })),
  ];
  if (!digest.title && !digest.text && settings.length === 0) return null;
  return (
    <View className="gap-1.5">
      {digest.title ? (
        <Text selectable className="font-t3-medium text-xs text-foreground">
          {digest.title}
        </Text>
      ) : null}
      <Meta items={settings} context={props.context} />
      {digest.text ? (
        <LongText label={digest.textLabel} text={digest.text} context={props.context} />
      ) : null}
    </View>
  );
}

function DigestRows(props: {
  readonly rows: NonNullable<ToolDigest["rows"]>;
  readonly context: ToolDigestContext;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? props.rows : props.rows.slice(0, ROW_LIMIT);
  return (
    <View className="gap-1">
      <View className="overflow-hidden rounded-md border border-border">
        {shown.map((row, index) => {
          const onPress = row.href
            ? () => openLink(row.href!)
            : row.threadId
              ? () => props.context.onOpenThread(row.threadId!)
              : undefined;
          return (
            <Pressable
              key={`${row.title}-${index}`}
              disabled={!onPress}
              accessibilityRole={onPress ? "link" : undefined}
              onPress={onPress}
              className={cn(
                "flex-row gap-2 px-2 py-1.5 active:opacity-60",
                index > 0 && "border-t border-border",
              )}
            >
              <View className="h-4 justify-center">
                {row.providerInstanceId ? (
                  <ProviderLogo
                    environmentId={props.context.environmentId}
                    instanceId={row.providerInstanceId}
                  />
                ) : row.kind ? (
                  <SymbolView
                    name={KIND_ICON[row.kind]}
                    size={12}
                    tintColorClassName="accent-icon-subtle"
                  />
                ) : null}
              </View>
              <View className="min-w-0 flex-1 gap-1">
                <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
                  <Text
                    className={cn(
                      "shrink text-xs text-foreground",
                      row.providerInstanceId && "font-t3-medium",
                      onPress && "underline",
                    )}
                  >
                    {row.title}
                  </Text>
                  {row.status ? <StatusBadge status={row.status} /> : null}
                </View>
                {row.detail ? (
                  <Text className="text-xs text-foreground-muted">{row.detail}</Text>
                ) : null}
                {row.chips?.length ? (
                  <View className="flex-row flex-wrap gap-1">
                    {row.chips.map((chip) => (
                      <View key={chip} className="rounded-full border border-border px-1.5 py-px">
                        <Text className="text-3xs text-foreground-muted">{chip}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
      {props.rows.length > shown.length ? (
        <SmallButton
          label={`Show ${props.rows.length - shown.length} more`}
          onPress={() => setShowAll(true)}
        />
      ) : null}
    </View>
  );
}

function DigestView(props: { readonly digest: ToolDigest; readonly context: ToolDigestContext }) {
  const { digest } = props;
  const hasHead = Boolean(digest.status || digest.title);
  return (
    <View className="gap-2">
      {hasHead ? (
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          {digest.kind ? (
            <SymbolView
              name={KIND_ICON[digest.kind]}
              size={12}
              tintColorClassName="accent-icon-subtle"
            />
          ) : null}
          {digest.title ? (
            digest.href ? (
              <Text
                accessibilityRole="link"
                onPress={() => openLink(digest.href!)}
                className="shrink font-t3-medium text-xs text-foreground underline"
              >
                {digest.title}
              </Text>
            ) : (
              <Text selectable className="shrink font-t3-medium text-xs text-foreground">
                {digest.title}
              </Text>
            )
          ) : null}
          {digest.status ? <StatusBadge status={digest.status} /> : null}
        </View>
      ) : null}
      <ThreadButtons threads={digest.threads} context={props.context} />
      <Meta items={digest.meta} context={props.context} />
      {digest.error ? (
        <Text selectable className="text-xs text-adaptive-rose-600-400">
          {digest.error}
        </Text>
      ) : null}
      {digest.text ? (
        <LongText label={digest.textLabel} text={digest.text} context={props.context} />
      ) : null}
      {digest.rows?.length ? <DigestRows rows={digest.rows} context={props.context} /> : null}
      {digest.empty ? <Text className="text-xs text-foreground-muted">{digest.empty}</Text> : null}
    </View>
  );
}

function CopyableValue(props: { readonly label: string; readonly text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy ${props.label}`}
      onPress={() => {
        void Clipboard.setStringAsync(props.text).then(() => setCopied(true));
      }}
      className="flex-row items-baseline gap-2 active:opacity-60"
    >
      <Text className="text-2xs text-foreground-muted">{props.label}</Text>
      <Text
        numberOfLines={1}
        ellipsizeMode="middle"
        className="shrink font-mono text-2xs text-foreground"
      >
        {props.text}
      </Text>
      {copied ? (
        <Text className="font-t3-medium text-3xs text-adaptive-emerald-600-400">Copied</Text>
      ) : null}
    </Pressable>
  );
}

/** IDs and leftovers the digest leaves out, plus the raw result. */
function DetailsDisclosure(props: {
  readonly details: ToolDigest["details"];
  readonly raw: unknown;
}) {
  const [open, setOpen] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  return (
    <View className="gap-1.5">
      <SmallButton
        icon={open ? "chevron.down" : "chevron.right"}
        label="Details"
        onPress={() => setOpen(!open)}
      />
      {open ? (
        <View className="gap-1 pl-1">
          {props.details.map(([label, value]) => (
            <CopyableValue key={label} label={label} text={value} />
          ))}
          <SmallButton
            label={showRaw ? "Hide JSON" : "Show JSON"}
            onPress={() => setShowRaw(!showRaw)}
          />
          {showRaw ? (
            <Text selectable className="font-mono text-2xs leading-normal text-foreground-muted">
              {typeof props.raw === "string" ? props.raw : JSON.stringify(props.raw, null, 2)}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Digests for a tool result's blocks, or null when no block has one. */
export function toolOutputDigests(
  blocks: readonly ToolOutputBlock[] | null,
  toolName: string | null | undefined,
  input: unknown,
): ReadonlyArray<ToolDigest | null> | null {
  if (blocks === null) return null;
  // Some tools answer with nothing on purpose, such as a thread wait that ran out.
  if (blocks.length === 0) {
    const digest = toolResultDigest(toolName, null, input);
    return digest ? [digest] : null;
  }
  const digests = blocks.map((block) =>
    block.kind === "data" || (block.kind === "text" && /^error:/iu.test(block.text.trim()))
      ? toolResultDigest(toolName, block.kind === "data" ? block.value : block.text, input)
      : null,
  );
  return digests.some((digest) => digest !== null) ? digests : null;
}

/**
 * A tool result as digests (outcome, subject, links, text) with plain text for
 * the blocks that have none, and the IDs and raw value behind "Details".
 */
export function ToolOutputDigestView(props: {
  readonly blocks: readonly ToolOutputBlock[];
  readonly digests: ReadonlyArray<ToolDigest | null>;
  readonly raw: unknown;
  readonly context: ToolDigestContext;
}) {
  const details = props.digests.flatMap((digest) => digest?.details ?? []);
  const items =
    props.blocks.length === 0
      ? props.digests.map((digest, index) =>
          digest ? <DigestView key={index} digest={digest} context={props.context} /> : null,
        )
      : props.blocks.map((block, index) => {
          const digest = props.digests[index];
          if (digest) return <DigestView key={index} digest={digest} context={props.context} />;
          // Images render above as assets.
          if (block.kind === "image") return null;
          return (
            <Text
              key={index}
              selectable
              className="font-mono text-2xs leading-normal text-foreground-muted"
            >
              {block.kind === "text" ? block.text : JSON.stringify(block.value, null, 2)}
            </Text>
          );
        });
  return (
    <View className="gap-2">
      {items}
      <DetailsDisclosure details={details} raw={props.raw} />
    </View>
  );
}
