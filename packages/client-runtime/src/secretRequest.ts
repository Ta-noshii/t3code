import type { OrchestrationV2TurnItem, SecretRequestAnswerInput } from "@t3tools/contracts";

export type SecretRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "secret_request" }
>;

export const SECRET_REQUEST_PRIVACY_NOTE = "Stored securely, never shown to the agent";
export const SECRET_REQUEST_DEFAULT_PLACEHOLDER = "Paste the secret";

/**
 * Words on a pending card. Requests from `t3 secret prompt` hand the value
 * straight to the waiting command instead of storing it, so they promise that
 * instead; a sudo prompt shows the command that wants root.
 */
export interface SecretRequestCopy {
  readonly placeholder: string;
  readonly privacyNote: string;
  readonly saveLabel: string;
  readonly declineLabel: string;
  readonly multiline: boolean;
  /** Shown in monospace under the title; null when there is no command to show. */
  readonly command: string | null;
}

export function secretRequestCopy(
  item: Pick<SecretRequestItem, "placeholder" | "reason" | "shellPrompt">,
): SecretRequestCopy {
  const prompt = item.shellPrompt;
  if (prompt === undefined) {
    return {
      placeholder: item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER,
      privacyNote: SECRET_REQUEST_PRIVACY_NOTE,
      saveLabel: "Save securely",
      declineLabel: "Decline",
      multiline: false,
      command: null,
    };
  }
  const command = prompt.kind === "sudo" && item.reason.trim() ? item.reason.trim() : null;
  return {
    placeholder: prompt.kind === "sudo" ? "Password" : prompt.multiline ? "Paste it here" : "Value",
    privacyNote: "Sent only to the waiting command, never stored or shown to the agent",
    saveLabel: prompt.kind === "sudo" ? "Allow" : "Send",
    declineLabel: "Deny",
    multiline: prompt.multiline,
    command,
  };
}

/** What a secret request card shows: the form while pending, otherwise a one-line outcome. */
export type SecretRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "saved" | "declined" | "ended";
      readonly label: string;
    };

const SAVED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "saved",
  label: "Saved securely and kept private",
};
const DECLINED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "declined",
  label: "Declined",
};
const ENDED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "ended",
  label: "Request ended",
};
const SENT_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "saved",
  label: "Sent to the waiting command",
};
const DENIED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "declined",
  label: "Denied",
};
const PENDING_DISPLAY: SecretRequestDisplay = { kind: "pending" };
const PENDING_ELSEWHERE_DISPLAY: SecretRequestDisplay = {
  kind: "pending-elsewhere",
  label: "Waiting for an answer in the original thread",
};

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked.
 */
export function secretRequestDisplay(
  item: Pick<SecretRequestItem, "secretStatus" | "shellPrompt">,
  visibility: "local" | "inherited" | "synthetic",
): SecretRequestDisplay {
  switch (item.secretStatus) {
    case "pending":
      return visibility === "local" ? PENDING_DISPLAY : PENDING_ELSEWHERE_DISPLAY;
    case "saved":
      return item.shellPrompt === undefined ? SAVED_DISPLAY : SENT_DISPLAY;
    case "declined":
      return item.shellPrompt === undefined ? DECLINED_DISPLAY : DENIED_DISPLAY;
    // Also how a prompt reads once its command exits or times out.
    case "cancelled":
      return ENDED_DISPLAY;
  }
}

/**
 * Builds the RPC payload for an answer. A save with a blank value returns null,
 * since the server rejects it; callers keep Save disabled instead. A stored
 * secret is trimmed. A value for a waiting command goes as typed, since a
 * password or key may carry spaces or a final newline that matter.
 */
export function secretRequestAnswerInput(
  item: Pick<SecretRequestItem, "id" | "threadId" | "shellPrompt">,
  answer: { readonly type: "save"; readonly secret: string } | { readonly type: "decline" },
): SecretRequestAnswerInput | null {
  if (answer.type === "decline") {
    return { threadId: item.threadId, turnItemId: item.id, answer: { type: "decline" } };
  }
  if (answer.secret.trim().length === 0) return null;
  const secret = item.shellPrompt === undefined ? answer.secret.trim() : answer.secret;
  return { threadId: item.threadId, turnItemId: item.id, answer: { type: "save", secret } };
}

const USER_FACING_FAILURE_TAGS = new Set(["SecretRequestError", "EnvironmentAuthorizationError"]);

/**
 * Only known server errors pass their message through: anything else (transport or encoding
 * failures) gets the generic copy, so the typed value can never surface in the UI.
 */
export function secretRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}
