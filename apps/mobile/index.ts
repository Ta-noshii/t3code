// First of all: GT copies Intl.Locale and Intl.DisplayNames when its modules load, and observe.ts
// reaches GT through the persistence graph. Hermes lacks both, so a GT module loaded before the
// polyfills rejects every locale and the app never registers.
import "./src/i18n/intl-polyfills";
// Next: the render counter and behavior probe wrap the DevTools hook before any React commit.
import "./src/features/development/render-counter-entry";
import "./src/features/development/behavior-probe-entry";
// Next, so errors thrown while the rest of the app loads are recorded too.
import "./src/features/observability/observe";
import { registerRootComponent } from "expo";
import "react-native-gesture-handler";
import { LogBox } from "react-native";
import { featureFlags } from "react-native-screens";

import App from "./src/App";

// Enables iOS FormSheet sizing for nested native stacks in non-fitToContents sheets.
featureFlags.experiment.synchronousScreenUpdatesEnabled = true;

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  LogBox.ignoreAllLogs();
}

registerRootComponent(App);
