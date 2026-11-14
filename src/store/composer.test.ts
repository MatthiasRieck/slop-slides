import { beforeEach, describe, expect, it } from "vitest";

import { type ComposerDraft, forgetDrafts, keepDraft, keptDraft } from "./composer";

const draft = (patch: Partial<ComposerDraft> = {}): ComposerDraft => ({
  text: "",
  attachments: [],
  unsent: {},
  screenshot: null,
  element: null,
  includeSlide: true,
  slides: [],
  ...patch,
});

beforeEach(forgetDrafts);

describe("the drafts of the chats not on show", () => {
  it("are kept by what each chat is about", () => {
    keepDraft("/a/deck.html", draft({ text: "Half a thought" }));
    keepDraft("/b/deck.html", draft({ attachments: ["assets/x.png"] }));
    expect(keptDraft("/a/deck.html")?.text).toBe("Half a thought");
    expect(keptDraft("/b/deck.html")?.attachments).toEqual(["assets/x.png"]);
    expect(keptDraft("/c/deck.html")).toBeNull();
    expect(keptDraft(null)).toBeNull();
  });

  it("forget a draft that holds nothing", () => {
    keepDraft("/a/deck.html", draft({ text: "x" }));
    keepDraft("/a/deck.html", draft({ text: "  ", includeSlide: false }));
    expect(keptDraft("/a/deck.html")).toBeNull();
  });
});
