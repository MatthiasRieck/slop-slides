// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import {
  askUnsaved,
  confirmAction,
  confirmDiscard,
  confirmStopAgent,
  useConfirmQuestion,
  useUnsavedQuestion,
} from "./confirm";

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

describe("confirmAction", () => {
  const open = () => useConfirmQuestion.getState().question;
  const waiting = () => useConfirmQuestion.getState().waiting;
  const DELETE = { title: "Delete your recording?", message: "It cannot be brought back.", confirmLabel: "Delete" };

  it("opens a question in the app with its words, and resolves to the answer", async () => {
    const asked = confirmAction({ ...DELETE, destructive: true });
    expect(open()).toMatchObject({ ...DELETE, destructive: true });
    open()!.answer(true);
    expect(await asked).toBe(true);
    expect(open()).toBeNull();
    const again = confirmAction(DELETE);
    open()!.answer(false);
    expect(await again).toBe(false);
  });

  it("takes the first answer only", async () => {
    const asked = confirmAction(DELETE);
    const question = open()!;
    question.answer(false);
    question.answer(true);
    expect(await asked).toBe(false);
  });

  it("asks one at a time, the others waiting their turn in the order asked", async () => {
    const first = confirmAction({ ...DELETE, title: "First?" });
    const second = confirmAction({ ...DELETE, title: "Second?" });
    const third = confirmAction({ ...DELETE, title: "Third?" });
    expect(open()?.title).toBe("First?");
    expect(waiting().map((question) => question.title)).toEqual(["Second?", "Third?"]);
    // One that waits cannot be answered before it shows.
    waiting()[0]!.answer(true);
    expect(open()?.title).toBe("First?");
    open()!.answer(true);
    expect(await first).toBe(true);
    expect(open()?.title).toBe("Second?");
    open()!.answer(false);
    expect(await second).toBe(false);
    open()!.answer(true);
    expect(await third).toBe(true);
    expect(open()).toBeNull();
    expect(waiting()).toEqual([]);
  });

  it("asks about unsaved changes and about the working agent in the same dialog, as what discards", async () => {
    const discard = confirmDiscard("The drawing has changes. Discard them?");
    expect(open()).toMatchObject({
      title: "Unsaved changes",
      message: "The drawing has changes. Discard them?",
      confirmLabel: "Discard",
      destructive: true,
    });
    open()!.answer(true);
    expect(await discard).toBe(true);
    const stop = confirmStopAgent("The agent is still working. Stop it to go on?");
    expect(open()).toMatchObject({
      title: "The agent is still working",
      confirmLabel: "Stop the agent",
      cancelLabel: "Cancel",
      destructive: true,
    });
    open()!.answer(false);
    expect(await stop).toBe(false);
  });
});
