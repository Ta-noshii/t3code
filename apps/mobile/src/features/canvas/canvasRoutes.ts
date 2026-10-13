import type { CanvasSummary, EnvironmentId, ProjectId } from "@t3tools/contracts";

export const CANVAS_LIBRARY_LINKING = "canvases/:environmentId/:projectId";
// The file path rides in the query string; it is absolute and has slashes.
export const CANVAS_LINKING = "canvas/:environmentId";

export type CanvasLibraryRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
};

export type CanvasRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly path: string;
  /** Lets a library canvas resolve a project-relative path; absent for loose files. */
  readonly projectId?: ProjectId;
};

export function canvasRouteParams(
  environmentId: EnvironmentId,
  canvas: Pick<CanvasSummary, "path" | "projectId">,
): CanvasRouteParams {
  return canvas.projectId === null
    ? { environmentId, path: canvas.path }
    : { environmentId, path: canvas.path, projectId: canvas.projectId };
}
