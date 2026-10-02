const { test } = require("node:test");
const assert = require("node:assert/strict");
const plugin = require("./withNowBarFork.cjs");

test("release packaging preserves upstream account configuration and identifies the real base", () => {
  process.env.NOWBAR_VERSION_CODE = "6";
  process.env.NOWBAR_REQUIRE_CLOUD_CONFIG = "1";
  const clerk = { publishableKey: "pk_live_public", jwtTemplate: "t3-relay" };
  const relay = { url: "https://relay.t3.codes" };
  const result = plugin({ version: "1.1.1", android: {}, extra: { clerk, relay, eas: {} } });
  assert.equal(result.version, "1.1.1-nowbar.6");
  assert.equal(result.android.versionCode, 6);
  assert.deepEqual(result.extra.clerk, clerk);
  assert.deepEqual(result.extra.relay, relay);
  assert.equal(result.extra.nowbar.remotePushConfigured, false);
  assert.equal(result.updates.enabled, false);
  assert.equal(result.extra.eas, undefined);
});

test("release cannot silently lose any setting required to show T3 Connect", () => {
  process.env.NOWBAR_REQUIRE_CLOUD_CONFIG = "1";
  for (const missing of ["publishableKey", "jwtTemplate", "url"]) {
    for (const value of [undefined, null, {}, " "]) {
      const extra = {
        clerk: { publishableKey: "pk_live_public", jwtTemplate: "t3-relay" },
        relay: { url: "https://relay.t3.codes" },
      };
      (missing === "url" ? extra.relay : extra.clerk)[missing] = value;
      assert.throws(
        () => plugin({ version: "1.1.1", extra }),
        /T3 Connect configuration is missing/,
      );
    }
  }
});

test("host Firebase tokens stay separate from official relay registration", () => {
  process.env.NOWBAR_REQUIRE_CLOUD_CONFIG = "0";
  for (const transport of ["host", "relay"]) {
    process.env.NOWBAR_PUSH_TRANSPORT = transport;
    const result = plugin({
      version: "1.1.1",
      android: { googleServicesFile: "/private/client.json" },
    });
    assert.equal(result.extra.nowbar.firebaseConfigured, true);
    assert.equal(result.extra.nowbar.remotePushConfigured, transport === "relay");
    assert.equal(result.extra.nowbar.pushTransport, transport);
  }
  delete process.env.NOWBAR_PUSH_TRANSPORT;
});

test("OAuth redirects use the upstream package Clerk allowlists and return to the fork", async () => {
  process.env.NOWBAR_REQUIRE_CLOUD_CONFIG = "0";
  const result = plugin({ version: "1.1.1", android: { package: "com.t3tools.t3code" } });
  assert.equal(result.android.package, "com.tanoshii.t3code.nowbar");
  const mod = result.mods.android.manifest;
  const manifest = { manifest: { application: [{ $: {} }] } };
  const out = await mod({ ...result, modResults: manifest, modRequest: { nextMod: (c) => c } });
  const application = out.modResults.manifest.application[0];
  assert.deepEqual(application["meta-data"], [
    {
      $: {
        "android:name": "com.clerk.expo.REDIRECT_APPLICATION_ID",
        "android:value": "com.t3tools.t3code",
      },
    },
  ]);
  const receiver = application.activity[0];
  assert.equal(receiver.$["android:name"], "com.clerk.api.sso.SSOReceiverActivity");
  assert.deepEqual(receiver["intent-filter"][0].data, [
    { $: { "android:scheme": "clerk", "android:host": "com.t3tools.t3code.callback" } },
  ]);
});
