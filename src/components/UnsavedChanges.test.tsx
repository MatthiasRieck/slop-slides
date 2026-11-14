import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { askUnsaved, type UnsavedAnswer, useUnsavedQuestion } from "../store/confirm";
import { UnsavedChanges } from "./UnsavedChanges";

beforeEach(() => useUnsavedQuestion.getState().question?.answer("cancel"));

/** Asks about `deck.html` with the dialog mounted, as on macOS or as elsewhere. */
function ask(mac = true) {
  render(<UnsavedChanges mac={mac} />);
  let asked!: Promise<UnsavedAnswer>;
  act(() => {
    asked = askUnsaved("deck.html");
  });
  return asked;
}
const dialog = () => screen.queryByRole("dialog", { name: "Unsaved changes" });

describe("UnsavedChanges", () => {
  it("shows nothing until something asks", () => {
    render(<UnsavedChanges />);
    expect(dialog()).toBeNull();
  });

  const buttons = () => screen.getAllByRole("button").map((button) => button.textContent);

  it("asks whether to save the changes to the file, Save the default", () => {
    void ask();
    expect(screen.getByRole("heading", { name: "Save the changes to deck.html?" })).toBeTruthy();
    expect(dialog()!.textContent).toContain("Without saving, they are lost.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("orders its buttons as macOS does: Don’t save apart at the left, then Cancel and Save", () => {
    void ask(true);
    expect(buttons()).toEqual(["Don’t save", "Cancel", "Save"]);
    const apart = screen.getByRole("button", { name: "Don’t save" }).parentElement!;
    expect(apart.classList.contains("mr-auto")).toBe(true);
    expect(apart.contains(screen.getByRole("button", { name: "Cancel" }))).toBe(false);
  });

  it("orders its buttons as Windows does elsewhere: Save, Don’t save, Cancel", () => {
    void ask(false);
    expect(buttons()).toEqual(["Save", "Don’t save", "Cancel"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
  });

  it("does not paint not saving red: it is a choice, and Save is the one that stands out", () => {
    void ask();
    expect(screen.getByRole("button", { name: "Don’t save" }).className).not.toContain("destructive");
    expect(screen.getByRole("button", { name: "Save" }).classList.contains("bg-primary")).toBe(true);
  });

  it("looks like every other dialog of the app", () => {
    void ask();
    for (const name of ["w-96", "rounded-xl", "bg-card", "shadow-dialog"]) {
      expect(dialog()!.classList.contains(name)).toBe(true);
    }
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
