import { describe, expect, it } from "vitest";

import type { Slide } from "../../lib/api";
import { actionTargets } from "./SlideActions";

const slide = (id: string, marks: Partial<Slide> = {}): Slide => ({
  id,
  hash: id,
  hidden: false,
  locked: false,
  moved: false,
  ...marks,
});

describe("actionTargets", () => {
  it("is about the slide alone when it is not one of several picked", () => {
    const a = slide("a");
    expect(actionTargets(a, [])).toMatchObject({
      slides: ["a"],
      lock: { title: "Lock slide", on: true },
      hide: { title: "Hide slide", on: true, slides: ["a"] },
      duplicate: "Duplicate",
      remove: { title: "Delete", reason: undefined },
    });
    expect(actionTargets(slide("b"), [a, slide("c")]).slides).toEqual(["b"]);
  });

  it("says why a locked slide is not deleted", () => {
    expect(actionTargets(slide("a", { locked: true }), []).remove.reason).toBe("Locked: unlock to delete");
  });

  it("is about every picked slide when it is one of them, leaving locked ones out of deleting and hiding", () => {
    const picked = [slide("a"), slide("b", { locked: true }), slide("c", { hidden: true })];
    const targets = actionTargets(picked[0]!, picked);
    expect(targets.slides).toEqual(["a", "b", "c"]);
    expect(targets.free).toEqual(["a", "c"]);
    expect(targets.remove.title).toBe("Delete 2 slides (not the 1 locked)");
    expect(targets.hide).toEqual({ title: "Hide 2 slides (not the 1 locked)", on: true, slides: ["a", "c"] });
    expect(targets.lock).toEqual({ title: "Lock 3 slides", on: true });
    expect(targets.duplicate).toBe("Duplicate 3 slides");
  });

  it("offers no deleting when every picked slide is locked", () => {
    const picked = [slide("a", { locked: true }), slide("b", { locked: true })];
    const targets = actionTargets(picked[1]!, picked);
    expect(targets.remove.reason).toBe("Locked: unlock them to delete");
    expect(targets.lock).toEqual({ title: "Unlock 2 slides", on: false });
  });
});
