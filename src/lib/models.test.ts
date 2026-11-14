import { describe, expect, it } from "vitest";

import { contextWindowHint, effortHint, shortEffortLabel, shortModelLabel } from "./models";

describe("names that fit the composer's footer", () => {
  it("leaves out the provider's name its icon already gives", () => {
    expect(shortModelLabel("claude", "Claude Opus 5.5")).toBe("Opus 5.5");
    expect(shortModelLabel("copilot", "Claude Sonnet 5")).toBe("Claude Sonnet 5");
    expect(shortModelLabel("codex", "GPT-6-Astra")).toBe("GPT-6-Astra");
    expect(shortModelLabel("claude", "Claude")).toBe("Claude");
  });

  it("names an effort in five letters at most", () => {
    expect(shortEffortLabel("medium")).toBe("Med");
    expect(shortEffortLabel("xhigh")).toBe("XHigh");
    expect(shortEffortLabel("ultrathink")).toBe("Ultra");
  });
});

describe("hints", () => {
  it("says what each effort and window trades, and nothing for one it does not know", () => {
    expect(effortHint("low")).toMatch(/small edits/);
    expect(effortHint("high")).toMatch(/whole-deck/);
    expect(effortHint("weird")).toBe("");
    expect(contextWindowHint("1m")).toMatch(/cost more/);
    expect(contextWindowHint("2m")).toBe("");
  });
});
