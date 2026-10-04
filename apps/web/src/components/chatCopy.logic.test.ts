import { MessageId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCopyHandoffMessage,
  chatCopyMessages,
  resolveCopyModelSelection,
} from "./chatCopy.logic";

const now = "2026-09-23T10:00:00.000Z";
const message = (id: string, role: "user" | "assistant" | "system", text: string) => ({
  id: MessageId.make(id),
  role,
  text,
  runId: null,
  streaming: false,
  createdAt: now,
  updatedAt: now,
});

describe("chatCopyMessages", () => {
  it("keeps finished conversation, with context links reduced to their labels", () => {
    expect(
      chatCopyMessages([
        message("u1", "user", "Read [parser.ts](t3-context://v1/mention/ctx_1)"),
        message("s1", "system", "Compacted"),
        { ...message("a1", "assistant", "Working"), streaming: true },
      ]),
    ).toEqual([{ role: "user", text: "Read parser.ts", createdAt: now }]);
  });
});

describe("buildCopyHandoffMessage", () => {
  it("hands a copy the conversation and asks the agent to take it over", () => {
    const handoff = buildCopyHandoffMessage({
      title: "Parser",
      messages: [
        { role: "user", text: "Fix the parser" },
        { role: "assistant", text: "Done." },
      ],
      copiedFrom: "graduation",
      maxChars: 10_000,
    });
    expect(handoff).toContain('copied from "Parser" on graduation');
    expect(handoff).toContain("## User\n\nFix the parser\n\n## Assistant\n\nDone.");
    expect(handoff.endsWith("then wait for my next message.")).toBe(true);
  });

  it("drops the oldest messages when the conversation is too long", () => {
    const handoff = buildCopyHandoffMessage({
      title: "Parser",
      messages: [
        { role: "user", text: "old ".repeat(300) },
        { role: "assistant", text: "Newest reply." },
      ],
      copiedFrom: "graduation",
      maxChars: 1_000,
    });
    expect(handoff.length).toBeLessThanOrEqual(1_000);
    expect(handoff).toContain("The 1 oldest messages were left out");
    expect(handoff).not.toContain("old old");
    expect(handoff).toContain("Newest reply.");
  });
});

describe("resolveCopyModelSelection", () => {
  const provider = (instanceId: string, driver: string, enabled = true) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled,
    installed: true,
  });
  const source = { instanceId: ProviderInstanceId.make("claude-work"), model: "claude-opus-5-5" };
  const sourceProviders = [provider("claude-work", "claudeAgent")];

  it("keeps the source instance when the target has it", () => {
    expect(
      resolveCopyModelSelection({
        source,
        sourceProviders,
        targetProviders: [
          provider("claudeAgent", "claudeAgent"),
          provider("claude-work", "claudeAgent"),
        ],
      })?.instanceId,
    ).toBe("claude-work");
  });

  it("falls back to the target's instance of the same driver", () => {
    expect(
      resolveCopyModelSelection({
        source,
        sourceProviders,
        targetProviders: [
          provider("codex", "codex"),
          provider("claude-off", "claudeAgent", false),
          provider("claudeAgent", "claudeAgent"),
        ],
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
  });

  it("returns null when the target lacks the driver", () => {
    expect(
      resolveCopyModelSelection({
        source,
        sourceProviders,
        targetProviders: [provider("codex", "codex")],
      }),
    ).toBeNull();
  });
});
