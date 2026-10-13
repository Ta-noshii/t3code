import * as NodeModule from "node:module";
import type {
  getPathFromState as GetPathFromState,
  getStateFromPath as GetStateFromPath,
} from "@react-navigation/native";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { CANVAS_LIBRARY_LINKING, CANVAS_LINKING, canvasRouteParams } from "./canvasRoutes";

// Core holds the linking helpers without the react-native runtime that native pulls in.
function loadLinking() {
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = require.resolve("@react-navigation/native/package.json");
  const requireFromNative = NodeModule.createRequire(nativePackage);
  return requireFromNative("@react-navigation/core") as {
    readonly getPathFromState: typeof GetPathFromState;
    readonly getStateFromPath: typeof GetStateFromPath;
  };
}

const { getPathFromState, getStateFromPath } = loadLinking();
const config = { screens: { CanvasLibrary: CANVAS_LIBRARY_LINKING, Canvas: CANVAS_LINKING } };
const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

function roundTrip(name: string, params: object) {
  const path = getPathFromState({ routes: [{ name, params }] }, config);
  const route = getStateFromPath(path, config)?.routes[0];
  return { path, name: route?.name, params: route?.params };
}

describe("canvas routes", () => {
  it("links a project's canvas library", () => {
    const result = roundTrip("CanvasLibrary", { environmentId, projectId });
    expect(result.path).toBe("/canvases/env-1/project-1");
    expect(result.params).toEqual({ environmentId, projectId });
  });

  it("keeps an absolute canvas path with spaces intact", () => {
    const params = canvasRouteParams(environmentId, {
      path: "/home/me/My Project/.canvases/auth flow.excalidraw",
      projectId,
    });
    const result = roundTrip("Canvas", params);
    expect(result.name).toBe("Canvas");
    expect(result.params).toEqual(params);
  });

  it("leaves the project out for a canvas outside any project", () => {
    expect(
      canvasRouteParams(environmentId, { path: "/tmp/a.excalidraw", projectId: null }),
    ).toEqual({ environmentId, path: "/tmp/a.excalidraw" });
  });
});
