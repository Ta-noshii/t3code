import { describe, expect, it } from "vite-plus/test";

import {
  canvasHostUrl,
  canvasNativeMessageScript,
  isCanvasHostUrl,
  readCanvasPageMessage,
} from "./canvasHostProtocol";

describe("canvas host protocol", () => {
  it("finds the host page on the environment's origin", () => {
    expect(canvasHostUrl("https://abc.t3.dev/")).toBe("https://abc.t3.dev/canvas-host.html");
    expect(canvasHostUrl("http://127.0.0.1:3790")).toBe("http://127.0.0.1:3790/canvas-host.html");
  });

  it("only treats the host page as the host page", () => {
    const host = "https://abc.t3.dev/canvas-host.html";
    expect(isCanvasHostUrl(host, host)).toBe(true);
    expect(isCanvasHostUrl(`${host}#x`, host)).toBe(true);
    expect(isCanvasHostUrl("https://abc.t3.dev/canvas-host.html.evil.com/", host)).toBe(false);
    expect(isCanvasHostUrl("https://abc.t3.dev/", host)).toBe(false);
  });

  it("reads page messages and drops anything else", () => {
    expect(readCanvasPageMessage(JSON.stringify({ type: "ready" }))).toEqual({ type: "ready" });
    expect(
      readCanvasPageMessage(JSON.stringify({ type: "read", requestId: 3, knownFileIds: ["a"] })),
    ).toEqual({ type: "read", requestId: 3, knownFileIds: ["a"] });
    expect(readCanvasPageMessage(JSON.stringify({ type: "status", status: "lost" }))).toBeNull();
    expect(readCanvasPageMessage(JSON.stringify({ type: "read", requestId: -1 }))).toBeNull();
    expect(readCanvasPageMessage("{")).toBeNull();
  });

  it("posts a message the page decodes back to the same value", () => {
    const message = {
      type: "insert-image",
      dataURL: 'data:image/png;base64,"x"',
      mimeType: "image/png",
    } as const;
    let posted: unknown;
    const window = { postMessage: (data: unknown) => (posted = data) };
    new Function("window", canvasNativeMessageScript(message))(window);
    expect(JSON.parse(posted as string)).toEqual(message);
  });
});
