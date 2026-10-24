import type { HtmlRenderStateRequest } from "./htmlRender.ts";

/** The synchronous subset of `localStorage` the store needs; mobile passes expo-sqlite's kv store. */
export interface HtmlRenderStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "t3:html-render-state:";
const INDEX_KEY = `${PREFIX}index`;
/** Renders whose state is kept; saving another drops the one saved longest ago. */
export const HTML_RENDER_STATE_MAX_ENTRIES = 200;

function readIndex(storage: HtmlRenderStateStorage): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(INDEX_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Carries out a render's `t3/state` request against `storage` and returns the
 * value to reply with. `renderKey` names the render, such as its environment
 * and attachment id, so each page reads only its own state.
 */
export function applyHtmlRenderStateRequest(
  storage: HtmlRenderStateStorage,
  renderKey: string,
  request: HtmlRenderStateRequest,
): string | null {
  const key = PREFIX + renderKey;
  if (request.op === "get") return storage.getItem(key);
  const index = readIndex(storage).filter((entry) => entry !== key);
  if (request.value === null) {
    storage.removeItem(key);
  } else {
    index.push(key);
    for (const evicted of index.splice(
      0,
      Math.max(0, index.length - HTML_RENDER_STATE_MAX_ENTRIES),
    )) {
      storage.removeItem(evicted);
    }
    storage.setItem(key, request.value);
  }
  storage.setItem(INDEX_KEY, JSON.stringify(index));
  return request.value;
}
