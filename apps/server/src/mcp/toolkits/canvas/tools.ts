import {
  CanvasCrop,
  CanvasRect,
  CanvasScreenshotOptions,
  CanvasSummary,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as CanvasService from "../../../canvas/CanvasService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CanvasService.CanvasService,
];

const CanvasName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)).annotate({
  description:
    "A library slug from canvas_list, or a path to an .excalidraw file (absolute, ~/..., or relative to the project). Defaults to the canvas this thread used last.",
});

const Element = Schema.Record(Schema.String, Schema.Unknown);

const UpdateResult = Schema.Struct({
  canvas: CanvasSummary,
  revision: Schema.String,
  createdIds: Schema.Array(Schema.String),
  updatedIds: Schema.Array(Schema.String),
  deletedIds: Schema.Array(Schema.String),
});

const CanvasListTool = Tool.make("canvas_list", {
  description:
    "List the project's canvas library (Excalidraw diagrams in its canvas folder) and the canvas this thread is using.",
  success: Schema.Struct({
    folder: Schema.String,
    current: Schema.NullOr(Schema.String),
    canvases: Schema.Array(CanvasSummary),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "List canvases")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CanvasCreateTool = Tool.make("canvas_create", {
  description:
    "Create an empty canvas in the project's library, or at path, and make it this thread's canvas.",
  parameters: Schema.Struct({
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Where to create the file instead of the library, ending in .excalidraw.",
      }),
    ),
  }),
  success: Schema.Struct({ canvas: CanvasSummary }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Create canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CanvasOpenTool = Tool.make("canvas_open", {
  description:
    "Show a canvas to the user in the Canvas panel and make it this thread's canvas. Use it when the user should look at the diagram.",
  parameters: Schema.Struct({ canvas: CanvasName }),
  success: Schema.Struct({ canvas: CanvasSummary }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Open canvas")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CanvasReadTool = Tool.make("canvas_read", {
  description:
    "Read a canvas. By default a compact list of elements (id, type, box, text, frame, arrow ends); full=true returns Excalidraw element JSON (images omitted), refused for very large canvases unless narrowed with ids.",
  parameters: Schema.Struct({
    canvas: Schema.optional(CanvasName),
    full: Schema.optional(Schema.Boolean),
    ids: Schema.optional(
      Schema.Array(Schema.String).annotate({ description: "Only these elements." }),
    ),
  }),
  success: Schema.Struct({
    canvas: CanvasSummary,
    revision: Schema.String,
    elements: Schema.Array(Element),
    omittedImages: Schema.optional(Schema.Array(Schema.String)),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Read canvas")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const CanvasUpdateTool = Tool.make("canvas_update", {
  description:
    'Change a canvas: delete ids, then patch elements by id, then add new ones. add takes Excalidraw element skeletons, e.g. {"type":"rectangle","id":"api","x":0,"y":0,"width":160,"height":80,"label":{"text":"API"}}, {"type":"arrow","x":160,"y":40,"start":{"id":"api"},"end":{"id":"db"},"label":{"text":"SQL"}}, {"type":"text","x":0,"y":-40,"text":"Title","fontSize":28}, {"type":"frame","name":"Login","children":["api"]}. Give ids you will refer to; others are generated and returned. Patches set fields ({"id":"api","x":40,"backgroundColor":"#a5d8ff"}) and label for a shape\'s text; moved shapes carry their labels and arrow ends.',
  parameters: Schema.Struct({
    canvas: Schema.optional(CanvasName),
    add: Schema.optional(Schema.Array(Element)),
    update: Schema.optional(
      Schema.Array(Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [Element])),
    ),
    delete: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: UpdateResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Update canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const CanvasAddImageTool = Tool.make("canvas_add_image", {
  description:
    "Embed an image in a canvas from exactly one of path, url, or attachmentId (an image the user attached to this thread). Large images are shrunk. Give width or height to size it (aspect is kept), x/y to place it, and frame (name or id) to put it inside a frame.",
  parameters: Schema.Struct({
    canvas: Schema.optional(CanvasName),
    path: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    id: Schema.optional(Schema.String),
    x: Schema.optional(Schema.Number),
    y: Schema.optional(Schema.Number),
    width: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
    height: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
    frame: Schema.optional(Schema.String),
  }),
  success: UpdateResult,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Add image to canvas")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const CanvasScreenshotTool = Tool.make("canvas_screenshot", {
  description:
    "Render a canvas to a PNG. crop: {type:'full'}, {type:'elements',ids}, {type:'rect',rect}, or {type:'frame',frame} (name or id). Crop to what you changed to check it.",
  parameters: Schema.Struct({
    ...CanvasScreenshotOptions.fields,
    canvas: Schema.optional(CanvasName),
    crop: Schema.optional(CanvasCrop),
  }),
  success: Schema.Struct({
    canvas: CanvasSummary,
    rect: CanvasRect,
    screenshot: Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
    }),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Screenshot canvas")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CanvasStandardToolkit = Toolkit.make(
  CanvasListTool,
  CanvasCreateTool,
  CanvasOpenTool,
  CanvasReadTool,
  CanvasUpdateTool,
  CanvasAddImageTool,
);

export const CanvasScreenshotToolkit = Toolkit.make(CanvasScreenshotTool);

export const CanvasToolkit = Toolkit.make(
  CanvasListTool,
  CanvasCreateTool,
  CanvasOpenTool,
  CanvasReadTool,
  CanvasUpdateTool,
  CanvasAddImageTool,
  CanvasScreenshotTool,
);
