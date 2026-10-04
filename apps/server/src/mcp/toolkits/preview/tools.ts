import {
  OrchestratorMcpFailure,
  ToolActivityIcon,
  PreviewAutomationActInput,
  PreviewAutomationDialogInput,
  PreviewAutomationError,
  PreviewAutomationEvaluateInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationRecordingArtifact,
  PreviewAutomationRecordingStatus,
  PreviewAutomationResizeInput,
  PreviewAutomationResizeResult,
  PreviewAutomationSelectResult,
  PreviewAutomationSetColorSchemeInput,
  PreviewAutomationSetColorSchemeResult,
  PreviewAutomationSnapshot,
  PreviewAutomationStatus,
  PreviewAutomationTabTargetInput,
  PreviewAutomationWaitForInput,
  PreviewViewportSize,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const PreviewToolFailure = Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]);

const presentationFields = { toolIcon: Schema.optional(ToolActivityIcon) };

const PreviewActionResult = Schema.Struct(presentationFields);

const browserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, true) as T;

const safeBrowserTool = <T extends Tool.Any>(tool: T): T =>
  tool.annotate(Tool.OpenWorld, true).annotate(Tool.Destructive, false) as T;

const readonlyBrowserTool = <T extends Tool.Any>(tool: T): T =>
  safeBrowserTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const PreviewStatusTool = Tool.make("preview_status", {
  description:
    "Report preview tab state: owner, pending dialog, URL, title, loading, viewport, and size. `tabs` lists this thread's tabs. `profiles` lists logins for `preview_open`. Read any listed tab. Act only on your tab, or an unclaimed tab with no human in control.",
  parameters: PreviewAutomationTabTargetInput,
  success: PreviewAutomationStatus,
  failure: PreviewToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Get preview status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const PreviewOpenTool = browserTool(
  Tool.make("preview_open", {
    description:
      "Open a preview tab in this thread and show it. `open=false` keeps it in the background. Reuses your current tab unless `tabId` or `reuseExistingTab=false` says otherwise. Parallel subagents in one session must each use `reuseExistingTab=false`, then their own returned `tabId`.",
    parameters: PreviewAutomationOpenInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Open browser preview")
    .annotate(Tool.Destructive, false),
);

const PreviewDialogTool = browserTool(
  Tool.make("preview_dialog", {
    description:
      "Accept or dismiss the dialog `preview_status` reports. Pass `promptText` to accept a prompt. Needs your own tab, or an unclaimed one. Desktop hosts may not support this.",
    parameters: PreviewAutomationDialogInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Resolve browser dialog"),
);

const PreviewNavigateTool = safeBrowserTool(
  Tool.make("preview_navigate", {
    description:
      "Navigate the chosen tab. Pass `url` for a website, or `target:{kind:'environment-port',port}` for a dev server. Exactly one of `url` and `target`.",
    parameters: PreviewAutomationNavigateInput,
    success: PreviewAutomationStatus,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Navigate browser preview"),
);

const PreviewResizeTool = safeBrowserTool(
  Tool.make("preview_resize", {
    description:
      "Resize the chosen tab: {mode:'fill'}, {mode:'freeform',width,height}, or {mode:'preset',preset,orientation}. Changes CSS size only, not the user agent.",
    parameters: PreviewAutomationResizeInput,
    success: Schema.Struct({ ...PreviewAutomationResizeResult.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Resize browser viewport")
    .annotate(Tool.Idempotent, true),
);

const PreviewSetAppearanceTool = safeBrowserTool(
  Tool.make("preview_set_appearance", {
    description:
      "Set `prefers-color-scheme` for the chosen tab: 'dark', 'light', or 'system' to clear the override.",
    parameters: PreviewAutomationSetColorSchemeInput,
    success: Schema.Struct({
      ...PreviewAutomationSetColorSchemeResult.fields,
      ...presentationFields,
    }),
    failure: PreviewToolFailure,
    dependencies,
  })
    .annotate(Tool.Title, "Set preview appearance")
    .annotate(Tool.Idempotent, true),
);

// Not read-only: save=true writes the screenshot to disk.
export const PreviewSnapshotTool = safeBrowserTool(
  Tool.make("preview_snapshot", {
    description:
      "Use it only when the current request asks for browser work, including checking an edit in the browser. Never use it unasked to verify your own edit, or to repeat a snapshot from an earlier turn. Works on a tab the user is driving. Returns page state, elements, diagnostics, and screenshot size. Target one element with `locator='aria-ref=<ref>'` from `accessibilityTree`, even in frames. Refs die on navigation, a new snapshot, or handoff. Text caps near 20 KB; on your own or an unclaimed tab, `preview_evaluate` reads more. To show a screenshot when asked: `save=true`, then embed ![alt](screenshotPath).",
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      includeImage: Schema.optional(
        Schema.Boolean.annotate({
          description: "Default false. True only to see the page.",
        }),
      ),
      save: Schema.optional(
        Schema.Boolean.annotate({
          description: "Write PNG, return `screenshotPath`.",
        }),
      ),
    }),
    success: PreviewAutomationSnapshot,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Inspect browser page"),
);

const PreviewActTool = browserTool(
  Tool.make("preview_act", {
    description:
      "Act on the chosen tab. Target with `locator='aria-ref=<ref>'` from `preview_snapshot`; `x` and `y` go together. `timeoutMs` defaults to 15000. click: `button`, `clickCount` 1 to 3. type: literal `text`, `clear=true` replaces it. hover: shows menus or tooltips. select: `values` in one native <select>, by value or label; for a custom dropdown, click it open, then click the option. drag: `source` onto `target`. upload: absolute `paths` answer the file picker `preview_status` reports, [] cancels it, or a `locator` sets an <input type=file>. press: one `key`, such as 'Enter', with `modifiers`, to the focused element; click a field first to focus it. scroll: the tab, or one container with a locator; positive `deltaY` scrolls down, positive `deltaX` right.",
    parameters: PreviewAutomationActInput,
    success: Schema.Union([
      Schema.Struct({ ...PreviewAutomationSelectResult.fields, ...presentationFields }),
      PreviewActionResult,
    ]),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Act in preview page"),
);

/** Wrap non-objects: MCP requires object structuredContent, and Claude Code rejects invalid results entirely. */
export const PreviewEvaluateResult = Schema.Struct({
  ...presentationFields,
  value: Schema.Unknown.annotate({
    description: "The JSON-serializable value the expression produced, or null.",
  }),
});

const PreviewEvaluateTool = browserTool(
  Tool.make("preview_evaluate", {
    description:
      "Run JavaScript in the page. It can change page state. Returns `{value}`, up to 64 KB. Needs your tab, or an unclaimed one. To read a tab the user drives, use `preview_snapshot`. Page tools reached here: read data only, never create, save, or display. Show results with `html_render`.",
    parameters: PreviewAutomationEvaluateInput,
    success: PreviewEvaluateResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Evaluate JavaScript in preview"),
);

export const OVERFLOW_CHECK_DEFAULT_WIDTHS = [375, 768, 1440] as const;

export const PreviewOverflowCheckResult = Schema.Struct({
  ...presentationFields,
  report: Schema.String.annotate({
    description:
      "The text report, one block per width (grouped by page when urls is given), ending with a one-line verdict.",
  }),
  overflows: Schema.Int.annotate({
    description:
      "Findings that count as bugs across all pages and widths (spill, clip, page, ringclip).",
  }),
}).annotate({ description: "The overflow report for the page." });

const PreviewOverflowCheckTool = safeBrowserTool(
  Tool.make("preview_overflow_check", {
    description: `Scan the current page for layout overflow at several viewport widths and return a short text report. Run it after any change to layout, text, or component sizing, before taking screenshots: it finds what a screenshot hides (a few px of spill, a ring cut by a scroll container, a page that scrolls sideways on phones).

What it reports, per width:
  spill     a normal-flow child sticks out of a parent that does not clip (visible overflow)
  clip      content is cut off by an overflow:hidden box with no ellipsis
  page      the document scrolls horizontally (the classic phone bug)
  ringclip  a hard ring-* / outline drawn outside the box is cut by a clipping or scrolling ancestor (selected rows, card borders in lists)
  truncate  info only: ellipsis or line-clamp is cutting text; decide whether that is intended
  scroll    info only: a horizontal scroller that is scrolling; fine for tables on phones, a bug for a tab strip or rail that outgrew its slot
Each line gives the selector, the parent, how many px, the direction, and "← cause": the deepest box that will not fit (a long word, a fixed width, an image). Fix the cause, not the wrapper. A clean width prints "<w>px: clean".

What it skips on purpose: hidden / aria-hidden / sr-only elements, off-canvas drawers, absolutely positioned layers (glows, badges), negative-margin bleeds, translated elements (hover lifts), still-running animations, and anything under [data-overflow-ok]. Finished animations are settled first, so entrances do not show up. Scaled elements are checked at rest, so a hover zoom that escapes its strip is caught if the page is in that state when you run it.

Reading the result: "clean" at every width means no geometric overflow; it does not judge cramped or ugly. Info lines do not fail the check. If it flags something intentional, add data-overflow-ok to that element rather than ignoring the report. Vertical page height, sibling overlap, blend/corner-radius artifacts and SVG text are outside what it detects; check those by eye.

Several pages at once: pass urls=[...] and the tool navigates the tab to each one in turn, waits settle ms, and scans it, all in this one call. Use it whenever a change touches more than one page instead of calling the tool once per page. Clean pages print one line ("<url>: clean"), the others print their report indented under the URL, and the last line counts the pages that need work. A page that answers HTTP 400+ or fails to navigate is reported as "did not load" and counts as a failure, never as clean. The tab is left on the last URL. States that need clicks first (an open modal, a filled form) are not reachable this way: set the state up, then call the tool without urls.

The tab is resized through each width and left at the last one (pass restore=true to put the viewport setting back). Without urls, wait for the page to finish loading first (preview_wait_for) or dynamic content will not be measured. Pass tabId to check a specific tab; omit it to use this agent session's current tab.`,
    parameters: Schema.Struct({
      ...PreviewAutomationTabTargetInput.fields,
      urls: Schema.optional(
        Schema.Array(Schema.String).annotate({
          description:
            "Pages to scan in this one call, as absolute URLs. Each is opened in the tab, settled, and scanned at every width. Omit to scan the page that is already open.",
        }),
      ),
      settle: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
          description:
            "With urls: milliseconds to wait after each navigation before scanning, for data fetches and client rendering. Default 1500.",
        }),
      ),
      widths: Schema.optional(
        Schema.Array(PreviewViewportSize.fields.width).annotate({
          description: `Viewport widths to test, in CSS pixels. Default ${JSON.stringify(OVERFLOW_CHECK_DEFAULT_WIDTHS)}. Use [375] for a quick phone check, or the current width after setting up a hover or open state.`,
        }),
      ),
      height: Schema.optional(
        PreviewViewportSize.fields.height.annotate({
          description: "Viewport height while testing, in CSS pixels. Default 900.",
        }),
      ),
      max: Schema.optional(
        Schema.Int.check(Schema.isGreaterThan(0)).annotate({
          description: "Maximum findings listed per width. Default 10.",
        }),
      ),
      restore: Schema.optional(
        Schema.Boolean.annotate({
          description:
            "Put the viewport setting back to what it was before the check. Default false.",
        }),
      ),
    }),
    success: PreviewOverflowCheckResult,
    failure: PreviewAutomationError,
    dependencies,
  })
    .annotate(Tool.Title, "Check preview page for overflow")
    .annotate(Tool.Idempotent, true),
);

const PreviewWaitForTool = readonlyBrowserTool(
  Tool.make("preview_wait_for", {
    description:
      "Wait until all given locator, selector, text, and URL conditions match in the chosen tab.",
    parameters: PreviewAutomationWaitForInput,
    success: PreviewActionResult,
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Wait for preview page condition"),
);

const PreviewRecordingStartTool = safeBrowserTool(
  Tool.make("preview_recording_start", {
    description: "Start recording the chosen tab.",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingStatus.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies,
  }).annotate(Tool.Title, "Start browser recording"),
);

const PreviewRecordingStopTool = safeBrowserTool(
  Tool.make("preview_recording_stop", {
    description:
      "Stop recording the chosen tab. Returns a local path to the recording file (max 50 MiB).",
    parameters: PreviewAutomationTabTargetInput,
    success: Schema.Struct({ ...PreviewAutomationRecordingArtifact.fields, ...presentationFields }),
    failure: PreviewToolFailure,
    dependencies: [...dependencies, FileSystem.FileSystem, ServerConfig.ServerConfig],
  }).annotate(Tool.Title, "Stop browser recording"),
);

export const PreviewToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewSnapshotTool,
  PreviewActTool,
  PreviewEvaluateTool,
  PreviewOverflowCheckTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewStandardToolkit = Toolkit.make(
  PreviewDialogTool,
  PreviewStatusTool,
  PreviewOpenTool,
  PreviewNavigateTool,
  PreviewResizeTool,
  PreviewSetAppearanceTool,
  PreviewActTool,
  PreviewEvaluateTool,
  PreviewOverflowCheckTool,
  PreviewWaitForTool,
  PreviewRecordingStartTool,
  PreviewRecordingStopTool,
);

export const PreviewSnapshotToolkit = Toolkit.make(PreviewSnapshotTool);
