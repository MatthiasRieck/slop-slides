import { describe, expect, it } from "vitest";

import { contextPercent, formatTokens, latestContext, mergeContext, windowTokens, type ContextUsage } from "./context";

const usage = (patch: Partial<ContextUsage> = {}): ContextUsage => ({
  provider: "claude",
  tokens: 1000,
  window: 200_000,
  ...patch,
});

describe("context usage", () => {
  it("formats token counts compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(850)).toBe("850");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_345)).toBe("12k");
    expect(formatTokens(9_950)).toBe("9.9k");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(146_400)).toBe("146k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(999_700)).toBe("1M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  it("computes the share of the window in use, capped at 100", () => {
    expect(contextPercent(50_000, 200_000)).toBe(25);
    expect(contextPercent(300_000, 200_000)).toBe(100);
    expect(contextPercent(null, 200_000)).toBeNull();
    expect(contextPercent(10, null)).toBeNull();
    expect(contextPercent(10, 0)).toBeNull();
  });

  it("reads the window size of a Claude context window choice", () => {
    expect(windowTokens("200k")).toBe(200_000);
    expect(windowTokens("1m")).toBe(1_000_000);
    expect(windowTokens("2m")).toBeNull();
    expect(windowTokens(null)).toBeNull();
    expect(windowTokens(undefined)).toBeNull();
  });

  it("finds the newest usage of the provider's own conversation", () => {
    const messages = [
      { role: "assistant", context: usage({ tokens: 1 }) },
      { role: "assistant", context: usage({ provider: "copilot", tokens: 2 }) },
      { role: "user" },
      { role: "assistant", context: null },
      { role: "assistant" },
    ];
    expect(latestContext(messages, "claude")?.tokens).toBe(1);
    expect(latestContext(messages, "copilot")?.tokens).toBe(2);
    expect(latestContext(messages, "codex")).toBeNull();
    expect(latestContext([], "claude")).toBeNull();
  });

  it("merges a usage report, keeping what it leaves unknown", () => {
    expect(mergeContext(null, "claude", { contextTokens: 500, contextWindow: null })).toEqual({
      provider: "claude",
      tokens: 500,
      window: null,
    });
    const previous = usage({ tokens: 500, window: null });
    expect(mergeContext(previous, "claude", { contextTokens: null, contextWindow: 1_000_000 })).toEqual(
      usage({ tokens: 500, window: 1_000_000 }),
    );
    expect(mergeContext(usage({ tokens: null }), "claude", { contextTokens: null, contextWindow: 200_000 }).tokens).toBeNull();
    expect(mergeContext(usage(), "claude", { contextTokens: 7, contextWindow: 8 })).toEqual(usage({ tokens: 7, window: 8 }));
  });
});
