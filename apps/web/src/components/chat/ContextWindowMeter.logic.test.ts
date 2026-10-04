import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  buildAutoCompactWindowOptions,
  formatContextWindowCompactionMessage,
  parseAutoCompactWindow,
  hasAvailableCompactionProvider,
  hasDismissedResumeCompaction,
  formatContextWindowCost,
  resolveContextWindowModelDisplayName,
  shouldOfferResumeCompaction,
  shouldReserveContextWindowMeter,
} from "./ContextWindowMeter.logic";

function claudeProvider(input: {
  instanceId: string;
  continuationGroupKey: string;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    continuation: { groupKey: input.continuationGroupKey },
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-24T12:00:00.000Z",
    models: [],
    slashCommands: [{ name: "compact", description: "" }],
    skills: [],
  };
}

describe("hasAvailableCompactionProvider", () => {
  const originalInstanceId = ProviderInstanceId.make("claude_original");

  it("rejects a fallback in a different locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_other",
        continuationGroupKey: "claude:home:/other",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(false);
  });

  it("accepts an enabled fallback in the locked continuation group", () => {
    const providers = deriveProviderInstanceEntries([
      claudeProvider({
        instanceId: originalInstanceId,
        continuationGroupKey: "claude:home:/original",
        enabled: false,
      }),
      claudeProvider({
        instanceId: "claude_fallback",
        continuationGroupKey: "claude:home:/original",
      }),
    ]);

    expect(
      hasAvailableCompactionProvider({
        providers,
        driverKind: ProviderDriverKind.make("claudeAgent"),
        instanceId: originalInstanceId,
        lockedInstanceId: originalInstanceId,
      }),
    ).toBe(true);
  });
});

describe("resolveContextWindowModelDisplayName", () => {
  it("uses the selected model from the exact provider instance", () => {
    const primaryInstanceId = ProviderInstanceId.make("codex");
    const selectedInstanceId = ProviderInstanceId.make("codex-work");
    const modelOptionsByInstance = new Map([
      [
        primaryInstanceId,
        [{ slug: "gpt-5.6-sol", name: "Primary profile model", shortName: "Primary" }],
      ],
      [selectedInstanceId, [{ slug: "gpt-5.6-sol", name: "GPT-5.6 Sol", shortName: "5.6 Sol" }]],
    ]);

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "gpt-5.6-sol",
        },
        modelOptionsByInstance,
      ),
    ).toBe("5.6 Sol");
  });

  it("falls back to the selected model slug when model metadata is unavailable", () => {
    const selectedInstanceId = ProviderInstanceId.make("codex-work");

    expect(
      resolveContextWindowModelDisplayName(
        {
          instanceId: selectedInstanceId,
          model: "custom-model",
        },
        new Map(),
      ),
    ).toBe("custom-model");
  });
});

describe("formatContextWindowCompactionMessage", () => {
  it("describes compaction in terms of the selected model", () => {
    expect(formatContextWindowCompactionMessage("GPT-5.6 Sol")).toBe(
      "Context for GPT-5.6 Sol compacts automatically when needed.",
    );
  });

  it("uses neutral copy when the model is unavailable", () => {
    expect(formatContextWindowCompactionMessage(null)).toBe(
      "Context compacts automatically when needed.",
    );
  });

  it("shows the configured auto-compaction threshold", () => {
    expect(formatContextWindowCompactionMessage("Claude Sonnet 5", 300_000)).toBe(
      "Compacts automatically at 300,000 tokens.",
    );
  });

  it("describes a configured auto-compact window when no threshold is reported", () => {
    expect(formatContextWindowCompactionMessage("Claude Opus 4.7", null, 400_000)).toBe(
      "Compacts automatically as context nears 400,000 tokens.",
    );
  });

  it("prefers the reported threshold over the configured window", () => {
    expect(formatContextWindowCompactionMessage("Claude Opus 4.7", 300_000, 400_000)).toBe(
      "Compacts automatically at 300,000 tokens.",
    );
  });
});

describe("parseAutoCompactWindow", () => {
  it("reads values inside the setting's range", () => {
    expect(parseAutoCompactWindow("100000")).toBe(100_000);
    expect(parseAutoCompactWindow(" 1000000 ")).toBe(1_000_000);
  });

  it("treats empty and out-of-range values as Claude's default", () => {
    expect(parseAutoCompactWindow("")).toBeNull();
    expect(parseAutoCompactWindow(undefined)).toBeNull();
    expect(parseAutoCompactWindow("99999")).toBeNull();
    expect(parseAutoCompactWindow("1000001")).toBeNull();
    expect(parseAutoCompactWindow("300k")).toBeNull();
  });
});

describe("buildAutoCompactWindowOptions", () => {
  const values = (options: ReturnType<typeof buildAutoCompactWindowOptions>) =>
    options.map((option) => option.value);

  it("offers every preset up to a 1M context window", () => {
    const options = buildAutoCompactWindowOptions({ maxTokens: 1_000_000, current: "" });
    expect(options.map((option) => option.label)).toEqual([
      "Claude default",
      "100k",
      "150k",
      "200k",
      "300k",
      "400k",
      "500k",
      "750k",
      "1M",
    ]);
  });

  it("leaves out presets above the model's context window", () => {
    expect(values(buildAutoCompactWindowOptions({ maxTokens: 200_000, current: "" }))).toEqual([
      "",
      "100000",
      "150000",
      "200000",
    ]);
  });

  it("offers every preset when the context window is unknown", () => {
    expect(buildAutoCompactWindowOptions({ maxTokens: null, current: "" })).toHaveLength(9);
  });

  it("keeps a saved value that is not a preset, in order", () => {
    const options = buildAutoCompactWindowOptions({ maxTokens: 200_000, current: "350000" });
    expect(values(options)).toEqual(["", "100000", "150000", "200000", "350000"]);
    expect(options.at(-1)?.label).toBe("350k");
  });
});

describe("shouldOfferResumeCompaction", () => {
  const now = "2026-08-24T12:00:00.000Z";

  it("matches Claude's old-session age and context thresholds", () => {
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 100_000,
        updatedAt: "2026-08-24T10:50:00.000Z",
        now,
      }),
    ).toBe(true);
  });

  it("does not prompt for recent or smaller sessions", () => {
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 99_999,
        updatedAt: "2026-08-24T10:00:00.000Z",
        now,
      }),
    ).toBe(false);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: 200_000,
        updatedAt: "2026-08-24T10:51:00.000Z",
        now,
      }),
    ).toBe(false);
  });

  it("does not show Claude's resume prompt for another provider", () => {
    expect(
      shouldOfferResumeCompaction({
        provider: "codex",
        usedTokens: 300_000,
        updatedAt: "2026-08-24T09:00:00.000Z",
        now,
      }),
    ).toBe(false);
  });
});

describe("hasDismissedResumeCompaction", () => {
  it("recognizes the native resume dialog's permanent dismissal", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "This session is 2h 0m old and uses 250,000 tokens. Compact it before continuing?":
                "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(true);
  });

  it("ignores the same answer on an unrelated question", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: { answers: { "Show this setup reminder?": "Don't ask again" } },
        },
      ]),
    ).toBe(false);
  });

  it("ignores unrelated questions that end with Claude's compaction prompt", () => {
    expect(
      hasDismissedResumeCompaction([
        {
          kind: "user-input.resolved",
          payload: {
            answers: {
              "The build cache is large. Compact it before continuing?": "Don't ask again",
            },
          },
        },
      ]),
    ).toBe(false);
  });

  it("ignores pending questions and malformed resolved payloads", () => {
    expect(
      hasDismissedResumeCompaction([
        { kind: "user-input.requested", payload: { answers: { question: "Don't ask again" } } },
        { kind: "user-input.resolved", payload: null },
        { kind: "user-input.resolved", payload: { answers: ["Don't ask again"] } },
      ]),
    ).toBe(false);
  });
});

describe("shouldReserveContextWindowMeter", () => {
  const loadingStartedThread = {
    meterEnabled: true,
    detailLoading: true,
    threadStarted: true,
    providerReportsContextWindow: true,
  };

  it("holds the meter's slot while a started thread's detail loads", () => {
    expect(shouldReserveContextWindowMeter(loadingStartedThread)).toBe(true);
  });

  it("reserves nothing once the detail is in", () => {
    expect(shouldReserveContextWindowMeter({ ...loadingStartedThread, detailLoading: false })).toBe(
      false,
    );
  });

  it("reserves nothing for a thread that never ran a turn", () => {
    expect(shouldReserveContextWindowMeter({ ...loadingStartedThread, threadStarted: false })).toBe(
      false,
    );
  });

  it("reserves while the thread's provider is not in the catalog yet", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: null,
      }),
    ).toBe(true);
  });

  it("reserves nothing for a provider that does not stream usage", () => {
    expect(
      shouldReserveContextWindowMeter({
        ...loadingStartedThread,
        providerReportsContextWindow: false,
      }),
    ).toBe(false);
  });

  it("reserves nothing while the meter is switched off", () => {
    expect(shouldReserveContextWindowMeter({ ...loadingStartedThread, meterEnabled: false })).toBe(
      false,
    );
  });
});

describe("formatContextWindowCost", () => {
  it("keeps ordinary and sub-cent ACP costs readable", () => {
    expect(formatContextWindowCost({ amount: 0.42, currency: "USD" })).toBe("USD 0.42");
    expect(formatContextWindowCost({ amount: 0.0042, currency: "USD" })).toBe("USD 0.0042");
  });
});
