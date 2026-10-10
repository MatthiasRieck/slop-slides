import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "./api";
import { ancestorsOf, foldersToReload, parentOf, toggleFolder, visibleRows } from "./fileTree";

const dir = (path: string): WorkspaceEntry => ({ name: path.split("/").pop()!, path, kind: "directory" });
const file = (path: string, kind: WorkspaceEntry["kind"] = "file"): WorkspaceEntry => ({ name: path.split("/").pop()!, path, kind });

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
    expect(visibleRows(folders, new Set(["talks/q3"])).map((r) => r.entry.path)).toEqual(["talks", "notes", "index.html"]);
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
