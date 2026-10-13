import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import { FetchHttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { discoverPairTarget, makePairServerConfig } from "../cli/pair.ts";
import * as ServerConfig from "../config.ts";

/** Long enough that the bar rarely re-pairs; a 401 reissues anyway. */
const BAR_TOKEN_TTL = Duration.days(90);

/**
 * Issues the bar's session token straight into the running server's database,
 * the way `t3 pair` mints its links. Loaded only when pairing, so the bridge's
 * normal start skips the auth and SQLite graph.
 */
export const issueBarToken = (baseDir: string): Promise<string> =>
  Effect.gen(function* () {
    const target = yield* discoverPairTarget(baseDir);
    const config = yield* makePairServerConfig({ target, logLevel: "Error" });
    const session = yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* environmentAuth.issueSession({
        scopes: ["orchestration:read", "orchestration:operate"],
        label: "omarchy-bar",
        ttl: BAR_TOKEN_TTL,
      });
    }).pipe(
      Effect.provide(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
    return session.token;
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, FetchHttpClient.layer)),
    Effect.runPromise,
  );
