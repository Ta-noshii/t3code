import {
  secretRequestAnswerInput,
  secretRequestCopy,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestInputs,
  secretRequestLink,
  secretRequestReference,
  secretRequestSources,
  secretRequestValue,
  type SecretRequestItem,
  type SecretRequestReply,
  type SecretRequestSource,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type SecretProviderId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Clipboard from "expo-clipboard";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { View, type ColorValue } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SecretTextInput } from "../../components/ui/SecretTextInput";
import type { SecretTextInputHandle } from "../../components/ui/SecretTextInput.types";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";

/**
 * Feed card for a secret an agent asked the user for, or a command in its
 * shell asked for through `t3 secret prompt`. The typed value lives only in
 * this component's state and the RPC payload: it is never logged, alerted, or
 * persisted, and the field clears once the answer is sent.
 */
const LOCK_SYMBOL: AppSymbolName = { ios: "lock", android: "lock" };
const PRIVATE_SYMBOL: AppSymbolName = { ios: "checkmark.shield", android: "lock" };
const NO_SOURCES: ReadonlyArray<SecretRequestSource> = [];

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly iconColor: ColorValue;
}) {
  const m = useMessages();
  const { item, visibility } = props.projectedItem;
  if (item.type !== "secret_request") return null;
  const display = secretRequestDisplay(item, visibility, m);
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
  const gt = useGT();
  const m = useMessages();
  const { item } = props;
  const copy = secretRequestCopy(item, m);
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const inputs = secretRequestInputs(item, m);
  const multiple = item.fields !== undefined;
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  // The server accepts a reference answer only with this scope; without it the card is typed.
  const canUseReferences = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  // A reference answers one value, so a card with fields is always typed.
  const sources =
    multiple || !canUseReferences
      ? NO_SOURCES
      : secretRequestSources(config, config?.settings.secretProviders ?? {}, m);
  const [sourceId, setSourceId] = useState<SecretProviderId | null>(null);
  const source = sources.find((candidate) => candidate.id === sourceId) ?? null;
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [reference, setReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Submit then a tap can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const inputRefs = useRef<Array<SecretTextInputHandle | null>>([]);

  const send = async (reply: SecretRequestReply) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    // iOS offers to save a masked field that leaves the screen with text in it as a login
    // password, so the card is emptied before it closes; a failed answer puts the values back.
    const typed = reply.type === "save" ? reply.values : values;
    setValues({});
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setReference("");
      return;
    }
    setValues(typed);
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result), m));
    }
  };
  const save = (typed: Readonly<Record<string, string>>) => {
    if (source === null) {
      void send({ type: "save", values: typed });
    } else if (secretRequestReference(source, reference) === undefined) {
      setError(source.invalidReferenceMessage);
    } else {
      void send({ type: "reference", source, reference });
    }
  };
  const canSave =
    source === null
      ? secretRequestAnswerInput(item, { type: "save", values }) !== null
      : reference.trim().length > 0;
  const link = secretRequestLink(item);

  return (
    <View className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="gap-1">
        <Text className="font-t3-bold text-base text-foreground">{item.label}</Text>
        {copy.command !== null ? (
          <>
            <Text className="font-sans text-sm leading-5 text-foreground-muted">
              {gt("Enter your password to run as root:")}
            </Text>
            <Text
              selectable
              className="rounded-lg bg-subtle px-2 py-1.5 font-mono text-sm text-foreground"
            >
              {copy.command}
            </Text>
          </>
        ) : item.reason.trim() ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted" selectable>
            {item.reason}
          </Text>
        ) : null}
      </View>
      {link !== null ? (
        <View className="gap-1.5">
          <Button
            label={gt("Open {host}", { host: link.host })}
            tone="secondary"
            fullWidth
            onPress={() => void tryOpenExternalUrl(link.href, "secret-request")}
          />
          {/* A link found in the reason is already shown there. */}
          {item.url !== undefined ? (
            <Text selectable className="font-mono text-xs text-foreground-muted">
              {item.url}
            </Text>
          ) : null}
        </View>
      ) : null}
      {sources.length > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          <Chip
            label={gt("Value", { $context: "noun, enter the secret value directly" })}
            size="small"
            selected={source === null}
            disabled={submitting}
            onPress={() => {
              setSourceId(null);
              setError(null);
            }}
          />
          {sources.map((candidate) => (
            <Chip
              key={candidate.id}
              label={candidate.label}
              size="small"
              selected={candidate.id === source?.id}
              disabled={submitting}
              onPress={() => {
                setSourceId(candidate.id);
                setError(null);
              }}
            />
          ))}
        </View>
      ) : null}
      {source !== null ? (
        <TextInput
          key={source.id}
          accessibilityLabel={gt("{label} reference in {source}", {
            label: item.label,
            source: source.label,
          })}
          placeholder={source.referencePlaceholder}
          value={reference}
          onChangeText={(next) => {
            setReference(next);
            setError(null);
          }}
          editable={!submitting}
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          spellCheck={false}
          returnKeyType="done"
          onSubmitEditing={() => save(values)}
        />
      ) : copy.multiline ? (
        <MultilineSecretPaste
          secret={secretRequestValue(values, "")}
          disabled={submitting}
          onChange={(value) => setValues({ "": value })}
          onError={setError}
        />
      ) : (
        inputs.map((input, index) => {
          const last = index === inputs.length - 1;
          const field = (
            <SecretTextInput
              key={input.key}
              // A single input is labelled by the card title.
              accessibilityLabel={multiple ? input.label : item.label}
              secret={input.secret}
              onMount={(handle) => {
                inputRefs.current[index] = handle;
              }}
              placeholder={item.shellPrompt === undefined ? input.placeholder : copy.placeholder}
              value={secretRequestValue(values, input.key)}
              onChangeText={(value) => setValues((current) => ({ ...current, [input.key]: value }))}
              editable={!submitting}
              returnKeyType={last ? "done" : "next"}
              onSubmitEditing={(value) =>
                last
                  ? save({ ...values, [input.key]: value })
                  : inputRefs.current[index + 1]?.focus()
              }
            />
          );
          return multiple ? (
            <View key={input.key} className="gap-1.5">
              <Text className="font-t3-medium text-sm text-foreground-muted">{input.label}</Text>
              {field}
            </View>
          ) : (
            field
          );
        })
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
        disabled={submitting || !canSave}
        onPress={() => save(values)}
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
  const gt = useGT();
  const paste = async () => {
    const text = await Clipboard.getStringAsync().catch(() => "");
    if (text.trim().length === 0) {
      props.onError(gt("The clipboard is empty. Copy the value first."));
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
          ? gt("Copy the value, then paste it here.")
          : gt(
              "Pasted {count} characters on {lines, plural, one {{lines} line} other {{lines} lines}}",
              { count: props.secret.length, lines },
            )}
      </Text>
      {props.secret.length > 0 ? (
        <Button
          label={gt("Clear")}
          tone="secondary"
          disabled={props.disabled}
          onPress={() => props.onChange("")}
        />
      ) : null}
      <Button
        label={gt("Paste")}
        tone="secondary"
        disabled={props.disabled}
        onPress={() => void paste()}
      />
    </View>
  );
}
