// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { askUnsaved, useUnsavedQuestion } from "./confirm";

const question = () => useUnsavedQuestion.getState().question;

beforeEach(() => question()?.answer("cancel"));

describe("askUnsaved", () => {
  it("opens a question naming the file, and resolves to its answer", async () => {
    const asked = askUnsaved("deck.html");
    expect(question()?.name).toBe("deck.html");
    question()!.answer("save");
    expect(await asked).toBe("save");
    expect(question()).toBeNull();
  });

  it("takes the first answer only", async () => {
    const asked = askUnsaved("deck.html");
    const open = question()!;
    open.answer("discard");
    open.answer("save");
    expect(await asked).toBe("discard");
  });

  it("keeps one question open: asked again, the first is cancelled", async () => {
    const first = askUnsaved("a.html");
    const stale = question()!;
    const second = askUnsaved("b.html");
    expect(await first).toBe("cancel");
    expect(question()?.name).toBe("b.html");
    // The first question's buttons are no longer anyone's.
    stale.answer("save");
    expect(question()?.name).toBe("b.html");
    question()!.answer("discard");
    expect(await second).toBe("discard");
  });
});
