import { describe, expect, it } from "vitest";

import { nextDocument, type StageDocument, type StageWants } from "./stageDocument";

const VIEW: StageWants = {
  slide: "a",
  around: "shell.0.0.false",
  replay: 0,
  version: "v1",
  edit: false,
  still: false,
  own: false,
};
const EDIT: StageWants = { ...VIEW, edit: true, still: true };

/** The page the stage holds after wanting each of `wants` in turn, and how many pages it loaded on the way. */
function follow(...wants: StageWants[]) {
  let doc: StageDocument | null = null;
  let loads = 0;
  for (const want of wants) {
    const next = nextDocument(doc, want);
    if (
      !doc ||
      next.loaded !== doc.loaded ||
      next.around !== doc.around ||
      next.slide !== doc.slide ||
      next.loadedEdit !== doc.loadedEdit ||
      next.loadedStill !== doc.loadedStill ||
      next.replay !== doc.replay
    )
      loads++;
    doc = next;
  }
  return { doc: doc!, loads };
}

describe("the stage's page", () => {
  it("is the same page in View and in Edit, the editor and the still coming and going on it", () => {
    const { doc, loads } = follow(VIEW, EDIT, VIEW, EDIT, VIEW);
    expect(loads).toBe(1);
    expect(doc).toMatchObject({ loadedEdit: false, loadedStill: false, edit: false, still: false });
    expect(follow(VIEW, EDIT).doc).toMatchObject({ loadedEdit: false, edit: true, still: true });
    // Loaded in Edit, it stays a still in View only when View wants one.
    expect(follow(EDIT, VIEW).doc).toMatchObject({ loadedEdit: true, loadedStill: true, edit: false, still: false });
  });

  it("is the same object while nothing changes", () => {
    const doc = nextDocument(null, EDIT);
    expect(nextDocument(doc, EDIT)).toBe(doc);
  });

  it("keeps a version the editor saved, and leaves any other for the editor to patch in, in Edit", () => {
    const saved = follow(EDIT, { ...EDIT, version: "v2", own: true });
    expect(saved.loads).toBe(1);
    expect(saved.doc).toMatchObject({ loaded: "v1", shows: "v2" });
    // An undo: still the page that loaded, now to be patched to show v3.
    const undone = follow(EDIT, { ...EDIT, version: "v2", own: true }, { ...EDIT, version: "v3" });
    expect(undone.loads).toBe(1);
    expect(undone.doc).toMatchObject({ loaded: "v1", shows: "v2" });
    // Leaving Edit with the page showing the slide as it is loads nothing.
    expect(follow(EDIT, { ...EDIT, version: "v2", own: true }, { ...VIEW, version: "v2" }).loads).toBe(1);
  });

  it("loads again for what only a load shows: another slide, new styles or assets, a reload asked for, a new version in View", () => {
    for (const change of [
      { slide: "b" },
      { around: "restyled.0.0.false" },
      { around: "shell.1.0.false" },
      { around: "shell.0.1.false" },
    ]) {
      expect(follow(EDIT, { ...EDIT, ...change }).loads, JSON.stringify(change)).toBe(2);
    }
    expect(follow(VIEW, { ...VIEW, version: "v2" }).loads).toBe(2);
    // Leaving Edit with a patch not made yet.
    expect(follow(EDIT, { ...EDIT, version: "v2" }, { ...VIEW, version: "v2" }).loads).toBe(2);
  });

  it("loads again in View to play the slide again, or to show it still or not, but not in Edit", () => {
    expect(follow(VIEW, { ...VIEW, replay: 1 }).loads).toBe(2);
    expect(follow(VIEW, { ...VIEW, still: true }).loads).toBe(2);
    expect(follow(EDIT, { ...EDIT, replay: 1 }).loads).toBe(1);
    // A page that had the editor and lost it to View, showing it still as View wants: nothing to load.
    expect(follow(VIEW, EDIT, VIEW).loads).toBe(1);
    expect(follow({ ...VIEW, still: true }, EDIT, { ...VIEW, still: true }).loads).toBe(1);
  });
});
