import { beforeEach, describe, expect, it } from "vitest";

import {
  COMMAND_SPECS,
  commandForKeys,
  commandSpec,
  commandSpecs,
  ECHO_MS,
  forgetKeys,
  fuzzyMatch,
  helpRows,
  loadRecent,
  menuChoice,
  normalKeys,
  noteKey,
  noteRecent,
  pressedSpec,
  RECENT_MAX,
  searchCommands,
  titleWithKeys,
} from "./commands";

beforeEach(() => {
  localStorage.clear();
  forgetKeys();
});

describe("the command table", () => {
  it("lists every command once, in a menu, named in sentence case", () => {
    const ids = COMMAND_SPECS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of COMMAND_SPECS) {
      // Sentence case: a capital first, the rest of the words small (names like PowerPoint aside).
      expect(spec.title[0], spec.id).toBe(spec.title[0]!.toUpperCase());
      expect(
        spec.title
          .split(" ")
          .slice(1)
          .filter((word) => /^[A-Z][a-z]+$/.test(word)),
        spec.id,
      ).toEqual([]);
    }
    expect(commandSpec("file.openFolder")).toMatchObject({ menu: "File", title: "Open folder…", keys: "mod+shift+o" });
  });

  it("names a command for the system it runs on", () => {
    expect(commandSpecs("macos").find((spec) => spec.id === "deck.reveal")?.title).toBe("Show in Finder");
    expect(commandSpecs("windows").find((spec) => spec.id === "deck.reveal")?.title).toBe("Show in File Explorer");
    expect(commandSpecs("linux").find((spec) => spec.id === "deck.reveal")?.title).toBe("Show in folder");
    expect(commandSpecs("windows").find((spec) => spec.id === "deck.trash")?.title).toBe("Move deck to Recycle Bin…");
  });

  it("gives an ellipsis to the commands that ask for more first", () => {
    for (const id of ["app.settings", "file.openDeck", "deck.settings", "export.pdf", "help.palette", "insert.image"]) {
      expect(commandSpec(id).title, id).toMatch(/…$/);
    }
    for (const id of ["edit.undo", "view.sidebar", "present.current"]) expect(commandSpec(id).title).not.toMatch(/…$/);
  });

  it("throws for a command it does not have", () => {
    expect(() => commandSpec("no.such")).toThrow(/no command/);
  });

  it("writes a command's name with its keys, for a tooltip", () => {
    expect(titleWithKeys("help.palette")).toBe("Command palette… (Ctrl+Shift+P)");
    expect(titleWithKeys("deck.new")).toBe("New deck…");
  });
});

describe("the keys pressed", () => {
  it("are written as a spec whatever order the spec names them in", () => {
    expect(normalKeys("shift+mod+z")).toBe("shift+mod+z");
    expect(normalKeys("mod+shift+z")).toBe("shift+mod+z");
    expect(normalKeys("mod+alt+shift+h")).toBe("alt+shift+mod+h");
    expect(normalKeys("mod++")).toBe("mod+plus");
    expect(pressedSpec({ key: "Z", code: "KeyZ", mod: true, shift: true })).toBe("shift+mod+z");
  });

  it("go by the key's place where Shift or Alt types something else on it", () => {
    expect(pressedSpec({ key: "|", code: "Backslash", mod: true, shift: true })).toBe("shift+mod+\\");
    expect(pressedSpec({ key: "Ó", code: "KeyH", mod: true, shift: true, alt: true })).toBe("alt+shift+mod+h");
    expect(pressedSpec({ key: ">", code: "Period", mod: true, shift: true })).toBe("shift+mod+.");
    expect(pressedSpec({ key: "=", code: "Equal", mod: true, shift: false })).toBe("mod+plus");
    // A slide preview forwards the key alone.
    expect(pressedSpec({ key: "|", mod: true, shift: true })).toBe("shift+mod+\\");
    expect(pressedSpec({ key: "ArrowUp", mod: true, shift: false })).toBe("mod+up");
  });

  it("find the command they are the keys of", () => {
    expect(commandForKeys({ key: "p", code: "KeyP", mod: true, shift: true })).toBe("help.palette");
    expect(commandForKeys({ key: "+", code: "Equal", mod: true, shift: true })).toBeNull();
    expect(commandForKeys({ key: "=", code: "Equal", mod: true, shift: false })).toBe("view.zoomIn");
    expect(commandForKeys({ key: "Enter", code: "Enter", mod: true, shift: false })).toBe("present.current");
    expect(commandForKeys({ key: "q", code: "KeyQ", mod: true, shift: false })).toBeNull();
  });
});

describe("a menu choice", () => {
  const taken = (pressed: boolean) => () => pressed;

  it("is a click when no key of its own came just before", () => {
    expect(menuChoice("mod+1")).toBe("click");
    expect(menuChoice(undefined)).toBe("click");
    noteKey({ key: "2", code: "Digit2", mod: true, shift: false }, taken(true), 1000);
    expect(menuChoice("mod+1", 1100)).toBe("click");
  });

  it("is the echo of the key the page took, and is not run twice", () => {
    noteKey({ key: "1", code: "Digit1", mod: true, shift: false }, taken(true), 1000);
    expect(menuChoice("mod+1", 1050)).toBe("taken");
    // Only once: the next choice of it is a click.
    expect(menuChoice("mod+1", 1060)).toBe("click");
  });

  it("is the echo of a key the page left alone, such as ⌘Z in a text field", () => {
    noteKey({ key: "z", code: "KeyZ", mod: true, shift: false }, taken(false), 1000);
    expect(menuChoice("mod+z", 1010)).toBe("left");
  });

  it("is a click once the key is long past", () => {
    noteKey({ key: "1", code: "Digit1", mod: true, shift: false }, taken(true), 1000);
    expect(menuChoice("mod+1", 1000 + ECHO_MS + 1)).toBe("click");
  });

  it("ignores keys without the command key, which the menu bar never takes", () => {
    noteKey({ key: "g", code: "KeyG", mod: false, shift: false }, taken(true), 1000);
    expect(menuChoice("g", 1010)).toBe("click");
  });
});

describe("searching the commands", () => {
  const items = [
    { id: "view.zoomIn", title: "Zoom in", group: "View" },
    { id: "view.zoomOut", title: "Zoom out", group: "View" },
    { id: "file.close", title: "Close deck", group: "File" },
    { id: "arrange.group", title: "Group", group: "Arrange" },
    { id: "format.bold", title: "Bold", group: "Format" },
  ];
  const ids = (query: string, recent: string[] = []) => searchCommands(items, query, recent).map((f) => f.item.id);

  it("finds letters in order, word starts first", () => {
    expect(ids("zi")).toEqual(["view.zoomIn"]);
    expect(ids("zoom")).toEqual(["view.zoomIn", "view.zoomOut"]);
    expect(ids("cd")).toEqual(["file.close"]);
    expect(ids("xyz")).toEqual([]);
    expect(fuzzyMatch("zo", "Zoom out")?.marks).toEqual([0, 1]);
    expect(fuzzyMatch("zo", "Zoom out")!.score).toBeGreaterThan(fuzzyMatch("zo", "Ozone zone")!.score);
  });

  it("finds by the menu's name too", () => {
    expect(ids("file close")).toEqual(["file.close"]);
    expect(ids("arrange")).toEqual(["arrange.group"]);
    // The letters marked are the title's.
    expect(searchCommands(items, "file close", [])[0]!.marks.every((at) => at < "Close deck".length)).toBe(true);
  });

  it("puts those used last first, with or without a query", () => {
    expect(ids("", ["format.bold", "view.zoomOut"])).toEqual([
      "format.bold",
      "view.zoomOut",
      "view.zoomIn",
      "file.close",
      "arrange.group",
    ]);
    expect(ids("zoom", ["view.zoomOut"])).toEqual(["view.zoomOut", "view.zoomIn"]);
  });
});

describe("the commands used last", () => {
  it("are remembered, the latest first, a few at most", () => {
    expect(loadRecent()).toEqual([]);
    noteRecent("view.sidebar");
    noteRecent("edit.undo");
    noteRecent("view.sidebar");
    expect(loadRecent()).toEqual(["view.sidebar", "edit.undo"]);
    for (const spec of COMMAND_SPECS.slice(0, 10)) noteRecent(spec.id);
    expect(loadRecent()).toHaveLength(RECENT_MAX);
  });

  it("forget commands that no longer exist", () => {
    localStorage.setItem("slopslide.recentCommands", JSON.stringify(["gone.away", "edit.undo", 3]));
    expect(loadRecent()).toEqual(["edit.undo"]);
  });
});

describe("the shortcut help's rows", () => {
  it("are the commands with keys listed under a section, by what they do", () => {
    const rows = helpRows("General");
    expect(rows).toContainEqual(["{mod+shift+p}", "The command palette: find and run any command"]);
    expect(rows).toContainEqual(["{mod+n}", "New window"]);
    // Commands without keys have no row.
    expect(rows.some(([, what]) => what.startsWith("New deck"))).toBe(false);
  });
});
