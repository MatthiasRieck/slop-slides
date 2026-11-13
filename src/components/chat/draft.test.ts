// @vitest-environment node
import { describe, expect, it } from "vitest";

import { appendDraft } from "./draft";

describe("appendDraft", () => {
  it("takes the place of an empty draft, or one of blanks", () => {
    expect(appendDraft("", "Fix it")).toBe("Fix it");
    expect(appendDraft("  \n", "Fix it")).toBe("Fix it");
  });

  it("goes after what is typed, a blank line between them", () => {
    expect(appendDraft("Use blue", "Fix it")).toBe("Use blue\n\nFix it");
    expect(appendDraft("Use blue\n\n ", "Fix it")).toBe("Use blue\n\nFix it");
  });

  it("is not added to a draft that ends with it already", () => {
    expect(appendDraft("Fix it", "Fix it")).toBe("Fix it");
    expect(appendDraft("Use blue\n\nFix it  ", "Fix it")).toBe("Use blue\n\nFix it  ");
  });

  it("leaves the draft alone when there is nothing to add", () => {
    expect(appendDraft("Use blue", "")).toBe("Use blue");
    expect(appendDraft("Use blue", "  ")).toBe("Use blue");
  });
});
