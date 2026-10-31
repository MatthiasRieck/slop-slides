import { describe, expect, it } from "vitest";

import type { Deck } from "./api";
import {
  applyOrder,
  dropRows,
  dropSection,
  railItems,
  sectionBlocks,
  sectionKey,
  startsSection,
  stepRows,
} from "./sections";

const deck = (sections: [string, number][], ids = ["a", "b", "c"]): Deck => ({
  id: "talk",
  title: "Talk",
  path: "/decks/talk",
  slides: ids.map((id) => ({ id, hash: id, hidden: false, locked: false, moved: false })),
  sections: sections.map(([title, before], index) => ({ index, title, before })),
  shellHash: "s",
});

const keys = (d: Deck) => railItems(d).map((item) => item.key);

describe("railItems", () => {
  it("is just the slides when there are no sections", () => {
    const items = railItems(deck([]));
    expect(items.map((i) => i.kind)).toEqual(["slide", "slide", "slide"]);
    expect(items.map((i) => (i.kind === "slide" ? i.index : -1))).toEqual([0, 1, 2]);
  });

  it("puts each section before the slide it starts", () => {
    expect(
      keys(
        deck([
          ["One", 0],
          ["Two", 2],
        ]),
      ),
    ).toEqual(["section:0", "a", "b", "section:1", "c"]);
  });

  it("keeps a trailing section after the last slide", () => {
    expect(keys(deck([["End", 3]]))).toEqual(["a", "b", "c", "section:0"]);
  });

  it("keeps consecutive sections in document order", () => {
    expect(
      keys(
        deck([
          ["One", 1],
          ["Two", 1],
        ]),
      ),
    ).toEqual(["a", "section:0", "section:1", "b", "c"]);
  });

  it("lists sections without slides", () => {
    expect(keys(deck([["Only", 0]], []))).toEqual(["section:0"]);
  });
});

describe("applyOrder", () => {
  it("moves a slide across a section boundary", () => {
    const d = deck([["Two", 1]]);
    const next = applyOrder(d, ["a", "b", "section:0", "c"]);
    expect(next.slides.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(next.sections).toEqual([{ index: 0, title: "Two", before: 2 }]);
  });

  it("moves a section marker with its title and renumbers sections", () => {
    const d = deck([
      ["One", 0],
      ["Two", 2],
    ]);
    const next = applyOrder(d, ["a", "section:1", "b", "c", "section:0"]);
    expect(next.sections).toEqual([
      { index: 0, title: "Two", before: 1 },
      { index: 1, title: "One", before: 3 },
    ]);
    expect(keys(next)).toEqual(["a", "section:0", "b", "c", "section:1"]);
  });

  it("keeps everything else on the deck and ignores unknown keys", () => {
    const d = deck([["One", 0]]);
    const next = applyOrder(d, ["b", "nope", "section:0", "a", "c"]);
    expect(next).toMatchObject({ id: "talk", shellHash: "s" });
    expect(next.slides.map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(next.sections).toEqual([{ index: 0, title: "One", before: 1 }]);
  });
});

describe("startsSection / sectionKey", () => {
  it("knows which slides start a section", () => {
    const d = deck([
      ["One", 0],
      ["Two", 2],
    ]);
    expect([0, 1, 2].map((i) => startsSection(d, i))).toEqual([true, false, true]);
  });

  it("formats keys like the backend", () => {
    expect(sectionKey(3)).toBe("section:3");
  });
});

describe("stepRows", () => {
  const rows = ["a", "section:0", "b", "c", "d"];

  it("steps a slide past a section marker, into the next section", () => {
    expect(stepRows(rows, ["b"], -1)).toEqual(["a", "b", "section:0", "c", "d"]);
    expect(stepRows(rows, ["a"], 1)).toEqual(["section:0", "a", "b", "c", "d"]);
  });

  it("keeps slides picked together in order, and those with a gap apart", () => {
    expect(stepRows(rows, ["b", "c"], 1)).toEqual(["a", "section:0", "d", "b", "c"]);
    expect(stepRows(rows, ["c", "d"], -1)).toEqual(["a", "section:0", "c", "d", "b"]);
    expect(stepRows(rows, ["a", "c"], -1)).toEqual(["a", "section:0", "c", "b", "d"]);
  });

  it("leaves rows already at the end", () => {
    expect(stepRows(rows, ["a"], -1)).toEqual(rows);
    expect(stepRows(rows, ["c", "d"], 1)).toEqual(rows);
  });
});

describe("dropRows", () => {
  const rows = ["a", "b", "c", "d"];

  it("moves one row like a drag does, past the row dropped on", () => {
    expect(dropRows(rows, ["a"], "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(dropRows(rows, ["d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
  });

  it("takes picked rows along as a block, in deck order", () => {
    expect(dropRows(rows, ["a", "c"], "c", "d")).toEqual(["b", "d", "a", "c"]);
    expect(dropRows(rows, ["b", "d"], "d", "a")).toEqual(["b", "d", "a", "c"]);
  });

  it("does nothing when dropped on a row of the block", () => {
    expect(dropRows(rows, ["a", "c"], "a", "c")).toEqual(rows);
  });
});

describe("sectionBlocks", () => {
  const blocks = (d: Deck) => sectionBlocks(railItems(d));

  it("gives each section its marker and slides, leaving out the slides before the first", () => {
    expect(
      blocks(
        deck([
          ["One", 1],
          ["Two", 2],
        ]),
      ),
    ).toEqual([
      { key: "section:0", rows: ["section:0", "b"] },
      { key: "section:1", rows: ["section:1", "c"] },
    ]);
  });

  it("keeps an empty section as a block of its own", () => {
    expect(
      blocks(
        deck([
          ["One", 0],
          ["Two", 0],
          ["End", 3],
        ]),
      ),
    ).toEqual([
      { key: "section:0", rows: ["section:0"] },
      { key: "section:1", rows: ["section:1", "a", "b", "c"] },
      { key: "section:2", rows: ["section:2"] },
    ]);
  });

  it("is empty without sections", () => {
    expect(blocks(deck([]))).toEqual([]);
  });
});

describe("dropSection", () => {
  const sectioned = deck(
    [
      ["One", 1],
      ["Two", 3],
      ["Three", 4],
    ],
    ["a", "b", "c", "d", "e"],
  );
  const items = railItems(sectioned);

  it("moves a section up with its slides, past the other sections", () => {
    expect(dropSection(items, "section:2", "section:0")).toEqual([
      "a",
      "section:2",
      "e",
      "section:0",
      "b",
      "c",
      "section:1",
      "d",
    ]);
  });

  it("moves a section down below the one it lands on", () => {
    expect(dropSection(items, "section:0", "section:1")).toEqual([
      "a",
      "section:1",
      "d",
      "section:0",
      "b",
      "c",
      "section:2",
      "e",
    ]);
  });

  it("changes nothing when dropped on itself", () => {
    expect(dropSection(items, "section:1", "section:1")).toEqual(keys(sectioned));
  });

  it("gives the deck its new order, slides staying in their sections", () => {
    const next = applyOrder(sectioned, dropSection(items, "section:2", "section:0"));
    expect(next.slides.map((s) => s.id)).toEqual(["a", "e", "b", "c", "d"]);
    expect(next.sections.map((s) => [s.title, s.before])).toEqual([
      ["Three", 1],
      ["One", 2],
      ["Two", 4],
    ]);
  });
});
