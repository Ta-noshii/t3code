import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as CanvasService from "../canvas/CanvasService.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("thread-canvas-test");
const invocation = {
  environmentId: EnvironmentId.make("environment-canvas-test"),
  requestNamespace: "provider-session-canvas-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-canvas-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const summary = {
  path: "/repo/.canvases/arch.excalidraw",
  projectId: null,
  slug: "arch",
  title: "Arch",
  displayPath: ".canvases/arch.excalidraw",
  format: "excalidraw" as const,
  readOnly: false,
  modifiedAt: "2026-10-13T00:00:00.000Z",
  elementCount: 2,
  imageCount: 0,
};

const layerCanvasMock = Layer.mock(CanvasService.CanvasService)({
  agentScreenshot: (context, input) =>
    context.threadId === threadId && input.canvas === undefined
      ? Effect.fail(new CanvasService.CanvasNoCurrentError())
      : Effect.succeed({
          png: Buffer.from("png").toString("base64"),
          width: 320,
          height: 200,
          rect: { x: 0, y: 0, width: 160, height: 100 },
          canvas: summary,
        }),
  agentAddImage: () => Effect.die("must not run with two sources"),
});

const layerTest = McpHttpServer.layerCanvasToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(layerCanvasMock),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-canvas-toolkit-test-" })),
  Layer.provide(NodeServices.layer),
);

const call = (name: string, args: Record<string, unknown>) =>
  Effect.flatMap(McpServer.McpServer, (server) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      ),
  );

const text = (result: McpSchema.CallToolResult) =>
  result.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");

it.effect("registers the canvas tools and returns screenshots as images", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
      "canvas_add_image",
      "canvas_create",
      "canvas_list",
      "canvas_open",
      "canvas_read",
      "canvas_screenshot",
      "canvas_update",
    ]);

    const shot = yield* call("canvas_screenshot", {
      canvas: "arch",
      crop: { type: "frame", frame: "Login" },
    });
    expect(shot.isError).toBe(false);
    expect(shot.content.map((entry) => entry.type)).toEqual(["text", "image"]);
    expect(shot.structuredContent).toMatchObject({
      canvas: { slug: "arch" },
      screenshot: { mimeType: "image/png", width: 320, height: 200 },
    });

    const none = yield* call("canvas_screenshot", {});
    expect(none.isError).toBe(true);
    expect(text(none)).toContain("No canvas is open in this thread");

    const twoSources = yield* call("canvas_add_image", { path: "a.png", url: "https://x/a.png" });
    expect(twoSources.isError).toBe(true);
    expect(text(twoSources)).toContain("exactly one of path, url, or attachmentId");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
