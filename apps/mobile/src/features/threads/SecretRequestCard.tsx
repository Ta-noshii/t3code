import {
  secretRequestAnswerInput,
  secretRequestCopy,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../../components/ui/Button";

/**
 * Feed card for a secret an agent asked the user for, or a command in its
 * shell asked for through `t3 secret prompt`. The typed value lives only in
 * this component's state and the RPC payload: it is never logged, alerted, or
 * persisted, and the field clears once the answer is sent.
 */
const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const PRIVATE_SYMBOL: AppSymbolName = { ios: "checkmark.shield", android: "lock" };

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = props.projectedItem;
  if (item.type !== "secret_request") return null;
  const display = secretRequestDisplay(item, visibility);
  if (display.kind === "pending") {
    return (
      <PendingSecretRequestForm
        environmentId={props.environmentId}
        item={item}
        iconColor={props.iconColor}
      />
    );
  }
  const icon: AppSymbolName =
    display.kind === "pending-elsewhere"
      ? LOCK_SYMBOL
      : display.outcome === "saved"
        ? "checkmark"
        : "minus";
  return (
    <View className="mb-3 min-h-9 flex-row items-center gap-2 px-1">
      <SymbolView name={icon} size={13} tintColor={props.iconColor} type="monochrome" />
      <Text className="flex-1 font-sans text-sm text-foreground-muted" numberOfLines={2}>
        {item.label} · {display.label}
      </Text>
    </View>
  );
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly iconColor: ColorValue;
}) {
  const { item } = props;
  const copy = secretRequestCopy(item);
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (
    reply: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setSecret("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
        {copy.command !== null ? (
          <>
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              Enter your password to run as root:
            </Text>
            <Text
              selectable
              className="rounded-lg bg-subtle px-2 py-1.5 font-mono text-sm text-foreground"
            >
              {copy.command}
            </Text>
          </>
        ) : item.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">{item.reason}</Text>
        ) : null}
      </View>
      {copy.multiline ? (
        <MultilineSecretPaste
          secret={secret}
          disabled={submitting}
          onChange={setSecret}
          onError={setError}
        />
      ) : (
        <TextInput
          accessibilityLabel={item.label}
          placeholder={copy.placeholder}
          value={secret}
          onChangeText={setSecret}
          editable={!submitting}
          secureTextEntry
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          spellCheck={false}
          returnKeyType="done"
          onSubmitEditing={() => void send({ type: "save", secret })}
        />
      )}
      {error !== null ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </Text>
      ) : null}
      <Button
        label={copy.saveLabel}
        tone="primary"
        fullWidth
        disabled={submitting || secret.trim().length === 0}
        onPress={() => void send({ type: "save", secret })}
      />
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-1 flex-row items-center gap-1.5">
          <SymbolView
            name={PRIVATE_SYMBOL}
            size={13}
            tintColor={props.iconColor}
            type="monochrome"
          />
          <Text className="flex-1 font-sans text-xs text-foreground-muted">{copy.privacyNote}</Text>
        </View>
        <Button
          label={copy.declineLabel}
          tone="text"
          disabled={submitting}
          onPress={() => void send({ type: "decline" })}
        />
      </View>
    </View>
  );
}

/**
 * A key or certificate for a waiting command. Native secure fields are single
 * line and drop line breaks, so the value comes from the clipboard and the
 * card shows only its size.
 */
function MultilineSecretPaste(props: {
  readonly secret: string;
  readonly disabled: boolean;
  readonly onChange: (secret: string) => void;
  readonly onError: (error: string | null) => void;
}) {
  const paste = async () => {
    const text = await Clipboard.getStringAsync().catch(() => "");
    if (text.trim().length === 0) {
      props.onError("The clipboard is empty. Copy the value first.");
      return;
    }
    props.onError(null);
    props.onChange(text);
  };
  const lines = props.secret.split("\n").length;
  return (
    <View className="flex-row items-center gap-2">
      <Text className="flex-1 font-sans text-sm text-foreground-muted">
        {props.secret.length === 0
          ? "Copy the value, then paste it here."
          : `Pasted ${props.secret.length} characters on ${lines} ${lines === 1 ? "line" : "lines"}`}
      </Text>
      {props.secret.length > 0 ? (
        <Button
          label="Clear"
          tone="secondary"
          disabled={props.disabled}
          onPress={() => props.onChange("")}
        />
      ) : null}
      <Button
        label="Paste"
        tone="secondary"
        disabled={props.disabled}
        onPress={() => void paste()}
      />
    </View>
  );
}
