import { FileText, Globe, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import { describe, expect, it } from "vitest";

import { describeTool, editedSlide, groupParts, stepsLabel, type ToolPart, toolArguments, toolName } from "./toolCalls";

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
    ["TodoWrite", { todos: [] }, Wrench, "Todo write", ""],
    ["mcp__github__create_issue", { title: "x" }, Wrench, "Create issue", ""],
    ["mcp__docs__search", { q: "x" }, Wrench, "Search", ""],
    ["mcp__slopslide__lint_deck", { path: "talk/deck.html" }, Wrench, "Checked the deck's HTML", "talk/deck.html"],
    ["lint_deck", {}, Wrench, "Checked the deck's HTML", ""],
    ["mcp__slopslide__open_file", { path: "talk/notes.md" }, Wrench, "Opened", "talk/notes.md"],
    ["mcp__slopslide__render_slide", { path: "talk/deck.html" }, Wrench, "Looked at the slides", "talk/deck.html"],
    ["mcp__slopslide__set_narration_audio", { slide: "intro" }, Wrench, "Set the narration audio of", "intro"],
    ["mcp__slopslide__narration_timeline", {}, Wrench, "Read the narration timeline", ""],
    ["mcp__slopslide__narration_beats", { slide: "intro" }, Wrench, "Set the narration beats of", "intro"],
    ["mcp__slopslide__generate_narration_audio", {}, Wrench, "Generated narration audio", ""],
    ["mcp__slopslide__export_deck", { format: "pdf" }, Wrench, "Exported the deck as", "pdf"],
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

describe("toolName", () => {
  it("leaves out what agents put before the tool of an MCP server", () => {
    expect(toolName("mcp__slopslide__lint_deck")).toBe("lint_deck");
    expect(toolName("mcp__my_server__do__it")).toBe("do__it");
    expect(toolName("Bash")).toBe("Bash");
  });
});

describe("groupParts", () => {
  const text = (value: string) => ({ kind: "text" as const, text: value });
  const kinds = (parts: Parameters<typeof groupParts>[0]) =>
    groupParts(parts).map((group) => (group.kind === "steps" ? group.tools.map((t) => t.id) : group.part.kind));

  it("puts tool calls in a row into one group of steps", () => {
    const parts = [
      text("First"),
      tool("a", {}),
      tool("b", {}),
      tool("c", {}),
      text("Then"),
      tool("d", {}),
      tool("e", {}),
    ];
    expect(kinds(parts)).toEqual(["text", ["a", "b", "c"], "text", ["d", "e"]]);
  });

  it("leaves a tool call on its own as it is, with its place among the parts", () => {
    const groups = groupParts([text("First"), tool("a", {}), text("Then")]);
    expect(groups.map((g) => g.kind)).toEqual(["part", "part", "part"]);
    expect(groups.map((g) => (g.kind === "part" ? g.index : -1))).toEqual([0, 1, 2]);
  });

  it("does not let blank text part two tool calls, and leaves it out", () => {
    expect(kinds([tool("a", {}), text("  \n"), tool("b", {})])).toEqual([["a", "b"]]);
    expect(kinds([text(" ")])).toEqual([]);
  });

  it("names a group by its steps, and says how many failed", () => {
    const failed: ToolPart = { ...tool("b", {}), status: "error" };
    expect(stepsLabel([tool("a", {}), tool("c", {})])).toBe("2 steps");
    expect(stepsLabel([tool("a", {}), failed, tool("c", {})])).toBe("3 steps · 1 failed");
  });
});
