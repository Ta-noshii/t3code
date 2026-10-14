import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CanvasScreenshotToolkit, CanvasStandardToolkit, type CanvasToolkit } from "./tools.ts";

const INVALID_REQUEST_ERRORS = new Set([
  "CanvasNotFoundError",
  "CanvasNoCurrentError",
  "CanvasInvalidPathError",
  "CanvasInvalidFileError",
  "CanvasImageError",
  "CanvasTooLargeError",
]);

// Canvas error messages are built on the server and say what to do next.
const toFailure = (error: { readonly _tag: string; readonly message: string }) =>
  new OrchestratorMcpFailure({
    code:
      INVALID_REQUEST_ERRORS.has(error._tag) ||
      (error._tag === "CanvasRenderError" && (error as { reason?: string }).reason === "invalid")
        ? "invalid_request"
        : "orchestration_error",
    message: error.message,
  });

/** The calling thread and its project; canvases belong to a thread's project. */
const callerContext = (operation: string) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const { thread } = yield* McpInvocationContext.requireThreadScope(scope, operation);
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const shell = yield* threads.getThreadShell(thread.threadId).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The thread could not be read.",
          }),
      ),
    );
    if (shell === null) {
      return yield* new OrchestratorMcpFailure({
        code: "thread_not_found",
        message: "The thread was not found.",
      });
    }
    return { threadId: thread.threadId, projectId: shell.projectId };
  });

const imageSource = (input: {
  readonly path?: string | undefined;
  readonly url?: string | undefined;
  readonly attachmentId?: string | undefined;
}): Effect.Effect<CanvasService.CanvasImageSource, OrchestratorMcpFailure> => {
  const sources = [
    input.path === undefined ? [] : [{ path: input.path }],
    input.url === undefined ? [] : [{ url: input.url }],
    input.attachmentId === undefined ? [] : [{ attachmentId: input.attachmentId }],
  ].flat();
  return sources.length === 1
    ? Effect.succeed(sources[0]!)
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Pass exactly one of path, url, or attachmentId.",
        }),
      );
};

// Reads and screenshots only look at files; the rest write them, so they
// need a caller allowed to change the workspace.
const handlers = {
  canvas_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const context = yield* callerContext("canvas_list");
      const canvases = yield* CanvasService.CanvasService;
      return yield* canvases.agentList(context).pipe(Effect.mapError(toFailure));
    }),
  ),
  canvas_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* callerContext("canvas_create");
      const canvases = yield* CanvasService.CanvasService;
      const canvas = yield* canvases.agentCreate(context, input).pipe(Effect.mapError(toFailure));
      return { canvas };
    }),
  ),
  canvas_move: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* callerContext("canvas_move");
      const canvases = yield* CanvasService.CanvasService;
      const canvas = yield* canvases.agentMove(context, input).pipe(Effect.mapError(toFailure));
      return { canvas };
    }),
  ),
  canvas_open: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* callerContext("canvas_open");
      const canvases = yield* CanvasService.CanvasService;
      const canvas = yield* canvases
        .agentOpen(context, input.canvas)
        .pipe(Effect.mapError(toFailure));
      return { canvas };
    }),
  ),
  canvas_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* callerContext("canvas_read");
      const canvases = yield* CanvasService.CanvasService;
      return yield* canvases.agentRead(context, input).pipe(Effect.mapError(toFailure));
    }),
  ),
  canvas_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* callerContext("canvas_update");
      const canvases = yield* CanvasService.CanvasService;
      return yield* canvases.agentUpdate(context, input).pipe(Effect.mapError(toFailure));
    }),
  ),
  canvas_add_image: McpToolAccess.actsAsCaller(({ path, url, attachmentId, ...input }) =>
    Effect.gen(function* () {
      const context = yield* callerContext("canvas_add_image");
      const canvases = yield* CanvasService.CanvasService;
      const source = yield* imageSource({ path, url, attachmentId });
      return yield* canvases
        .agentAddImage(context, { ...input, source })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  canvas_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const context = yield* callerContext("canvas_screenshot");
      const canvases = yield* CanvasService.CanvasService;
      const { png, width, height, rect, canvas } = yield* canvases
        .agentScreenshot(context, input)
        .pipe(Effect.mapError(toFailure));
      return {
        canvas,
        rect,
        screenshot: { mimeType: "image/png" as const, data: png, width, height },
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CanvasToolkit.tools>;

export const layerStandard = McpToolAccess.toLayer(CanvasStandardToolkit, {
  canvas_list: handlers.canvas_list,
  canvas_create: handlers.canvas_create,
  canvas_move: handlers.canvas_move,
  canvas_open: handlers.canvas_open,
  canvas_read: handlers.canvas_read,
  canvas_update: handlers.canvas_update,
  canvas_add_image: handlers.canvas_add_image,
});

export const layerScreenshot = McpToolAccess.toLayer(CanvasScreenshotToolkit, {
  canvas_screenshot: handlers.canvas_screenshot,
});
