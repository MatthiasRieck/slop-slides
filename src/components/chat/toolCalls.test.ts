import { Eye, FileText, Globe, Pencil, Search, SquareTerminal, Wrench } from "lucide-react";
import { describe, expect, it } from "vitest";

import { slideNumbers } from "../../lib/slideNumbers";
import {
  describeTool,
  editedIds,
  editedSlide,
  groupParts,
  partKey,
  stepFacts,
  stepsLabel,
  type ToolPart,
  textEdits,
  toolArguments,
  toolName,
} from "./toolCalls";

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
    ["mcp__slopslide__render_slide", { path: "talk/deck.html" }, Eye, "Looked at the slides", "talk/deck.html"],
    ["mcp__slopslide__set_narration_audio", { slide: "intro" }, Wrench, "Set the narration audio of", "intro"],
    ["mcp__slopslide__narration_timeline", {}, Wrench, "Read the narration timeline", ""],
    ["mcp__slopslide__narration_beats", { slide: "intro" }, Wrench, "Set the narration beats of", "intro"],
    ["mcp__slopslide__generate_narration_audio", {}, Wrench, "Generated narration audio", ""],
    ["mcp__slopslide__export_deck", { format: "pdf" }, Wrench, "Exported the deck as", "pdf"],
    ["Write", { file_path: 42 }, FileText, "Wrote", ""],
  ])("describes %s calls", (name, input, icon, label, target) => {
    expect(describeTool(tool(name, input), DECK)).toMatchObject({ icon, label, target });
  });

  it.each([
    ["Edit", { file_path: "/decks/talk/deck.html" }, "Editing deck.html…", "edit"],
    ["Write", {}, "Writing a file…", "edit"],
    ["Read", { file_path: "/decks/talk/assets/notes.md" }, "Reading notes.md…", "read"],
    ["Grep", { pattern: "x" }, "Searching the files…", "search"],
    ["WebFetch", { url: "https://a.b" }, "Reading a web page…", "web"],
    ["Bash", { command: "ls" }, "Running a command…", "command"],
    ["mcp__slopslide__render_slide", {}, "Looking at the slides…", "look"],
    ["mcp__x__fetch_page", {}, "Fetch page…", "other"],
  ])("says what a running %s call is doing", (name, input, doing, kind) => {
    expect(describeTool(tool(name, input), DECK)).toMatchObject({ doing, kind });
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
  const slides = slideNumbers([{ id: "intro" }, { id: "outro" }]);
  /** The slide `edit` of the file `target` touched. */
  const touched = (edit: ToolPart, target = "deck.html") => editedSlide(editedIds(edit, target, DECK), slides);

  it("finds the slide an edit of the deck file touched, in the new text or else the old", () => {
    const edit = tool("Edit", { old_string: `<section id="intro">`, new_string: `<section class="slide" id='outro'>` });
    expect(touched(edit)).toBe("outro");
    expect(touched(tool("Edit", { old_string: `<section id="intro">` }))).toBe("intro");
  });

  it("finds nothing for unknown ids or other files", () => {
    expect(touched(tool("Edit", { new_string: `<div id="not-a-slide">` }))).toBeNull();
    expect(touched(tool("Edit", { new_string: `<section id="intro">` }), "notes.html")).toBeNull();
  });

  it("reads the ids of an edit in the order to look for a slide among them, new text first", () => {
    const edit = tool("Edit", { old_string: `<section id="intro">`, new_string: `<b id="x"><i id='outro'>` });
    expect(editedIds(edit, "deck.html", DECK)).toEqual(["x", "outro", "intro"]);
  });

  it("reads nothing of an edit of another file, or of a call that edits no text", () => {
    const other = editedIds(tool("Edit", { new_string: `<section id="intro">` }), "notes.html", DECK);
    expect(other).toEqual([]);
    // The same empty list each time: a row that asks about it has nothing new to render.
    expect(editedIds(tool("Read", { file_path: DECK }), "deck.html", DECK)).toBe(other);
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
    groupParts(parts).map((group) => (group.kind === "steps" ? group.steps.map((t) => partKey(t)) : group.part.kind));

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

  const keys = (parts: Parameters<typeof groupParts>[0], streaming?: boolean) =>
    groupParts(parts, streaming).map((group) =>
      group.kind === "part" ? group.key : group.steps.map((t) => partKey(t)),
    );

  it("leaves a tool call on its own as it is, each part with a key of its own", () => {
    const groups = groupParts([text("First"), tool("a", {}), text("Then")]);
    expect(groups.map((g) => g.kind)).toEqual(["part", "part", "part"]);
    expect(keys([text("First"), tool("a", {}), text("Then")])).toEqual(["text-0", "a", "text-1"]);
  });

  it("folds the steps done while the reply comes in, the newest step shown by itself after them", () => {
    expect(keys([text("First"), tool("a", {}), tool("b", {}), tool("c", {})], true)).toEqual([
      "text-0",
      ["a", "b"],
      "c",
    ]);
    // Two steps fold only once a third comes; one alone is a row.
    expect(keys([tool("a", {}), tool("b", {})], true)).toEqual(["a", "b"]);
    expect(keys([tool("a", {})], true)).toEqual(["a"]);
    // A run before text is done: it folds whole.
    expect(keys([tool("a", {}), tool("b", {}), text("Then")], true)).toEqual([["a", "b"], "text-0"]);
  });

  it("keeps an answered request among the steps, and a waiting one by itself", () => {
    const answered = { kind: "approval" as const, status: "resolved" as const, approval: { id: "ap1" } as never };
    const waiting = { ...answered, status: "pending" as const, approval: { id: "ap2" } as never };
    expect(kinds([tool("a", {}), answered, tool("b", {})])).toEqual([["a", "ap1", "b"]]);
    expect(kinds([tool("a", {}), waiting, tool("b", {})])).toEqual(["tool", "approval", "tool"]);
  });

  it("keeps the key of a text when a blank text before it goes, as it does when the agent calls a tool", () => {
    const before = [text("First"), text(" "), tool("a", {}), text("Then")];
    const after = before.filter((part) => part.kind !== "text" || part.text.trim() !== "");
    expect(keys(before, true)).toEqual(["text-0", "a", "text-1"]);
    expect(keys(after, true)).toEqual(keys(before, true));
  });

  it("names approvals and reviews by their ids", () => {
    const approval = { kind: "approval" as const, status: "pending" as const, approval: { id: "ap1" } as never };
    const review = { kind: "approvalReview" as const, id: "rv1", status: "approved", detail: null };
    expect(keys([approval, review])).toEqual(["ap1", "rv1"]);
  });

  it("does not let blank text part two tool calls, and leaves it out", () => {
    expect(kinds([tool("a", {}), text("  \n"), tool("b", {})])).toEqual([["a", "b"]]);
    expect(kinds([text(" ")])).toEqual([]);
  });
});

describe("stepsLabel", () => {
  const slides = slideNumbers([{ id: "intro" }, { id: "market" }, { id: "team" }]);
  const label = (steps: ToolPart[]) => stepsLabel(stepFacts(steps, DECK), slides);
  const editSlide = (id: string) => tool("Edit", { file_path: DECK, new_string: `<section id="${id}">` });

  it("sums the steps up by kind, in the order the kinds came", () => {
    expect(
      label([
        tool("Read", { file_path: "/decks/talk/a.md" }),
        editSlide("intro"),
        editSlide("market"),
        editSlide("intro"),
        tool("Read", { file_path: "/decks/talk/b.md" }),
        tool("Read", { file_path: "/decks/talk/a.md" }),
      ]),
    ).toBe("Read 2 files, edited 2 slides");
  });

  it("counts edits of the deck that name no slide as the deck, and of other files as files", () => {
    expect(label([tool("Edit", { file_path: DECK, new_string: ".title { color: red }" })])).toBe("Edited the deck");
    expect(label([editSlide("intro"), tool("Edit", { file_path: DECK, new_string: "x" })])).toBe("Edited 1 slide");
    expect(
      label([tool("Write", { file_path: "/decks/talk/notes.md" }), tool("Edit", { file_path: "/decks/talk/x.css" })]),
    ).toBe("Edited 2 files");
  });

  it("names three kinds and counts the rest, and says how many failed", () => {
    const failed: ToolPart = { ...tool("Bash", { command: "false" }), status: "error" };
    expect(
      label([
        editSlide("team"),
        tool("Bash", { command: "ls" }),
        failed,
        tool("Grep", { pattern: "x" }),
        tool("WebSearch", { query: "x" }),
        tool("TodoWrite", {}),
      ]),
    ).toBe("Edited 1 slide, ran 2 commands, searched the files, 2 more · 1 failed");
    expect(label([tool("mcp__slopslide__render_slide", {})])).toBe("Looked at the slides");
  });
});

describe("textEdits", () => {
  it("gives an edit's replacements, a write's new text, and nothing for other tools", () => {
    expect(textEdits(tool("Edit", { old_string: "a", new_string: "b" }))).toEqual([{ before: "a", after: "b" }]);
    expect(
      textEdits(
        tool("MultiEdit", {
          edits: [
            { old_string: "a", new_string: "b" },
            { old_string: "c", new_string: "" },
          ],
        }),
      ),
    ).toEqual([
      { before: "a", after: "b" },
      { before: "c", after: "" },
    ]);
    expect(textEdits(tool("Write", { content: "new" }))).toEqual([{ before: "", after: "new" }]);
    expect(textEdits(tool("MultiEdit", { edits: [{ old_string: "a" }] }))).toBeNull();
    expect(textEdits(tool("Edit", { old_string: 3 }))).toBeNull();
    expect(textEdits(tool("Read", { file_path: "x" }))).toBeNull();
  });

  it("finds the slide of each edit of a MultiEdit", () => {
    const multi = tool("MultiEdit", { file_path: DECK, edits: [{ old_string: "x", new_string: `<p id="team">` }] });
    expect(editedIds(multi, "deck.html", DECK)).toEqual(["team"]);
  });
});
