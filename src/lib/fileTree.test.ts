// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "./api";
import { absolutePath, ancestorsOf, foldersToReload, parentOf, toggleFolder, treeMove, visibleRows } from "./fileTree";

const dir = (path: string): WorkspaceEntry => ({ name: path.split("/").pop()!, path, kind: "directory" });
const file = (path: string, kind: WorkspaceEntry["kind"] = "file"): WorkspaceEntry => ({
  name: path.split("/").pop()!,
  path,
  kind,
});

describe("file tree paths", () => {
  it("finds the folder holding a path and the folders above it", () => {
    expect(parentOf("deck.html")).toBe("");
    expect(parentOf("talks/q3/deck.html")).toBe("talks/q3");
    expect(ancestorsOf("deck.html")).toEqual([]);
    expect(ancestorsOf("talks/q3/deck.html")).toEqual(["talks", "talks/q3"]);
  });
});

describe("visibleRows", () => {
  const folders = new Map([
    ["", [dir("talks"), dir("notes"), file("index.html", "webpage")]],
    ["talks", [dir("talks/q3"), file("talks/intro.html", "deck")]],
    ["talks/q3", [file("talks/q3/deck.html", "deck")]],
  ]);

  it("shows the root and the expanded folders, nested", () => {
    const rows = visibleRows(folders, new Set(["talks", "talks/q3"]));
    expect(rows.map((r) => [r.entry.path, r.depth])).toEqual([
      ["talks", 0],
      ["talks/q3", 1],
      ["talks/q3/deck.html", 2],
      ["talks/intro.html", 1],
      ["notes", 0],
      ["index.html", 0],
    ]);
  });

  it("hides folders under a collapsed one, and expanded folders not loaded yet are empty", () => {
    expect(visibleRows(folders, new Set(["talks/q3"])).map((r) => r.entry.path)).toEqual([
      "talks",
      "notes",
      "index.html",
    ]);
    expect(visibleRows(folders, new Set(["notes"])).map((r) => r.entry.path)).toEqual(["talks", "notes", "index.html"]);
    expect(visibleRows(new Map(), new Set())).toEqual([]);
  });
});

describe("foldersToReload", () => {
  it("reloads the loaded folders holding changed paths, and changed folders themselves", () => {
    const loaded = ["", "talks", "talks/q3"];
    expect(foldersToReload(["talks/q3/deck.html", "talks/q3/assets/a.png"], loaded)).toEqual(["talks/q3"]);
    expect(foldersToReload(["new.html"], loaded)).toEqual([""]);
    expect(foldersToReload(["talks/q3"], loaded)).toEqual(["talks", "talks/q3"]);
    expect(foldersToReload(["elsewhere/x/y.png"], loaded)).toEqual([]);
  });
});

describe("toggleFolder", () => {
  it("expands a folder, and collapses it along with the folders inside", () => {
    const open = toggleFolder(new Set(["notes"]), "talks");
    expect([...open].sort()).toEqual(["notes", "talks"]);
    const closed = toggleFolder(new Set(["talks", "talks/q3", "talks-old", "notes"]), "talks");
    expect([...closed].sort()).toEqual(["notes", "talks-old"]);
  });
});

describe("treeMove", () => {
  const folders = new Map([
    ["", [dir("talks"), dir("empty"), file("index.html", "webpage")]],
    ["talks", [dir("talks/q3"), file("talks/intro.html", "deck")]],
    ["empty", []],
  ]);
  const expanded = new Set(["talks", "empty"]);
  const rows = visibleRows(folders, expanded);
  const move = (current: string, key: string) => treeMove(rows, expanded, current, key);

  it("goes to the row before and after, and to the ends", () => {
    expect(move("talks", "ArrowDown")).toEqual({ focus: "talks/q3" });
    expect(move("talks/q3", "ArrowUp")).toEqual({ focus: "talks" });
    expect(move("talks/intro.html", "Home")).toEqual({ focus: "talks" });
    expect(move("talks", "End")).toEqual({ focus: "index.html" });
  });

  it("stays at the ends of the tree", () => {
    expect(move("talks", "ArrowUp")).toBeNull();
    expect(move("talks", "Home")).toBeNull();
    expect(move("index.html", "ArrowDown")).toBeNull();
    expect(move("index.html", "End")).toBeNull();
  });

  it("opens a closed folder with →, and goes into an open one that has entries", () => {
    expect(move("talks/q3", "ArrowRight")).toEqual({ toggle: "talks/q3" });
    expect(move("talks", "ArrowRight")).toEqual({ focus: "talks/q3" });
    // An open folder with nothing in it (or nothing loaded yet) has nowhere to go.
    expect(move("empty", "ArrowRight")).toBeNull();
    expect(move("index.html", "ArrowRight")).toBeNull();
  });

  it("closes an open folder with ←, and goes to the folder above from anything else", () => {
    expect(move("talks", "ArrowLeft")).toEqual({ toggle: "talks" });
    expect(move("talks/intro.html", "ArrowLeft")).toEqual({ focus: "talks" });
    expect(move("talks/q3", "ArrowLeft")).toEqual({ focus: "talks" });
    // At the root there is no folder above.
    expect(move("index.html", "ArrowLeft")).toBeNull();
  });

  it("moves nothing for other keys, or from a row that is gone", () => {
    expect(move("talks", "Enter")).toBeNull();
    expect(move("talks", "a")).toBeNull();
    expect(move("gone.html", "ArrowDown")).toBeNull();
  });
});

describe("absolutePath", () => {
  it("joins the workspace folder and a path in it the way the folder is written", () => {
    expect(absolutePath("/ws", "talks/q3/deck.html")).toBe("/ws/talks/q3/deck.html");
    expect(absolutePath("/ws/", "notes.md")).toBe("/ws/notes.md");
    expect(absolutePath("C:\\Users\\me\\decks", "talks/q3.html")).toBe("C:\\Users\\me\\decks\\talks\\q3.html");
    expect(absolutePath("/ws", "")).toBe("/ws");
  });
});
