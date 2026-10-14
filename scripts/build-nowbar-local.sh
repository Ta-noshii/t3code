#!/usr/bin/env bash
# Usage: NOWBAR_VERSION_CODE=11 scripts/build-nowbar-local.sh
# Requires Node 24, Java 17 (JAVA_HOME), Java 21 (JAVA21_HOME), Android SDK and pnpm.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${NOWBAR_VERSION_CODE:?Choose the next unused release code before building}"
: "${JAVA_HOME:?Set JAVA_HOME to Java 17}"
: "${JAVA21_HOME:?Set JAVA21_HOME to Java 21 for Robolectric}"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export APP_VARIANT=production CI=1
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
export T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk
export T3CODE_CLERK_JWT_TEMPLATE=t3-relay
export T3CODE_RELAY_URL=https://relay.t3.codes
export NOWBAR_REQUIRE_CLOUD_CONFIG=1 NOWBAR_PUSH_TRANSPORT=host
signing_dir="${NOWBAR_SIGNING_DIR:-$HOME/.codex/signing/t3code-nowbar-from-laptop}"
export T3CODE_ANDROID_GOOGLE_SERVICES_FILE="${T3CODE_ANDROID_GOOGLE_SERVICES_FILE:-$signing_dir/push/google-services.json}"
test -r "$signing_dir/nowbar.p12"
test -r "$signing_dir/password.txt"
test -r "$T3CODE_ANDROID_GOOGLE_SERVICES_FILE"
node --input-type=module -e 'const major = Number(process.versions.node.split(".")[0]); if (major !== 24) throw new Error("Use the repository Node 24 toolchain"); const code = Number(process.env.NOWBAR_VERSION_CODE); if (!Number.isSafeInteger(code) || code < 1 || code > 2100000000) throw new Error("Invalid Android version code");'
if [[ ! -x node_modules/.bin/vp || ! -d apps/mobile/node_modules/expo ]]; then
  pnpm install --filter @t3tools/mobile... --frozen-lockfile
fi
node --test apps/mobile/plugins/withNowBarFork.test.cjs
node_modules/.bin/vp test run apps/mobile/src/features/nowbar/model.test.ts apps/mobile/src/features/nowbar/update-manifest.test.ts apps/mobile/src/features/nowbar/debug.test.ts apps/mobile/src/lib/appLinking.test.ts
(cd apps/mobile && node_modules/.bin/tsc --noEmit)

# Regenerate only when native configuration changes; Kotlin/resources are linked directly.
config_stamp=$( { printf '%s\n' "$NOWBAR_VERSION_CODE" "$APP_VARIANT" "$T3CODE_CLERK_PUBLISHABLE_KEY" "$T3CODE_CLERK_JWT_TEMPLATE" "$T3CODE_RELAY_URL" "$NOWBAR_PUSH_TRANSPORT" "$T3CODE_ANDROID_GOOGLE_SERVICES_FILE"; sha256sum apps/mobile/app.config.* apps/mobile/package.json pnpm-lock.yaml "$T3CODE_ANDROID_GOOGLE_SERVICES_FILE"; find apps/mobile/plugins -type f -print0 | sort -z | xargs -0 sha256sum; } | sha256sum | cut -d ' ' -f1)
if [[ ! -f apps/mobile/android/gradlew || ! -f apps/mobile/android/.nowbar-config-stamp || "$(cat apps/mobile/android/.nowbar-config-stamp)" != "$config_stamp" ]]; then
  (cd apps/mobile && node node_modules/expo/bin/cli prebuild --platform android --no-install)
  printf '%s\n' "$config_stamp" > apps/mobile/android/.nowbar-config-stamp
fi
config_file=$(mktemp)
trap 'rm -f "$config_file"' EXIT
(cd apps/mobile && node node_modules/expo/bin/cli config --type public --json) > "$config_file"
NOWBAR_VERSION=$(node --input-type=module -e 'import {readFileSync} from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).version)' "$config_file")
export NOWBAR_VERSION
(cd apps/mobile/android && bash gradlew :t3-nowbar:testDebugUnitTest :t3-agent-notifications:testDebugUnitTest :app:assembleRelease \
  -I ../../../scripts/nowbar-local.gradle -PreactNativeArchitectures=arm64-v8a "-Porg.gradle.java.installations.paths=$JAVA_HOME,$JAVA21_HOME" \
  --build-cache --max-workers="${NOWBAR_BUILD_WORKERS:-4}")
mkdir -p release
build_tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
"$build_tools/apksigner" sign --ks "$signing_dir/nowbar.p12" --ks-type PKCS12 --ks-key-alias nowbar \
  --ks-pass "file:$signing_dir/password.txt" \
  --out release/t3code-nowbar.apk apps/mobile/android/app/build/outputs/apk/release/app-release.apk
"$build_tools/apksigner" verify --verbose --print-certs release/t3code-nowbar.apk
"$build_tools/zipalign" -c -P 16 4 release/t3code-nowbar.apk
node scripts/nowbar-release-manifest.mjs
printf 'Signed %s: %s/release/t3code-nowbar.apk\n' "$NOWBAR_VERSION" "$PWD"
