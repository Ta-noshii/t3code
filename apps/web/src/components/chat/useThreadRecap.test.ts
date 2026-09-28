import { describe, expect, it } from "vite-plus/test";

import { shouldRecapThread, THREAD_RECAP_AWAY_MS } from "./useThreadRecap";

describe("shouldRecapThread", () => {
  const completedAt = "2026-09-28T10:00:00.000Z";
  const completed = Date.parse(completedAt);
  const base = { completedAt, idle: true, turnState: "completed" } as const;

  it("recaps a finished thread the user has been away from for five minutes", () => {
    const now = completed + THREAD_RECAP_AWAY_MS + 1_000;
    expect(shouldRecapThread({ ...base, now, lastSeenAt: undefined })).toBe(true);
    expect(shouldRecapThread({ ...base, now, lastSeenAt: now - 60_000 })).toBe(false);
    expect(shouldRecapThread({ ...base, now, lastSeenAt: now - THREAD_RECAP_AWAY_MS })).toBe(true);
  });

  it("leaves running and unfinished threads alone", () => {
    const now = completed + THREAD_RECAP_AWAY_MS * 3;
    expect(shouldRecapThread({ ...base, now, lastSeenAt: undefined, idle: false })).toBe(false);
    expect(
      shouldRecapThread({ ...base, now, lastSeenAt: undefined, turnState: "interrupted" }),
    ).toBe(false);
  });
});
