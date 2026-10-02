const { withAndroidManifest } = require("expo/config-plugins");

const CLERK_REDIRECT_META = "com.clerk.expo.REDIRECT_APPLICATION_ID";
const CLERK_SSO_RECEIVER = "com.clerk.api.sso.SSOReceiverActivity";

// Upstream's Clerk instance only allowlists clerk://<upstream package>.callback for OAuth.
// The patched @clerk/expo reads this meta-data to send that redirect, and the extra
// intent filter routes it back to this app instead of the official one.
function withUpstreamClerkRedirect(config, upstreamPackage) {
  return withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];
    if (application == null) {
      throw new Error("AndroidManifest.xml is missing the application element for Clerk OAuth.");
    }
    application["meta-data"] = [
      ...(application["meta-data"] ?? []).filter(
        (entry) => entry.$["android:name"] !== CLERK_REDIRECT_META,
      ),
      { $: { "android:name": CLERK_REDIRECT_META, "android:value": upstreamPackage } },
    ];
    application.activity = [
      ...(application.activity ?? []).filter(
        (entry) => entry.$["android:name"] !== CLERK_SSO_RECEIVER,
      ),
      {
        $: { "android:name": CLERK_SSO_RECEIVER, "android:exported": "true" },
        "intent-filter": [
          {
            action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
            category: [
              { $: { "android:name": "android.intent.category.DEFAULT" } },
              { $: { "android:name": "android.intent.category.BROWSABLE" } },
            ],
            data: [{ $: { "android:scheme": "clerk", "android:host": `${upstreamPackage}.callback` } }],
          },
        ],
      },
    ];
    return nextConfig;
  });
}

// Fork identity and release channel stay in one plugin to minimize upstream conflicts.
module.exports = function withNowBarFork(config) {
  const upstreamVersion = config.version;
  const buildNumber = Number(process.env.NOWBAR_VERSION_CODE || 1);
  if (typeof upstreamVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(upstreamVersion)) {
    throw new Error("Expected an upstream mobile version in major.minor.patch format");
  }
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new Error("NOWBAR_VERSION_CODE must be a positive integer");
  }
  if (process.env.NOWBAR_REQUIRE_CLOUD_CONFIG === "1") {
    const cloudValues = [
      config.extra?.clerk?.publishableKey,
      config.extra?.clerk?.jwtTemplate,
      config.extra?.relay?.url,
    ];
    if (cloudValues.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("Refusing to release a local-only app: T3 Connect configuration is missing");
    }
  }
  const upstreamPackage = config.android?.package;
  config.name = "T3 Code Now Bar";
  config.slug = "t3-code-nowbar";
  config.scheme = "t3code-nowbar";
  config.android = {
    ...config.android,
    package: "com.tanoshii.t3code.nowbar",
    versionCode: buildNumber,
  };
  config.version = `${upstreamVersion}-nowbar.${buildNumber}`;
  config.extra = {
    ...config.extra,
    nowbar: {
      upstreamVersion,
      buildNumber,
      firebaseConfigured: Boolean(config.android.googleServicesFile),
      pushTransport: process.env.NOWBAR_PUSH_TRANSPORT || "relay",
      remotePushConfigured:
        Boolean(config.android.googleServicesFile) && process.env.NOWBAR_PUSH_TRANSPORT !== "host",
    },
  };
  // An upstream OTA would replace this fork's JS with code unaware of our
  // native module. Fork upgrades are whole, consistently signed APKs instead.
  config.updates = { enabled: false };
  delete config.owner;
  if (config.extra) delete config.extra.eas;
  return upstreamPackage ? withUpstreamClerkRedirect(config, upstreamPackage) : config;
};
