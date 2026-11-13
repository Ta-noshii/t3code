import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationV2AgentProgressItemStatus,
  OrchestrationV2AgentProgressSummary,
  ThreadId,
} from "@t3tools/contracts";
import {
  agentProgressFinished,
  agentProgressListOrder,
  agentProgressSegmentStatus,
  isAgentProgressComplete,
} from "@t3tools/shared/agentProgress";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";

// Past this many items one segment per item is thinner than a few points.
const MAX_ITEM_SEGMENTS = 40;

const SEGMENT_CLASS: Record<OrchestrationV2AgentProgressItemStatus, string> = {
  done: "bg-adaptive-emerald-600-400",
  failed: "bg-danger-foreground",
  running: "bg-adaptive-sky-600-400",
  skipped: "bg-foreground-muted/50",
  pending: "bg-foreground/15",
};

const STATUS_SYMBOL = {
  done: "checkmark.circle.fill",
  failed: "xmark.circle.fill",
  running: "circle.inset.filled",
  skipped: "slash.circle",
  pending: "circle",
} as const satisfies Record<OrchestrationV2AgentProgressItemStatus, string>;

const STATUS_TINT: Record<OrchestrationV2AgentProgressItemStatus, string> = {
  done: "accent-adaptive-emerald-600-400",
  failed: "accent-danger-foreground",
  running: "accent-adaptive-sky-600-400",
  skipped: "accent-icon-subtle",
  pending: "accent-icon-subtle",
};

const STATUS_LABEL: Record<OrchestrationV2AgentProgressItemStatus, string> = {
  running: "Running",
  failed: "Failed",
  pending: "Pending",
  done: "Done",
  skipped: "Skipped",
};

/**
 * One segment per item in tracker order, so you can see where the work is. Long trackers
 * fall back to one stacked bar.
 */
export function AgentProgressBar(props: {
  readonly summary: OrchestrationV2AgentProgressSummary;
  readonly className?: string;
}) {
  const { summary } = props;
  const base = `flex-row overflow-hidden ${props.className ?? "h-1.5"}`;
  if (summary.total === 0) {
    return <View className={`${base} rounded-full ${SEGMENT_CLASS.pending}`} />;
  }
  if (summary.total <= MAX_ITEM_SEGMENTS) {
    return (
      <View className={`${base} gap-0.5`}>
        {Array.from(summary.segments, (segment, index) => (
          <View
            // The tracker keeps item order, so a position is a stable key.
            key={index}
            className={`h-full min-w-0 flex-1 rounded-full ${SEGMENT_CLASS[agentProgressSegmentStatus(segment)]}`}
          />
        ))}
      </View>
    );
  }
  const pending = summary.total - agentProgressFinished(summary) - summary.running;
  const parts = [
    ["done", summary.done],
    ["failed", summary.failed],
    ["skipped", summary.skipped],
    ["running", summary.running],
    ["pending", pending],
  ] as const;
  return (
    <View className={`${base} rounded-full`}>
      {parts.map(([status, count]) =>
        count === 0 ? null : (
          <View
            key={status}
            className={`h-full ${SEGMENT_CLASS[status]}`}
            style={{ width: `${(count / summary.total) * 100}%` }}
          />
        ),
      )}
    </View>
  );
}

type ProgressTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function ThreadProgressSheet({ route }: StaticScreenProps<ProgressTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const ref = scopeThreadRef(route.params.environmentId, route.params.threadId);
  const summary = useAtomValue(environmentThreadShells.threadShellAtom(ref))?.progressSummary;
  const progress = useAtomValue(environmentThreadDetails.progressAtom(ref));
  const items = progress === null ? [] : agentProgressListOrder(progress.items);
  const complete = summary != null && isAgentProgressComplete(summary);
  const pending =
    summary == null ? 0 : summary.total - agentProgressFinished(summary) - summary.running;
  const counts =
    summary == null
      ? []
      : (
          [
            ["running", summary.running],
            ["failed", summary.failed],
            ["pending", pending],
            ["done", summary.done],
            ["skipped", summary.skipped],
          ] as const
        ).filter(([, count]) => count > 0);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title={summary?.title ?? "Progress"} onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="px-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {summary == null ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              This thread has no progress tracker.
            </Text>
          ) : (
            <>
              <View className="gap-3 pb-3 pt-2">
                <View className="flex-row items-baseline justify-between gap-3">
                  <Text
                    className={`font-t3-bold text-2xl tabular-nums ${complete ? "text-adaptive-emerald-600-400" : "text-foreground"}`}
                  >
                    {agentProgressFinished(summary)}
                    <Text className="font-t3-medium text-base text-foreground-muted">
                      {` of ${summary.total}`}
                    </Text>
                  </Text>
                  <Text className="text-sm text-foreground-muted tabular-nums">
                    {summary.total === 0
                      ? "No items"
                      : `${Math.round((agentProgressFinished(summary) / summary.total) * 100)}%`}
                  </Text>
                </View>
                <AgentProgressBar summary={summary} className="h-2" />
                <View className="flex-row flex-wrap gap-x-4 gap-y-1">
                  {counts.map(([status, count]) => (
                    <View key={status} className="flex-row items-center gap-1.5">
                      <View className={`size-2 rounded-full ${SEGMENT_CLASS[status]}`} />
                      <Text className="text-xs text-foreground-muted tabular-nums">
                        {count} {STATUS_LABEL[status].toLowerCase()}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
              {progress === null ? (
                <Text className="py-4 text-sm text-foreground-muted">Loading items…</Text>
              ) : (
                items.map((item) => {
                  const settled = item.status === "done" || item.status === "skipped";
                  return (
                    <View
                      key={item.id}
                      accessible
                      accessibilityLabel={`${STATUS_LABEL[item.status]}: ${item.label ?? item.id}`}
                      className="flex-row items-start gap-3 border-t border-border py-3"
                    >
                      <View className="pt-0.5">
                        <SymbolView
                          name={STATUS_SYMBOL[item.status]}
                          size={16}
                          tintColorClassName={STATUS_TINT[item.status]}
                          type="monochrome"
                        />
                      </View>
                      <Text
                        className={`min-w-0 flex-1 text-sm ${settled ? "text-foreground-muted" : "text-foreground"} ${item.status === "running" ? "font-t3-medium" : ""}`}
                      >
                        {item.label ?? item.id}
                      </Text>
                      {item.status === "running" || item.status === "failed" ? (
                        <Text
                          className={`pt-0.5 text-xs ${item.status === "failed" ? "text-danger-foreground" : "text-adaptive-sky-600-400"}`}
                        >
                          {STATUS_LABEL[item.status]}
                        </Text>
                      ) : null}
                    </View>
                  );
                })
              )}
            </>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
