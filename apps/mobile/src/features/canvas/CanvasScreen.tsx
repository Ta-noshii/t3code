import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type {
  CanvasDocument,
  CanvasHostNativeMessage,
  CanvasHostTheme,
  CanvasSyncStatus,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, AppState, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { EmptyState } from "../../components/EmptyState";
import { formatEnvironmentQueryError } from "../../state/query";
import { canvasEnvironment, useCanvasEvents } from "../../state/canvas";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  canvasHostUrl,
  canvasNativeMessageScript,
  isCanvasHostUrl,
  readCanvasPageMessage,
} from "./canvasHostProtocol";
import {
  pasteCanvasImage,
  pickCanvasImages,
  takeCanvasPhoto,
  type CanvasImagePick,
} from "./canvasImages";
import type { CanvasRouteParams } from "./canvasRoutes";

// The page posts `ready` once its script runs. A server from before canvases
// answers the page's URL with the web app instead, which never does.
const READY_TIMEOUT_MS = 20_000;
// How long leaving waits for the last edit to save.
const LEAVE_FLUSH_TIMEOUT_MS = 4_000;

const IMAGE_ACTIONS = [
  { id: "library", title: "Photo Library", image: "photo" },
  { id: "camera", title: "Take Photo", image: "camera" },
  { id: "paste", title: "Paste Image", image: "doc.on.clipboard" },
];

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "document"; readonly document: CanvasDocument }
  | { readonly kind: "error"; readonly title: string; readonly detail: string };

const OLD_SERVER_ERROR: Loaded = {
  kind: "error",
  title: "The canvas editor didn't load",
  detail:
    "The computer this canvas is on may run an older T3 Code without the canvas editor. Update T3 Code there, or open the canvas on that computer.",
};

function BarButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={6}
      onPress={props.onPress}
      className="size-10 items-center justify-center rounded-full active:bg-subtle-strong"
    >
      <SymbolView name={props.icon} size={22} tintColorClassName="accent-icon" type="monochrome" />
    </Pressable>
  );
}

function statusLabel(status: CanvasSyncStatus, readOnly: boolean): string | null {
  if (readOnly) return "Read-only";
  if (status === "saving") return "Saving…";
  if (status === "error") return "Not saved, retrying";
  return null;
}

/** One canvas in the Excalidraw editor, hosted by the environment and saved through the app. */
export function CanvasScreen(props: StaticScreenProps<CanvasRouteParams>) {
  const { environmentId, path, projectId } = props.route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { themeAppearance } = useAppearancePreferences();
  const theme: CanvasHostTheme = themeAppearance === "dark" ? "dark" : "light";
  const preparedConnection = usePreparedConnection(environmentId);
  const hostUrl =
    preparedConnection._tag === "Some" ? canvasHostUrl(preparedConnection.value.httpBaseUrl) : null;

  const read = useAtomCommand(canvasEnvironment.read, { reportFailure: false });
  const save = useAtomCommand(canvasEnvironment.save, { reportFailure: false });
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<CanvasSyncStatus>("saved");
  const [generation, setGeneration] = useState(0);
  const webView = useRef<WebView<object>>(null);
  const statusRef = useRef(status);
  const readyRef = useRef(false);
  const themeRef = useRef(theme);
  const loadsRef = useRef(0);
  const crashesRef = useRef(0);
  const leavingRef = useRef<(() => void) | null>(null);

  const send = useCallback((message: CanvasHostNativeMessage) => {
    webView.current?.injectJavaScript(canvasNativeMessageScript(message));
  }, []);

  const readDocument = useCallback(
    async (knownFileIds?: ReadonlyArray<string>) =>
      read({
        environmentId,
        input: {
          canvas: projectId === undefined ? { path } : { path, projectId },
          ...(knownFileIds ? { knownFileIds: [...knownFileIds] } : {}),
        },
      }),
    [environmentId, path, projectId, read],
  );

  useEffect(() => {
    let cancelled = false;
    void readDocument().then((result) => {
      if (cancelled) return;
      setLoaded(
        result._tag === "Success"
          ? { kind: "document", document: result.value }
          : {
              kind: "error",
              title: "Couldn't open this canvas",
              detail: formatEnvironmentQueryError(result.cause),
            },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [readDocument]);

  const document = loaded.kind === "document" ? loaded.document : null;
  const readOnly = document?.canvas.readOnly ?? true;

  // Give up on a page that never says it is ready, also after a restart.
  useEffect(() => {
    if (document === null || hostUrl === null || ready) return;
    const timer = setTimeout(() => setLoaded(OLD_SERVER_ERROR), READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [document, hostUrl, ready]);

  useEffect(() => {
    themeRef.current = theme;
    if (readyRef.current) send({ type: "theme", theme });
  }, [send, theme]);

  useCanvasEvents(environmentId, (event) => {
    if (event.type === "changed" && event.path === path && readyRef.current) {
      send({ type: "changed", revision: event.revision });
    }
  });

  // Saving what is pending when the app leaves the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && readyRef.current) send({ type: "flush" });
    });
    return () => subscription.remove();
  }, [send]);

  // Leaving waits briefly for the last edit to reach the file.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        const pending = statusRef.current === "unsaved" || statusRef.current === "saving";
        if (!readyRef.current || !pending || leavingRef.current) return;
        event.preventDefault();
        let left = false;
        const leave = () => {
          if (left) return;
          left = true;
          leavingRef.current = null;
          navigation.dispatch(event.data.action);
        };
        leavingRef.current = leave;
        setTimeout(leave, LEAVE_FLUSH_TIMEOUT_MS);
        send({ type: "flush" });
      }),
    [navigation, send],
  );
  useEffect(() => {
    if (status === "saved" || status === "error") leavingRef.current?.();
  }, [status]);

  const onMessage = (event: WebViewMessageEvent) => {
    if (hostUrl === null || !isCanvasHostUrl(event.nativeEvent.url, hostUrl)) return;
    const message = readCanvasPageMessage(event.nativeEvent.data);
    if (message === null || document === null) return;
    switch (message.type) {
      case "ready": {
        readyRef.current = true;
        setReady(true);
        loadsRef.current += 1;
        if (loadsRef.current === 1) {
          send({ type: "load", document, theme: themeRef.current });
          return;
        }
        // A restarted page loads the file as it is now.
        void readDocument().then((result) => {
          if (result._tag === "Success") {
            send({ type: "load", document: result.value, theme: themeRef.current });
          }
        });
        return;
      }
      case "save":
        void save({ environmentId, input: { path, ...message.input } }).then((result) =>
          send({
            type: "saved",
            requestId: message.requestId,
            result: result._tag === "Success" ? result.value : null,
          }),
        );
        return;
      case "read":
        void readDocument(message.knownFileIds).then((result) =>
          send({
            type: "document",
            requestId: message.requestId,
            document: result._tag === "Success" ? result.value : null,
          }),
        );
        return;
      case "status":
        statusRef.current = message.status;
        setStatus(message.status);
        return;
    }
  };

  const restart = () => {
    // A page that keeps crashing its web process is not reloaded forever.
    crashesRef.current += 1;
    readyRef.current = false;
    setReady(false);
    if (crashesRef.current > 2) {
      setLoaded({
        kind: "error",
        title: "The canvas editor stopped",
        detail: "It ran out of memory or crashed. Your saved edits are in the file.",
      });
      return;
    }
    setGeneration((value) => value + 1);
  };

  const addImages = async (pick: () => Promise<CanvasImagePick>) => {
    const result = await pick();
    for (const image of result.images) {
      send({ type: "insert-image", dataURL: image.dataURL, mimeType: image.mimeType });
    }
    if (result.error) Alert.alert("Couldn't add the image", result.error);
  };

  const label = document ? statusLabel(status, readOnly) : null;
  return (
    <View
      className="flex-1 bg-background"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <View className="h-12 flex-row items-center gap-1 px-2">
        <BarButton icon="chevron.left" label="Back" onPress={() => navigation.goBack()} />
        <View className="min-w-0 flex-1 px-1">
          <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
            {document?.canvas.title ?? "Canvas"}
          </Text>
          {document ? (
            <Text
              className="text-xs text-foreground-muted"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {label ?? document.canvas.displayPath}
            </Text>
          ) : null}
        </View>
        {document && !readOnly && ready ? (
          <ControlPillMenu
            title="Add image"
            actions={IMAGE_ACTIONS}
            onPressAction={({ nativeEvent }) => {
              if (nativeEvent.event === "library") void addImages(pickCanvasImages);
              else if (nativeEvent.event === "camera") void addImages(takeCanvasPhoto);
              else if (nativeEvent.event === "paste") void addImages(pasteCanvasImage);
            }}
          >
            <BarButton icon="photo" label="Add image" />
          </ControlPillMenu>
        ) : null}
      </View>
      {loaded.kind === "error" ? (
        <View className="flex-1 justify-center">
          <EmptyState
            variant="plain"
            title={loaded.title}
            detail={loaded.detail}
            actionLabel="Go back"
            onAction={() => navigation.goBack()}
          />
        </View>
      ) : document === null || hostUrl === null ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : (
        <View className="flex-1">
          <WebView<object>
            key={generation}
            ref={webView}
            source={{ uri: hostUrl }}
            accessibilityLabel={document.canvas.title}
            style={{ flex: 1, backgroundColor: "transparent" }}
            // Excalidraw owns every gesture: pinch, pan, and drawing.
            scrollEnabled={false}
            bounces={false}
            overScrollMode="never"
            scalesPageToFit={false}
            setBuiltInZoomControls={false}
            setSupportMultipleWindows={false}
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            keyboardDisplayRequiresUserAction={false}
            hideKeyboardAccessoryView
            onShouldStartLoadWithRequest={(request) =>
              request.isTopFrame === false || isCanvasHostUrl(request.url, hostUrl)
            }
            onMessage={onMessage}
            onError={() => setLoaded(OLD_SERVER_ERROR)}
            onHttpError={(event) => {
              if (isCanvasHostUrl(event.nativeEvent.url, hostUrl)) setLoaded(OLD_SERVER_ERROR);
            }}
            onContentProcessDidTerminate={restart}
            onRenderProcessGone={restart}
          />
          {ready ? null : (
            <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
              <ActivityIndicator />
            </View>
          )}
        </View>
      )}
    </View>
  );
}
