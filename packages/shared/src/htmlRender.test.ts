import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import {
  injectHtmlRenderBootstrap,
  readHtmlRenderImageRequest,
  readHtmlRenderLinkRequest,
  readHtmlRenderMessageRequest,
} from "./htmlRender.ts";
import { htmlRenderFromToolItem } from "./toolOutput.ts";

const reference = { attachmentId: "thread-abc-123.html", title: "Chart", height: 420 };

describe("injectHtmlRenderBootstrap", () => {
  it("puts the theme ahead of the page's own head content", () => {
    const html =
      "<!doctype html><html><head><style>:root{--background:red}</style></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    const themeAt = injected.indexOf('<style id="t3-theme">');
    expect(themeAt).toBeGreaterThan(injected.indexOf("<head>"));
    expect(themeAt).toBeLessThan(injected.indexOf(":root{--background:red}"));
    expect(injected).toContain('<meta charset="utf-8">');
    expect(injected).toContain('name="viewport"');
  });

  it("wraps fragments without a head and keeps existing meta tags", () => {
    const fragment =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><p>hi</p>';
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.match(/charset/g)).toHaveLength(1);
    expect(injected.match(/name="viewport"/g)).toHaveLength(1);
    expect(injected.endsWith("<p>hi</p>")).toBe(true);
  });

  it.each(["textarea", "iframe", "plaintext"])("keeps the bootstrap outside %s content", (tag) => {
    const fragment = `<${tag}><head><meta name="viewport"></head></${tag}>`;
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf(`<${tag}>`));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it.each([
    '<template><head><meta name="viewport"></head></template>',
    '<template><template>inner</template><head><meta name="viewport"></head></template>',
  ])("keeps the bootstrap outside inert template content: %s", (fragment) => {
    const injected = injectHtmlRenderBootstrap(fragment);
    expect(injected.startsWith("<!doctype html><head>")).toBe(true);
    expect(injected.indexOf('<style id="t3-theme">')).toBeLessThan(injected.indexOf("<template>"));
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
    expect(injected.endsWith(fragment)).toBe(true);
  });

  it("ignores tags written inside comments and scripts", () => {
    const html =
      '<!-- copy <head> and <meta name="viewport"> here --><html><head>' +
      "<script>const tag = '<meta name=\"viewport\">';</script></head><body>x</body></html>";
    const injected = injectHtmlRenderBootstrap(html);
    expect(injected.indexOf('<style id="t3-theme">')).toBeGreaterThan(
      injected.indexOf("<html><head>"),
    );
    expect(injected).toContain('<meta name="viewport" content="width=device-width');
  });
});

describe("readHtmlRenderLinkRequest", () => {
  it("accepts only http(s) URLs in an MCP Apps ui/open-link request", () => {
    const link = (url: unknown, modifiers = {}) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/open-link",
      params: { url, ...modifiers },
    });
    expect(readHtmlRenderLinkRequest(link("https://example.com/a"))).toEqual({
      id: 1,
      url: "https://example.com/a",
      metaKey: false,
      ctrlKey: false,
    });
    expect(
      readHtmlRenderLinkRequest(link("https://example.com/a", { metaKey: true, ctrlKey: "yes" })),
    ).toEqual({ id: 1, url: "https://example.com/a", metaKey: true, ctrlKey: false });
    expect(readHtmlRenderLinkRequest(link("javascript:alert(1)"))).toBeUndefined();
    expect(readHtmlRenderLinkRequest(link("file:///etc/passwd"))).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({
        jsonrpc: "2.0",
        method: "ui/open-link",
        params: { url: "https://example.com" },
      }),
    ).toBeUndefined();
    expect(
      readHtmlRenderLinkRequest({ type: "t3-html-render-link", url: "https://example.com" }),
    ).toBeUndefined();
  });
});

describe("readHtmlRenderMessageRequest", () => {
  const request = (params: unknown, id: unknown = "t3-message-1") => ({
    jsonrpc: "2.0",
    id,
    method: "ui/message",
    params,
  });
  const text = (value: unknown) => ({ type: "text", text: value });

  it("joins the text parts of a user message", () => {
    expect(
      readHtmlRenderMessageRequest(
        request({ role: "user", content: [text(" Fix "), { type: "image" }, text("it ")] }),
      ),
    ).toEqual({ id: "t3-message-1", text: "Fix it" });
  });

  it("rejects other roles, empty or oversized text, and malformed requests", () => {
    expect(
      readHtmlRenderMessageRequest(request({ role: "assistant", content: [text("x")] })),
    ).toBeUndefined();
    expect(
      readHtmlRenderMessageRequest(request({ role: "user", content: [text("  ")] })),
    ).toBeUndefined();
    expect(
      readHtmlRenderMessageRequest(request({ role: "user", content: [text("x".repeat(20_001))] })),
    ).toBeUndefined();
    expect(
      readHtmlRenderMessageRequest(request({ role: "user", content: [text("x")] }, null)),
    ).toBeUndefined();
    expect(readHtmlRenderMessageRequest(request({ role: "user", content: "x" }))).toBeUndefined();
  });
});

describe("window.t3.sendMessage", () => {
  // Runs the injected bootstrap against a minimal framed window.
  const framedPage = () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(injectHtmlRenderBootstrap("<p>x</p>"))![1]!;
    const listeners: Array<(event: { data: unknown; source: unknown }) => void> = [];
    const posted: unknown[] = [];
    const parent = { postMessage: (message: unknown) => posted.push(message) };
    const window: Record<string, unknown> = {
      parent,
      addEventListener: (type: string, listener: (typeof listeners)[number]) => {
        if (type === "message") listeners.push(listener);
      },
    };
    NodeVM.runInNewContext(script, {
      window,
      document: {
        getElementById: () => ({ textContent: "" }),
        addEventListener: () => undefined,
        documentElement: {},
      },
      location: { hash: "", pathname: "/", search: "" },
      history: { replaceState: () => undefined },
    });
    const t3 = window.t3 as { sendMessage: (text: unknown) => Promise<void> };
    const deliver = (data: unknown, source: unknown = parent) =>
      listeners.forEach((listener) => listener({ data, source }));
    return { t3, posted, deliver };
  };

  it("posts a ui/message request and settles on the client's reply", async () => {
    const page = framedPage();
    const sent = page.t3.sendMessage("Fix it");
    const [message] = page.posted as Array<{ id: string }>;
    expect(readHtmlRenderMessageRequest(message)).toEqual({ id: message!.id, text: "Fix it" });
    // A reply from anything but the parent is ignored.
    page.deliver({ jsonrpc: "2.0", id: message!.id, error: { message: "nope" } }, {});
    page.deliver({ jsonrpc: "2.0", id: message!.id, result: {} });
    await expect(sent).resolves.toBeUndefined();

    const declined = page.t3.sendMessage("Again");
    const second = page.posted[1] as { id: string };
    page.deliver({ jsonrpc: "2.0", id: second.id, error: { message: "Declined by the reader." } });
    await expect(declined).rejects.toThrow("Declined by the reader.");
  });

  it("rejects empty text without asking the client", async () => {
    const page = framedPage();
    await expect(page.t3.sendMessage("  ")).rejects.toThrow("The message is empty.");
    expect(page.posted).toEqual([]);
  });
});

describe("readHtmlRenderImageRequest", () => {
  it("accepts http(s) and inline image URLs in an open-image notification", () => {
    const image = (params: unknown) => ({
      jsonrpc: "2.0",
      method: "t3/notifications/open-image",
      params,
    });
    expect(
      readHtmlRenderImageRequest(image({ src: "data:image/png;base64,AA", name: " Chart " })),
    ).toEqual({
      src: "data:image/png;base64,AA",
      name: "Chart",
    });
    expect(readHtmlRenderImageRequest(image({ src: "https://example.com/a.png" }))).toEqual({
      src: "https://example.com/a.png",
      name: "Image",
    });
    expect(readHtmlRenderImageRequest(image({ src: "javascript:alert(1)" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "data:text/html,<p>" }))).toBeUndefined();
    expect(readHtmlRenderImageRequest(image({ src: "blob:null/1" }))).toBeUndefined();
  });
});

describe("htmlRenderFromToolItem", () => {
  const result = { htmlRender: reference, message: "Rendered above your reply." };

  it("reads the reference from each provider's result envelope", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__html_render", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.html_render", { structuredContent: result, content: [] }],
      ["t3-code-thread_1_html_render", JSON.stringify(result)],
      ["html_render", result],
    ] as const) {
      expect(htmlRenderFromToolItem({ toolName, output })).toEqual(reference);
    }
  });
});
