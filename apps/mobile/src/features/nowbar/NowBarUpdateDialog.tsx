import {
  AlertDialog,
  Column,
  Host,
  LinearProgressIndicator,
  Text,
  TextButton,
} from "@expo/ui/jetpack-compose";
import { fillMaxWidth } from "@expo/ui/jetpack-compose/modifiers";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import {
  closeNowBarUpdateDialog,
  installNowBarUpdate,
  type NowBarUpdateState,
  useNowBarUpdate,
} from "./updates";

const megabytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

export function nowBarUpdateProgressLabel(state: NowBarUpdateState): string | undefined {
  if (state.phase === "checking") return "Checking…";
  if (state.phase === "verifying") return "Verifying…";
  if (state.phase !== "downloading") return undefined;
  return state.total > 0
    ? `Downloading ${Math.floor((state.downloaded / state.total) * 100)}%`
    : "Downloading…";
}

function body(state: NowBarUpdateState): string {
  switch (state.phase) {
    case "available":
      return "A new signed APK is ready. It downloads here, then Android's installer opens.";
    case "permission":
      return "Android needs permission to install updates from T3 Code. Turn on “Allow from this source”, then come back. The download starts on its own.";
    case "downloading":
      return state.total > 0
        ? `${megabytes(state.downloaded)} of ${megabytes(state.total)}`
        : state.downloaded > 0
          ? megabytes(state.downloaded)
          : "Connecting to GitHub…";
    case "verifying":
      return "Checking the download's signature and version…";
    case "installer":
      return "Android's installer is open. Tap Update there to finish. If you closed it, open it again here.";
    case "error":
      return state.message;
    default:
      return "";
  }
}

export function NowBarUpdateDialog() {
  const { state, dialogOpen } = useNowBarUpdate();
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const titleTypography = useScaledTextRole("title");
  const bodyTypography = useScaledTextRole("footnote");
  if (!dialogOpen || state.phase === "idle" || state.phase === "checking") return null;
  const running = state.phase === "downloading" || state.phase === "verifying";
  const title =
    state.phase === "error"
      ? "Update failed"
      : state.phase === "installer"
        ? `Install ${state.release.version}`
        : `T3 Code Now Bar ${state.release.version}`;
  const confirm =
    state.phase === "available"
      ? "Download"
      : state.phase === "permission"
        ? "Open settings"
        : state.phase === "installer"
          ? "Open installer"
          : state.phase === "error"
            ? "Retry"
            : null;
  const progress =
    state.phase === "downloading" && state.total > 0 ? state.downloaded / state.total : null;
  const buttonColors = { contentColor: colors["--color-primary-text"] };
  return (
    <Host colorScheme={themeAppearance} style={{ height: 0, width: 0 }}>
      <AlertDialog
        onDismissRequest={closeNowBarUpdateDialog}
        properties={{ dismissOnClickOutside: !running }}
        tonalElevation={0}
        colors={{
          containerColor: colors["--color-card-alt"],
          titleContentColor: colors["--color-foreground"],
          textContentColor: colors["--color-foreground-secondary"],
        }}
      >
        <AlertDialog.Title>
          <Text style={titleTypography}>{title}</Text>
        </AlertDialog.Title>
        <AlertDialog.Text>
          <Column verticalArrangement={{ spacedBy: 12 }} modifiers={[fillMaxWidth()]}>
            {running && (
              <LinearProgressIndicator
                progress={progress}
                color={colors["--color-primary"]}
                trackColor={colors["--color-secondary"]}
                modifiers={[fillMaxWidth()]}
              />
            )}
            <Text style={bodyTypography}>{body(state)}</Text>
          </Column>
        </AlertDialog.Text>
        <AlertDialog.DismissButton>
          <TextButton onClick={closeNowBarUpdateDialog} colors={buttonColors}>
            <Text style={bodyTypography}>
              {running ? "Hide" : state.phase === "available" ? "Later" : "Close"}
            </Text>
          </TextButton>
        </AlertDialog.DismissButton>
        {confirm && (
          <AlertDialog.ConfirmButton>
            <TextButton
              onClick={() => {
                void installNowBarUpdate();
              }}
              colors={buttonColors}
            >
              <Text style={bodyTypography}>{confirm}</Text>
            </TextButton>
          </AlertDialog.ConfirmButton>
        )}
      </AlertDialog>
    </Host>
  );
}
