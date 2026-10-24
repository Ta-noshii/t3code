import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CommandId, MessageId } from "@t3tools/contracts";
import {
  htmlRenderError,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  htmlRenderResult,
  readHtmlRenderMessageRequest,
  readHtmlRenderStateRequest,
  htmlRenderStateResult,
  type HtmlRenderReference,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { applyHtmlRenderStateRequest } from "@t3tools/shared/htmlRenderState";
import { Storage } from "expo-sqlite/kv-store";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Platform, Pressable, View, type ColorValue } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { mobileHtmlRenderTheme } from "../../lib/htmlRenderTheme";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { uuidv4 } from "../../lib/uuid";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const ROW_BOTTOM_MARGIN = 8;
const FULL_SCREEN_GUTTER = 16;

export function htmlRenderRowHeight(frameHeight: number) {
  return frameHeight + ROW_BOTTOM_MARGIN;
}

function useHtmlRenderTheme() {
  const { themeId, themeAppearance, themeVariables, systemColorsActive } =
    useAppearancePreferences();
  return useMemo(
    () =>
      mobileHtmlRenderTheme({
        themeId,
        appearance: themeAppearance,
        variables: themeVariables,
        systemColors: systemColorsActive,
        platform: Platform.OS,
      }),
    [themeId, themeAppearance, themeVariables, systemColorsActive],
  );
}

function postTheme(view: WebView<object> | null, theme: HtmlRenderTheme) {
  view?.injectJavaScript(
    `window.postMessage(${JSON.stringify(htmlRenderThemeMessage(theme))}, "*"); true;`,
  );
}

const OVERFLOW_MESSAGE_TYPE = "t3-html-render-overflow";

const OVERFLOW_SCRIPT = `(function(){var last;function report(){var d=document.documentElement,b=document.body;var x=Math.max(d.scrollWidth,b?b.scrollWidth:0)>window.innerWidth+1,y=Math.max(d.scrollHeight,b?b.scrollHeight:0)>window.innerHeight+1,o=x+","+y;if(o===last)return;last=o;window.ReactNativeWebView.postMessage(JSON.stringify({type:${JSON.stringify(OVERFLOW_MESSAGE_TYPE)},x:x,y:y}));}report();if(window.ResizeObserver){var r=new ResizeObserver(report);r.observe(document.documentElement);if(document.body)r.observe(document.body);}window.addEventListener("resize",report);})();true;`;

type Overflow = { readonly x: boolean; readonly y: boolean };

const NO_OVERFLOW: Overflow = { x: false, y: false };

function parseMessage(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function readOverflowMessage(message: unknown): Overflow | null {
  return typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === OVERFLOW_MESSAGE_TYPE &&
    "x" in message &&
    typeof message.x === "boolean" &&
    "y" in message &&
    typeof message.y === "boolean"
    ? { x: message.x, y: message.y }
    : null;
}

// A WebView cannot tell whether the reader just tapped the page, so a page's
// message is sent only once the reader confirms it.
const confirmSend = (text: string) =>
  new Promise<boolean>((resolve) => {
    Alert.alert(
      "Send this message from the page?",
      text,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Send", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

const withoutFragment = (url: string) => url.split("#", 1)[0];

// A page's `window.t3.saveState` state, kept on the device like web's localStorage.
const htmlRenderStateStorage = {
  getItem: (key: string) => Storage.getItemSync(key),
  setItem: (key: string, value: string) => Storage.setItemSync(key, value),
  removeItem: (key: string) => {
    Storage.removeItemSync(key);
  },
};

export function HtmlRenderWebView(props: {
  readonly uri: string;
  readonly title: string;
  readonly nested: boolean;
  readonly onLoadError?: () => void;
  /** Sends the page's `window.t3.sendMessage` text as the reader's next message. */
  readonly onSendMessage?: (text: string) => Promise<void>;
  /** Names the render whose `window.t3.saveState` state the page keeps; without it, saving fails. */
  readonly stateKey?: string | undefined;
}) {
  const theme = useHtmlRenderTheme();
  const [initialTheme] = useState(theme);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [overflow, setOverflow] = useState(NO_OVERFLOW);
  const webView = useRef<WebView<object>>(null);
  const crashes = useRef(0);
  const shownTheme = useRef<HtmlRenderTheme | null>(null);
  const source = useMemo(
    () => ({ uri: props.uri + htmlRenderThemeFragment(initialTheme) }),
    [props.uri, initialTheme],
  );
  useEffect(() => {
    if (shownTheme.current === null || shownTheme.current === theme) return;
    shownTheme.current = theme;
    postTheme(webView.current, theme);
  }, [theme]);
  const restart = () => {
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onLoadError?.();
      return;
    }
    shownTheme.current = null;
    setLoaded(false);
    setOverflow(NO_OVERFLOW);
    setGeneration((value) => value + 1);
  };
  const reply = (message: object) =>
    webView.current?.injectJavaScript(`window.postMessage(${JSON.stringify(message)}, "*"); true;`);
  const receive = (event: WebViewMessageEvent) => {
    const message = parseMessage(event.nativeEvent.data);
    const next = readOverflowMessage(message);
    if (next !== null) {
      setOverflow(next);
      return;
    }
    const stateRequest = readHtmlRenderStateRequest(message);
    if (stateRequest !== undefined) {
      if (props.stateKey === undefined) {
        reply(htmlRenderError(stateRequest.id, "Saving isn't available here."));
        return;
      }
      try {
        reply(
          htmlRenderStateResult(
            stateRequest.id,
            applyHtmlRenderStateRequest(htmlRenderStateStorage, props.stateKey, stateRequest),
          ),
        );
      } catch {
        reply(htmlRenderError(stateRequest.id, "The state could not be saved."));
      }
      return;
    }
    const request = readHtmlRenderMessageRequest(message);
    if (request === undefined) return;
    const send = props.onSendMessage;
    if (send === undefined) {
      reply(htmlRenderError(request.id, "Messages can't be sent from here."));
      return;
    }
    void confirmSend(request.text)
      .then(async (approved) => {
        if (!approved) throw new Error("Declined by the reader.");
        await send(request.text);
      })
      .then(
        () => reply(htmlRenderResult(request.id)),
        (cause: unknown) =>
          reply(
            htmlRenderError(
              request.id,
              cause instanceof Error ? cause.message : "The message was not sent.",
            ),
          ),
      );
  };
  const scrollable = !props.nested || overflow.x || overflow.y;
  return (
    <View
      style={
        props.nested
          ? { flex: 1 }
          : {
              flex: 1,
              paddingHorizontal: FULL_SCREEN_GUTTER,
              backgroundColor: theme.variables["--background"],
            }
      }
    >
      <WebView<object>
        key={generation}
        ref={webView}
        source={source}
        accessibilityLabel={props.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        allowsInlineMediaPlayback
        automaticallyAdjustContentInsets={!props.nested}
        bounces={!props.nested}
        showsVerticalScrollIndicator={!props.nested}
        showsHorizontalScrollIndicator={!props.nested}
        scrollEnabled={scrollable}
        // Android only: the page holds vertical drags until it reaches an edge,
        // then hands them to the feed (patches/react-native-webview). A page
        // that only overflows sideways leaves vertical drags to the feed.
        nestedScrollEnabled={props.nested && overflow.y}
        overScrollMode={props.nested ? "never" : "always"}
        onShouldStartLoadWithRequest={(request) =>
          request.isTopFrame === false ||
          withoutFragment(request.url) === withoutFragment(props.uri)
        }
        onOpenWindow={(event) => {
          const url = event.nativeEvent.targetUrl;
          if (/^https?:/i.test(url)) void tryOpenExternalUrl(url, "html-render");
        }}
        onLoadEnd={() => {
          setLoaded(true);
          shownTheme.current = theme;
          if (theme !== initialTheme) postTheme(webView.current, theme);
        }}
        onError={props.onLoadError}
        onHttpError={props.onLoadError}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
        onMessage={receive}
        {...(props.nested ? { injectedJavaScript: OVERFLOW_SCRIPT } : {})}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      )}
    </View>
  );
}

export function ThreadHtmlRender(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly render: HtmlRenderReference;
  readonly frameWidth: number;
  readonly iconColor: ColorValue;
}) {
  const navigation = useNavigation();
  const { attachmentId, title } = props.render;
  const height = htmlRenderFrameHeight(props.render, props.frameWidth);
  const fileName = htmlRenderFileName(title);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  const asset = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retried = useRef(false);
  const handleLoadError = () => {
    if (retried.current) {
      setFailed(true);
      return;
    }
    retried.current = true;
    void refresh().then((next) => {
      if (next === null) setFailed(true);
      else if (next !== uri) setUri(next);
      else setAttempt((value) => value + 1);
    });
  };

  // Through the outbox like a typed message, so it survives a dropped
  // connection; the thread's own settings fill in when it sends.
  const sendMessage = (text: string) =>
    enqueueThreadOutboxMessage({
      environmentId: props.environmentId,
      threadId: props.threadId,
      messageId: MessageId.make(uuidv4()),
      commandId: CommandId.make(uuidv4()),
      text,
      attachments: [],
      dispatchMode: "queue",
      createdAt: new Date().toISOString(),
    });

  return (
    <View style={{ marginBottom: ROW_BOTTOM_MARGIN }}>
      <View style={{ height }}>
        {uri !== null && !failed ? (
          <HtmlRenderWebView
            key={`${uri}:${attempt}`}
            uri={uri}
            title={title}
            nested
            onLoadError={handleLoadError}
            onSendMessage={sendMessage}
            stateKey={`${props.environmentId}:${attachmentId}`}
          />
        ) : failed || asset._tag === "Failure" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Reload ${title}`}
            className="flex-1 items-center justify-center"
            onPress={() => {
              retried.current = false;
              setFailed(false);
              if (uri === null) void refresh().then((next) => next !== null && setUri(next));
            }}
          >
            <Text className="text-sm text-foreground-muted">Page unavailable</Text>
          </Pressable>
        ) : (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator />
          </View>
        )}
        {uri !== null && !failed ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${title}`}
            hitSlop={8}
            className="absolute right-1.5 top-1.5 h-7 w-7 items-center justify-center rounded-full border border-border/60 bg-card/80"
            onPress={() =>
              navigation.navigate("ThreadAttachment", {
                environmentId: String(props.environmentId),
                threadId: String(props.threadId),
                attachmentId,
                name: fileName,
                mimeType: "text/html",
                sizeBytes: "0",
                htmlRender: "1",
              })
            }
          >
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={12}
              tintColor={props.iconColor}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
