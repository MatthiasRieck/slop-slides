import { FileText, Globe, Pencil, Search, SquareTerminal } from "lucide-react";
import { describe, expect, it } from "vitest";

import { describeTool, editedSlide, type ToolPart } from "./toolCalls";

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
