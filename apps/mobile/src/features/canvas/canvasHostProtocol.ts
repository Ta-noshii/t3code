import {
  CANVAS_HOST_PAGE_PATH,
  CanvasHostPageMessage,
  type CanvasHostNativeMessage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodePageMessage = Schema.decodeUnknownOption(Schema.fromJsonString(CanvasHostPageMessage));

/** The editor page on the environment's own HTTP origin, which T3 Connect tunnels too. */
export function canvasHostUrl(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/\/+$/, "") + CANVAS_HOST_PAGE_PATH;
}

/** True for the host page itself, with or without a query or fragment. */
export function isCanvasHostUrl(url: string, hostUrl: string): boolean {
  return url === hostUrl || url.startsWith(`${hostUrl}?`) || url.startsWith(`${hostUrl}#`);
}

/** A message the page posted, or null for anything else. */
export function readCanvasPageMessage(data: string): CanvasHostPageMessage | null {
  return Option.getOrNull(decodePageMessage(data));
}

/** Script that hands the page a message; the page listens for string `message` events. */
export function canvasNativeMessageScript(message: CanvasHostNativeMessage): string {
  return `window.postMessage(${JSON.stringify(JSON.stringify(message))}, "*"); true;`;
}
