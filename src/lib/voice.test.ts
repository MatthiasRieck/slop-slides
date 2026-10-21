import { describe, expect, it } from "vitest";

import { formatBytes, insertTranscript } from "./voice";

describe("insertTranscript", () => {
  it("fills an empty draft", () => {
    expect(insertTranscript("", "Make it blue.")).toEqual({ draft: "Make it blue.", caret: 13 });
  });

  it("appends after a space to existing text", () => {
    expect(insertTranscript("Slide 3:", "bigger title")).toEqual({ draft: "Slide 3: bigger title", caret: 21 });
    expect(insertTranscript("Slide 3: ", "bigger title").draft).toBe("Slide 3: bigger title");
  });

  it("goes in at the caret, spaced from the words on both sides", () => {
    const result = insertTranscript("Make the title.", "really big", 8);
    expect(result.draft).toBe("Make the really big title.");
    expect(result.caret).toBe("Make the really big".length);
  });

  it("replaces the selection", () => {
    expect(insertTranscript("Make it red please", "blue", 8, 11).draft).toBe("Make it blue please");
  });
});

describe("formatBytes", () => {
  it("rounds to the largest unit", () => {
    expect(formatBytes(190_085_487)).toBe("190 MB");
    expect(formatBytes(1_624_555_275)).toBe("1.6 GB");
    expect(formatBytes(2_048)).toBe("2 KB");
    expect(formatBytes(12)).toBe("12 B");
  });
});
