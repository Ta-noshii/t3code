import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useCallback, useState } from "react";

import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
} from "../../hooks/useSettings";
import {
  buildProviderInstanceUpdatePatch,
  resolveEditableProviderInstance,
} from "../settings/SettingsPanels.logic";
import { toastManager } from "../ui/toast";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

function readAutoCompactWindow(config: unknown): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as { readonly autoCompactWindow?: unknown }).autoCompactWindow;
  return typeof value === "string" ? value.trim() : "";
}

export interface ClaudeAutoCompactWindowControl {
  /** The saved value, or the one being saved. `""` means Claude's default. */
  readonly value: string;
  readonly setValue: (next: string) => void;
}

/**
 * Reads and writes `autoCompactWindow` on one Claude provider instance of an
 * environment, through the same instance upsert the Providers settings page
 * uses. Returns null when the instance is not a Claude instance or its config
 * is not in the environment's settings.
 */
export function useClaudeAutoCompactWindow(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId | null | undefined;
  readonly driverKind: ProviderDriverKind | null | undefined;
}): ClaudeAutoCompactWindowControl | null {
  const { environmentId, instanceId, driverKind } = input;
  const settings = useEnvironmentSettings(environmentId);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const isClaude = instanceId != null && driverKind === CLAUDE_DRIVER;
  const isDefault = isClaude && instanceId === defaultInstanceIdForDriver(CLAUDE_DRIVER);
  const instance = isClaude
    ? resolveEditableProviderInstance({
        settings,
        instanceId,
        driver: CLAUDE_DRIVER,
        isDefault,
      })
    : undefined;
  const savedValue = readAutoCompactWindow(instance?.config);
  // Holds the choice until the server's settings push changes the saved
  // value, so the select does not flick back in between. `from` is the saved
  // value it was chosen over; once that changes, the saved value wins.
  const [pending, setPending] = useState<{
    readonly key: string;
    readonly from: string;
    readonly value: string;
  } | null>(null);
  const pendingKey = `${environmentId}:${instanceId ?? ""}`;
  const pendingValue =
    pending !== null && pending.key === pendingKey && pending.from === savedValue
      ? pending.value
      : null;

  const setValue = useCallback(
    (next: string) => {
      if (!isClaude || instance === undefined || next === (pendingValue ?? savedValue)) return;
      const { autoCompactWindow: _previous, ...restConfig } =
        instance.config !== null && typeof instance.config === "object"
          ? (instance.config as Record<string, unknown>)
          : {};
      // Matches the settings form: an empty value omits the key.
      const nextInstance = {
        ...instance,
        config: next.length === 0 ? restConfig : { ...restConfig, autoCompactWindow: next },
      };
      const { providerInstances: _providerInstances, ...patch } = buildProviderInstanceUpdatePatch({
        settings,
        instanceId,
        instance: nextInstance,
        driver: CLAUDE_DRIVER,
        isDefault,
      });
      const chosen = { key: pendingKey, from: savedValue, value: next };
      setPending(chosen);
      void persistProviderInstance(
        { operation: "upsert", instanceId, instance: nextInstance },
        patch,
      ).then((result) => {
        if (result._tag !== "Failure") return;
        setPending((current) => (current === chosen ? null : current));
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not change auto-compact",
          description: error instanceof Error ? error.message : "The settings update failed.",
        });
      });
    },
    [
      instance,
      instanceId,
      isClaude,
      isDefault,
      pendingKey,
      pendingValue,
      persistProviderInstance,
      savedValue,
      settings,
    ],
  );

  if (!isClaude || instance === undefined) {
    return null;
  }
  return { value: pendingValue ?? savedValue, setValue };
}
