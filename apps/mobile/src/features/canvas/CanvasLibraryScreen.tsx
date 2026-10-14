import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { CanvasSummary } from "@t3tools/contracts";
import { canvasGroup, normalizeCanvasGroup } from "@t3tools/shared/canvas";
import { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog, showTextInputDialog } from "../../components/ConfirmDialogHost";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { EmptyState } from "../../components/EmptyState";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { canvasEnvironment, useCanvasEvents } from "../../state/canvas";
import { useProject } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { canvasRouteParams, type CanvasLibraryRouteParams } from "./canvasRoutes";

const groupOf = (canvas: CanvasSummary) => (canvas.slug === null ? "" : canvasGroup(canvas.slug));

/** Top-level canvases first, then each group by name; canvases stay newest first. */
function groupCanvases(canvases: ReadonlyArray<CanvasSummary>) {
  const groups = new Map<string, CanvasSummary[]>();
  for (const canvas of canvases) {
    const group = groupOf(canvas);
    groups.set(group, [...(groups.get(group) ?? []), canvas]);
  }
  return [...groups]
    .map(([name, entries]) => ({ name, canvases: entries }))
    .sort((left, right) =>
      left.name === "" ? -1 : right.name === "" ? 1 : left.name.localeCompare(right.name),
    );
}

/** Rename, move to another group or a new one, and delete. */
function rowActions(canvas: CanvasSummary, groups: ReadonlyArray<string>) {
  const current = groupOf(canvas);
  const targets = [...new Set(["", ...groups])].filter((group) => group !== current);
  return [
    { id: "rename", title: "Rename", image: "pencil" },
    {
      id: "move",
      title: "Move to",
      image: "folder",
      subactions: [
        ...targets.map((group) => ({
          id: `move:${group}`,
          title: group === "" ? "Top level" : group,
        })),
        { id: "move-new", title: "New folder…", image: "folder.badge.plus" },
      ],
    },
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
}

function CanvasRow(props: {
  readonly canvas: CanvasSummary;
  readonly canEdit: boolean;
  readonly groups: ReadonlyArray<string>;
  readonly isLast: boolean;
  readonly onOpen: () => void;
  readonly onAction: (action: string) => void;
}) {
  const { canvas } = props;
  const detail = [
    canvas.elementCount === 1 ? "1 shape" : `${canvas.elementCount} shapes`,
    canvas.readOnly ? "read-only" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${canvas.title}, edited ${relativeTime(canvas.modifiedAt)} ago`}
      accessibilityHint={props.canEdit ? "Touch and hold to rename, move, or delete." : undefined}
      onPress={props.onOpen}
      className="flex-row items-center gap-3 bg-grouped-card px-4 active:bg-row-hover"
    >
      <SymbolView
        name="scribble.variable"
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
      <View
        className={cn(
          "min-w-0 flex-1 flex-row items-center gap-3 py-3",
          !props.isLast && "border-b border-border-subtle",
        )}
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {canvas.title}
          </Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1} ellipsizeMode="middle">
            {canvas.displayPath}
          </Text>
        </View>
        <View className="items-end gap-0.5">
          <Text className="text-sm tabular-nums text-foreground-muted">
            {relativeTime(canvas.modifiedAt)}
          </Text>
          <Text className="text-2xs text-foreground-tertiary">{detail}</Text>
        </View>
      </View>
    </Pressable>
  );
  if (!props.canEdit) return row;
  return (
    <ControlPillMenu
      shouldOpenOnLongPress
      title={canvas.title}
      actions={rowActions(canvas, props.groups)}
      onPressAction={({ nativeEvent }) => props.onAction(nativeEvent.event)}
    >
      {row}
    </ControlPillMenu>
  );
}

/** A project's canvases: open, start, rename, and delete them. */
export function CanvasLibraryScreen(props: StaticScreenProps<CanvasLibraryRouteParams>) {
  const { environmentId, projectId } = props.route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const project = useProject(
    useMemo(() => ({ environmentId, projectId }), [environmentId, projectId]),
  );
  const list = useEnvironmentQuery(
    useMemo(
      () => canvasEnvironment.list({ environmentId, input: { projectId } }),
      [environmentId, projectId],
    ),
  );
  const canWrite = useAtomValue(canvasEnvironment.create.permissionAtom(environmentId));
  const create = useAtomCommand(canvasEnvironment.create);
  const rename = useAtomCommand(canvasEnvironment.rename);
  const remove = useAtomCommand(canvasEnvironment.delete);
  const { refresh } = list;
  const canvases = list.data?.canvases;

  useFocusEffect(useCallback(() => refresh(), [refresh]));
  useCanvasEvents(environmentId, (event) => {
    if (
      (event.type === "library-changed" && event.projectId === projectId) ||
      (event.type === "changed" && canvases?.some((canvas) => canvas.path === event.path))
    ) {
      refresh();
    }
  });

  const open = useCallback(
    (canvas: Pick<CanvasSummary, "path" | "projectId">) =>
      navigation.navigate("Canvas", canvasRouteParams(environmentId, canvas)),
    [environmentId, navigation],
  );

  const groups = useMemo(() => groupCanvases(canvases ?? []), [canvases]);
  const groupNames = groups.map((group) => group.name);

  const startNew = (group = "") =>
    showTextInputDialog({
      title: group === "" ? "New canvas" : `New canvas in ${group}`,
      initialValue: "",
      confirmText: "Create",
      onConfirm: (title) => {
        if (title.trim().length === 0) return;
        void create({
          environmentId,
          input: { projectId, title: title.trim(), ...(group === "" ? {} : { group }) },
        }).then((result) => {
          refresh();
          if (result._tag === "Success") open(result.value);
        });
      },
    });

  /** Asks for a folder name, then hands it to `then`. */
  const askFolder = (then: (group: string) => void) =>
    showTextInputDialog({
      title: "New folder",
      initialValue: "",
      confirmText: "Next",
      onConfirm: (name) => {
        const group = normalizeCanvasGroup(name);
        if (group) then(group);
      },
    });

  const move = (canvas: CanvasSummary, group: string) =>
    void rename({ environmentId, input: { path: canvas.path, title: canvas.title, group } }).then(
      refresh,
    );

  const runAction = (canvas: CanvasSummary, action: string) => {
    if (action === "rename") {
      showTextInputDialog({
        title: "Rename canvas",
        initialValue: canvas.title,
        confirmText: "Rename",
        onConfirm: (title) => {
          if (title.trim().length === 0 || title.trim() === canvas.title) return;
          void rename({ environmentId, input: { path: canvas.path, title: title.trim() } }).then(
            refresh,
          );
        },
      });
    } else if (action.startsWith("move:")) {
      move(canvas, action.slice("move:".length));
    } else if (action === "move-new") {
      askFolder((group) => move(canvas, group));
    } else if (action === "delete") {
      showConfirmDialog({
        title: `Delete "${canvas.title}"?`,
        message: `${canvas.displayPath} will be removed from the project.`,
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => {
          void remove({ environmentId, input: { path: canvas.path } }).then(refresh);
        },
      });
    }
  };

  const folder = list.data?.folder ?? ".canvases";
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScreenHeader
        title="Canvases"
        subtitle={project?.title}
        sidebar={false}
        onBack={() => navigation.goBack()}
        actions={
          canWrite
            ? [
                {
                  accessibilityLabel: "New folder",
                  icon: "folder.badge.plus",
                  // A folder holds canvases; it is made with its first one.
                  onPress: () => askFolder(startNew),
                },
                { accessibilityLabel: "New canvas", icon: "plus", onPress: () => startNew() },
              ]
            : undefined
        }
      />
      <MaterialScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-3 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
        >
          {canvases === undefined ? (
            list.error !== null ? (
              <EmptyState
                variant="plain"
                title="Canvases are unavailable"
                detail={`${list.error}\n\nIf this computer runs an older T3 Code, update it to use canvases.`}
                actionLabel="Try again"
                onAction={refresh}
              />
            ) : (
              <View className="items-center py-10">
                <ActivityIndicator />
              </View>
            )
          ) : canvases.length === 0 ? (
            <EmptyState
              variant="plain"
              title="No canvases yet"
              detail={`Sketch diagrams here, or ask the agent to draw one. They are saved as Excalidraw files in ${folder}.`}
              {...(canWrite ? { actionLabel: "New canvas", onAction: () => startNew() } : {})}
            />
          ) : (
            <>
              {groups.map((group) => (
                <View key={`group:${group.name}`} className="gap-2">
                  {group.name === "" ? null : (
                    <View className="flex-row items-center gap-2 px-2 pt-2">
                      <SymbolView
                        name="folder"
                        size={15}
                        tintColorClassName="accent-foreground-muted"
                        type="monochrome"
                      />
                      <Text
                        className="min-w-0 flex-1 text-sm font-t3-medium text-foreground-muted"
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {group.name}
                      </Text>
                      {canWrite ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`New canvas in ${group.name}`}
                          hitSlop={10}
                          onPress={() => startNew(group.name)}
                        >
                          <SymbolView
                            name="plus"
                            size={17}
                            tintColorClassName="accent-icon"
                            type="monochrome"
                          />
                        </Pressable>
                      ) : null}
                    </View>
                  )}
                  <View className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card">
                    {group.canvases.map((canvas, index) => (
                      <CanvasRow
                        key={canvas.path}
                        canvas={canvas}
                        canEdit={canWrite && canvas.slug !== null}
                        groups={groupNames}
                        isLast={index === group.canvases.length - 1}
                        onOpen={() => open(canvas)}
                        onAction={(action) => runAction(canvas, action)}
                      />
                    ))}
                  </View>
                </View>
              ))}
              <Text className="px-2 text-sm text-foreground-muted">
                Saved in {folder}. Touch and hold a canvas to rename, move, or delete it.
              </Text>
            </>
          )}
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
