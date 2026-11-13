// @vitest-environment node
import { describe, expect, it } from "vitest";

import { isHtml, isPowerPoint, openableOf } from "./opening";

describe("openableOf", () => {
  it("opens an HTML file as a deck", () => {
    expect(openableOf(["/talks/q3/deck.html"])).toEqual({ kind: "deck", path: "/talks/q3/deck.html" });
    expect(openableOf(["C:\\talks\\Q3.HTM"])).toEqual({ kind: "deck", path: "C:\\talks\\Q3.HTM" });
  });

  it("imports a PowerPoint file", () => {
    for (const path of ["/d/q3.pptx", "/d/q3.PPTM", "/d/theme.potx"]) {
      expect(openableOf([path])).toEqual({ kind: "powerpoint", path });
    }
  });

  it("takes anything else for a folder, which the backend checks", () => {
    expect(openableOf(["/Users/me/talks"])).toEqual({ kind: "folder", path: "/Users/me/talks" });
    expect(openableOf(["/Users/me/talks v1.2"])).toEqual({ kind: "folder", path: "/Users/me/talks v1.2" });
    expect(openableOf(["/Users/me/notes.txt"])?.kind).toBe("folder");
  });

  it("goes by the first of several paths, and is nothing for none", () => {
    expect(openableOf(["/a/deck.html", "/b"])).toEqual({ kind: "deck", path: "/a/deck.html" });
    expect(openableOf([])).toBeNull();
  });

  it("tells the kinds apart by their endings only", () => {
    expect(isHtml("/a/html")).toBe(false);
    expect(isHtml("/a/deck.html.bak")).toBe(false);
    expect(isPowerPoint("/a/pptx/notes.md")).toBe(false);
  });
});
