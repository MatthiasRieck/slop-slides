import { describe, expect, it } from "vitest";

import type { LintIssue, OpenedFile } from "../lib/api";
import { DEFAULT_SIZE } from "../lib/slideSize";
import { DECK_HTML, deckFor } from "../test/fixtures";
import type { UserMessage } from "./messages";
import {
  buildPrompt,
  cleanNarrationPrompt,
  lintFixPrompt,
  type PromptContext,
  resizePrompt,
  withRevertNotes,
} from "./prompts";
import { DECK } from "./testing";

describe("the context sent with a message", () => {
  const message = (patch: Partial<UserMessage> = {}): UserMessage => ({
    id: "u",
    role: "user",
    text: "Make it blue",
    slide: null,
    attachments: [],
    createdAt: 0,
    ...patch,
  });
  const at = (patch: Partial<PromptContext> = {}): PromptContext => ({
    workspace: { path: "/decks/talk", name: "talk" },
    deck: DECK,
    openedFile: null,
    template: null,
    ...patch,
  });

  it("names a deck file that is not deck.html for the agent", () => {
    const deck = { ...DECK, id: "/ws/talks/q3.html", path: "/ws/talks/q3.html" };
    expect(buildPrompt(message({ slide: "#2" }), at({ workspace: { path: "/ws", name: "ws" }, deck }))).toBe(
      `[context]\nOpen file: talks/q3.html (deck)\nCurrent slide: <section id="#2"> in talks/q3.html (slide 2 of 3)\n[/context]\n\nMake it blue`,
    );
  });

  it("tells the agent when the selected slide is locked", () => {
    const deck = deckFor(DECK_HTML.replace(`id="outro"`, `id="outro" data-locked`));
    expect(buildPrompt(message({ slide: "outro" }), at({ deck }))).toBe(
      `[context]\nOpen file: deck.html (deck)\nCurrent slide: <section id="outro"> in deck.html (slide 3 of 3)\nThe current slide is locked (data-locked): do not change it.\n[/context]\n\nMake it blue`,
    );
  });

  it("mentions an empty deck and attached files", () => {
    const attachments = ["assets/a.png", "assets/b.csv"];
    expect(buildPrompt(message({ text: "Start", attachments }), at({ deck: { ...DECK, slides: [] } }))).toBe(
      "[context]\nOpen file: deck.html (deck)\nThe deck has no slides yet.\nAttached files: assets/a.png, assets/b.csv\n[/context]\n\nStart",
    );
  });

  it.each([
    [null, "No file open"],
    [
      { path: "site/index.html", absolute: "/decks/talk/site/index.html", kind: "webpage" },
      "Open file: site/index.html (web page)",
    ],
    [{ path: "notes.md", absolute: "/decks/talk/notes.md", kind: "file" }, "Open file: notes.md (file)"],
  ] as [OpenedFile | null, string][])("describes the open file %j when there is no deck", (openedFile, context) => {
    expect(buildPrompt(message(), at({ deck: null, openedFile }))).toBe(
      `[context]\n${context}\n[/context]\n\nMake it blue`,
    );
  });

  it("shortens long markup of the element the message is about", () => {
    const markup = `<svg>${"x".repeat(5000)}</svg>`;
    const element = { path: "#intro > svg", markup, name: "<svg>", added: false };
    const prompt = buildPrompt(message({ slide: "intro", element }), at());
    expect(prompt).toContain(`Its markup: ${markup.slice(0, 4000)}…\n`);
    expect(prompt).not.toContain(markup);
  });
});

describe("requests for the agent", () => {
  const issue = (patch: Partial<LintIssue> = {}): LintIssue => ({
    rule: "unclosed-tag",
    severity: "error",
    message: "<div> is never closed.",
    line: 12,
    slide: "intro",
    ...patch,
  });

  it("lintFixPrompt lists every issue and asks the agent to verify with its tool", () => {
    const prompt = lintFixPrompt([
      issue(),
      issue({ severity: "warning", rule: "title", message: "Needs a title.", line: 1, slide: null }),
    ]);
    expect(prompt).toContain("- line 12 error [unclosed-tag] (slide `intro`): <div> is never closed.");
    expect(prompt).toContain("- line 1 warning [title]: Needs a title.");
    expect(prompt).toMatch(/run the lint_deck tool to verify/);
    expect(prompt).toMatch(/^deck\.html does not pass/);
    expect(lintFixPrompt([], "q3.html")).toMatch(/^q3\.html does not pass/);
  });

  it("tells the agent about several undone turns at once", () => {
    expect(withRevertNotes([], "P")).toBe("P");
    expect(withRevertNotes([{ label: '"a"' }, { label: '"b"' }], "P")).toMatch(
      /^\[note\]The user undid the changes your turns for the messages "a", "b" made to the deck;.*\[\/note\]\n\nP$/,
    );
  });
});

describe("cleanNarrationPrompt", () => {
  it("names the slide, or every slide", () => {
    expect(cleanNarrationPrompt("intro")).toContain("the narration of slide `intro`");
    expect(cleanNarrationPrompt(null)).toContain("every slide");
  });

  it("asks for clean, fluent text and keeps the agent to the narration", () => {
    const prompt = cleanNarrationPrompt(null);
    for (const part of ["stutters", "clean, fluent", "same language", '<aside class="narration">', "locked slides"]) {
      expect(prompt).toContain(part);
    }
  });
});

describe("resizePrompt", () => {
  it("asks the agent to lay the deck out again for the new size", () => {
    const prompt = resizePrompt(DEFAULT_SIZE, { width: 8.5, height: 11, unit: "in" });
    expect(prompt).toContain("from landscape, 1920 × 1080 px to portrait, 8.5 × 11 in (816 × 1056 px)");
    expect(prompt).toContain("Re-lay out every slide for the new canvas");
    expect(prompt).toContain("Keep all content, slide ids");
  });
});
