// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Deck } from "./api";
import { keepEqual, shareDeck } from "./share";

describe("keepEqual", () => {
  it("is what was there before when nothing differs, however deep", () => {
    const before = { a: 1, list: [{ x: 1 }, { x: 2 }], nested: { on: true, none: null } };
    expect(keepEqual(before, structuredClone(before))).toBe(before);
  });

  it("keeps the parts that did not change and takes the ones that did", () => {
    const before = { list: [{ x: 1 }, { x: 2 }], other: { y: 1 } };
    const next = keepEqual(before, { list: [{ x: 1 }, { x: 3 }], other: { y: 1 } });
    expect(next).toEqual({ list: [{ x: 1 }, { x: 3 }], other: { y: 1 } });
    expect(next).not.toBe(before);
    expect(next.list[0]).toBe(before.list[0]);
    expect(next.list[1]).not.toBe(before.list[1]);
    expect(next.other).toBe(before.other);
  });

  it("tells a list that grew or shrank, and an object that gained or lost a key", () => {
    const list = [1, 2];
    expect(keepEqual(list, [1, 2, 3])).toEqual([1, 2, 3]);
    expect(keepEqual(list, [1])).toEqual([1]);
    const object = { a: 1, b: 2 };
    expect(keepEqual(object, { a: 1 })).toEqual({ a: 1 });
    expect(keepEqual({ a: 1 }, object)).toEqual(object);
    expect(keepEqual({ a: 1, b: undefined }, { a: 1, c: undefined })).not.toHaveProperty("b");
  });

  it("does not take a list for an object, or the other way round", () => {
    expect(keepEqual({}, [])).toEqual([]);
    expect(keepEqual([], {})).toEqual({});
    expect(keepEqual(null, { a: 1 })).toEqual({ a: 1 });
  });
});

describe("shareDeck", () => {
  const slide = (id: string, hash = id) => ({ id, hash, hidden: false, locked: false, moved: false });
  const deck = (slides = ["a", "b", "c", "d"].map((id) => slide(id)), more: Partial<Deck> = {}): Deck => ({
    id: "/decks/talk/deck.html",
    title: "Talk",
    path: "/decks/talk/deck.html",
    slides,
    sections: [{ index: 0, title: "One", before: 1 }],
    shellHash: "s",
    comments: { a: [] },
    ...more,
  });

  it("is the deck before when the backend sends it again unchanged", () => {
    const before = deck();
    expect(shareDeck(before, deck())).toBe(before);
  });

  it("keeps every slide but the changed one, and the sections", () => {
    const before = deck();
    const next = shareDeck(before, deck([slide("a"), slide("b", "b2"), slide("c"), slide("d")]));
    expect(next).not.toBe(before);
    expect(next.slides).not.toBe(before.slides);
    expect(next.slides.map((s, i) => s === before.slides[i])).toEqual([true, false, true, true]);
    expect(next.slides[1]!.hash).toBe("b2");
    expect(next.sections).toBe(before.sections);
    expect(next.comments).toBe(before.comments);
  });

  it("keeps the list of slides when only something else changed", () => {
    const before = deck();
    const next = shareDeck(before, deck(undefined, { shellHash: "s2" }));
    expect(next.shellHash).toBe("s2");
    expect(next.slides).toBe(before.slides);
  });

  it("knows a slide by its id wherever it stands now", () => {
    const before = deck();
    const next = shareDeck(before, deck([slide("d"), slide("a"), slide("c")]));
    expect(next.slides).toEqual([slide("d"), slide("a"), slide("c")]);
    expect(next.slides[0]).toBe(before.slides[3]);
    expect(next.slides[1]).toBe(before.slides[0]);
    expect(next.slides[2]).toBe(before.slides[2]);
  });

  it("shares nothing with another deck, or with none", () => {
    const next = deck();
    expect(shareDeck(null, next)).toBe(next);
    expect(shareDeck({ ...deck(), id: "/other/deck.html" }, next)).toBe(next);
  });
});
