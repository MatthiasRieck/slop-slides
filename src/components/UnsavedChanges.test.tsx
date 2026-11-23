import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { askUnsaved, type UnsavedAnswer, useUnsavedQuestion } from "../store/confirm";
import { settle } from "../test/ui";
import { UnsavedChanges } from "./UnsavedChanges";

beforeEach(() => useUnsavedQuestion.getState().question?.answer("cancel"));

/** Asks about `deck.html` with the dialog mounted. */
function ask() {
  render(<UnsavedChanges />);
  let asked!: Promise<UnsavedAnswer>;
  act(() => {
    asked = askUnsaved("deck.html");
  });
  return asked;
}
// A question with fixed answers: an alert dialog, named by what it asks.
const dialog = () => screen.queryByRole("alertdialog", { name: "Save the changes to deck.html?" });

describe("UnsavedChanges", () => {
  it("shows nothing until something asks", () => {
    render(<UnsavedChanges />);
    expect(dialog()).toBeNull();
  });

  it("asks whether to save the changes to the file, Save first", async () => {
    void ask();
    expect(dialog()!.textContent).toContain("Without saving, they are lost.");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Don’t save", "Save"]);
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("is a question: a press beside it leaves it open, and unanswered", async () => {
    const asked = ask();
    const answer = vi.fn();
    void asked.then(answer);
    const beside = document.querySelector("[data-slot=alert-dialog-overlay]")!;
    fireEvent.pointerDown(beside, { pointerType: "mouse", button: 0 });
    fireEvent.click(beside);
    await settle();
    expect(dialog()).not.toBeNull();
    expect(answer).not.toHaveBeenCalled();
  });

  it("keeps the app's keys to itself while it asks", () => {
    void ask();
    const app = vi.fn();
    window.addEventListener("keydown", app);
    fireEvent.keyDown(screen.getByRole("button", { name: "Save" }), { key: "z", metaKey: true });
    expect(app).not.toHaveBeenCalled();
    window.removeEventListener("keydown", app);
  });

  it.each([
    ["Save", "save"],
    ["Don’t save", "discard"],
    ["Cancel", "cancel"],
  ])("answers %s and goes away", async (name, answer) => {
    const asked = ask();
    fireEvent.click(screen.getByRole("button", { name }));
    expect(await asked).toBe(answer);
    expect(dialog()).toBeNull();
  });

  it("takes Escape for staying", async () => {
    const asked = ask();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(await asked).toBe("cancel");
    expect(dialog()).toBeNull();
  });
});
