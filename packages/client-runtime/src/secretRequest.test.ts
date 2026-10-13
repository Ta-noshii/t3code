import { SecretRequestError, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestCopy,
  secretRequestDisplay,
  secretRequestFailureMessage,
  type SecretRequestItem,
} from "./secretRequest.ts";

const item = {
  id: TurnItemId.make("turn-item:secret-request:1"),
  threadId: ThreadId.make("thread-1"),
};

describe("secretRequestDisplay", () => {
  it("shows the form only while pending and maps every answer to its outcome copy", () => {
    const display = (secretStatus: SecretRequestItem["secretStatus"]) =>
      secretRequestDisplay({ secretStatus }, "local");
    expect(display("pending")).toEqual({ kind: "pending" });
    expect(display("saved")).toEqual({
      kind: "answered",
      outcome: "saved",
      label: "Saved securely and kept private",
    });
    expect(display("declined")).toEqual({
      kind: "answered",
      outcome: "declined",
      label: "Declined",
    });
    expect(display("cancelled")).toEqual({
      kind: "answered",
      outcome: "ended",
      label: "Request ended",
    });
  });

  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestAnswerInput", () => {
  it("refuses a blank save and trims the value the server will store", () => {
    expect(secretRequestAnswerInput(item, { type: "save", secret: "   " })).toBeNull();
    expect(secretRequestAnswerInput(item, { type: "save", secret: " whsec_1 " })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "save", secret: "whsec_1" },
    });
    expect(secretRequestAnswerInput(item, { type: "decline" })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "decline" },
    });
  });
});

describe("shell prompts", () => {
  const sudo = { kind: "sudo", multiline: false } as const;

  it("sends a waiting command's value as typed, but still refuses a blank one", () => {
    const shellItem = { ...item, shellPrompt: { kind: "secret", multiline: true } as const };
    expect(secretRequestAnswerInput(shellItem, { type: "save", secret: " \n " })).toBeNull();
    expect(
      secretRequestAnswerInput(shellItem, { type: "save", secret: "-----KEY-----\n" }),
    ).toMatchObject({ answer: { type: "save", secret: "-----KEY-----\n" } });
  });

  it("words a sudo card as a root password with the command shown", () => {
    expect(
      secretRequestCopy({ reason: " pacman -S foo ", placeholder: undefined, shellPrompt: sudo }),
    ).toEqual({
      placeholder: "Password",
      privacyNote: "Sent only to the waiting command, never stored or shown to the agent",
      saveLabel: "Allow",
      declineLabel: "Deny",
      multiline: false,
      command: "pacman -S foo",
    });
    expect(
      secretRequestCopy({
        reason: "Deploy key",
        placeholder: undefined,
        shellPrompt: { kind: "secret", multiline: true },
      }),
    ).toMatchObject({ saveLabel: "Send", multiline: true, command: null });
    expect(secretRequestCopy({ reason: "", placeholder: "whsec_..." })).toMatchObject({
      placeholder: "whsec_...",
      saveLabel: "Save securely",
    });
  });

  it("reads an answered prompt as sent or denied, and a withdrawn one as ended", () => {
    const display = (secretStatus: SecretRequestItem["secretStatus"]) =>
      secretRequestDisplay({ secretStatus, shellPrompt: sudo }, "local");
    expect(display("saved")).toMatchObject({ label: "Sent to the waiting command" });
    expect(display("declined")).toMatchObject({ label: "Denied" });
    expect(display("cancelled")).toMatchObject({ outcome: "ended", label: "Request ended" });
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});
