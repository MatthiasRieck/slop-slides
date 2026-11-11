import { FileText, Globe, Pencil, Search, SquareTerminal } from "lucide-react";
import { describe, expect, it } from "vitest";

import { describeTool, editedSlide, type ToolPart, toolArguments } from "./toolCalls";

const DECK = "/decks/talk/deck.html";

const tool = (name: string, input: Record<string, unknown>): ToolPart => ({
  kind: "tool",
  id: name,
  name,
  input,
  status: "done",
});

describe("describeTool", () => {
  it.each([
    ["Write", { file_path: "/decks/talk/deck.html" }, FileText, "Wrote", "deck.html"],
    ["Edit", { file_path: "\\decks\\talk\\assets\\x.css" }, Pencil, "Edited", "assets/x.css"],
    ["Edit", { file_path: "/decks/talk-old/deck.html" }, Pencil, "Edited", "/decks/talk-old/deck.html"],
    ["MultiEdit", { file_path: "/elsewhere/file.txt" }, Pencil, "Edited", "/elsewhere/file.txt"],
    ["Read", { file_path: "/decks/talk/assets/notes.md" }, FileText, "Read", "assets/notes.md"],
    ["Grep", { pattern: 'class="slide"' }, Search, "Searched", 'class="slide"'],
    ["Glob", { pattern: "assets/*" }, Search, "Searched", "assets/*"],
    ["WebSearch", { query: "pitch deck tips" }, Globe, "Searched the web for", "pitch deck tips"],
    ["WebFetch", { url: "https://example.com" }, Globe, "Fetched", "https://example.com"],
    ["Bash", { command: "ls assets" }, SquareTerminal, "Ran", "ls assets"],
    ["TodoWrite", { todos: [] }, FileText, "TodoWrite", ""],
    ["Write", { file_path: 42 }, FileText, "Wrote", ""],
  ])("describes %s calls", (name, input, icon, label, target) => {
    expect(describeTool(tool(name, input), DECK)).toEqual({ icon, label, target });
  });
});

describe("toolArguments", () => {
  it("lists text as it is and anything else as JSON, leaving out what is missing", () => {
    const part = tool("Edit", {
      file_path: "/decks/talk/deck.html",
      new_string: "<h1>\n  New\n</h1>",
      replace_all: false,
      limit: 20,
      edits: [{ a: 1 }],
      nothing: null,
    });
    expect(toolArguments(part)).toEqual([
      { name: "file_path", value: "/decks/talk/deck.html" },
      { name: "new_string", value: "<h1>\n  New\n</h1>" },
      { name: "replace_all", value: "false" },
      { name: "limit", value: "20" },
      { name: "edits", value: '[\n  {\n    "a": 1\n  }\n]' },
    ]);
  });

  it("lists nothing for a call without arguments, or one saved without any", () => {
    expect(toolArguments(tool("lint_deck", {}))).toEqual([]);
    expect(toolArguments({ ...tool("lint_deck", {}), input: null as unknown as Record<string, unknown> })).toEqual([]);
  });
});

describe("editedSlide", () => {
  const slides = ["intro", "outro"];

  it("finds the slide an edit of the deck file touched, in the new text or else the old", () => {
    const edit = tool("Edit", { old_string: `<section id="intro">`, new_string: `<section class="slide" id='outro'>` });
    expect(editedSlide(edit, "deck.html", DECK, slides)).toBe("outro");
    expect(editedSlide(tool("Edit", { old_string: `<section id="intro">` }), "deck.html", DECK, slides)).toBe("intro");
  });

  it("finds nothing for unknown ids or other files", () => {
    expect(editedSlide(tool("Edit", { new_string: `<div id="not-a-slide">` }), "deck.html", DECK, slides)).toBeNull();
    expect(editedSlide(tool("Edit", { new_string: `<section id="intro">` }), "notes.html", DECK, slides)).toBeNull();
  });
});
