import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { askUnsaved, type UnsavedAnswer, useUnsavedQuestion } from "../store/confirm";
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
const dialog = () => screen.queryByRole("dialog", { name: "Unsaved changes" });

describe("UnsavedChanges", () => {
  it("shows nothing until something asks", () => {
    render(<UnsavedChanges />);
    expect(dialog()).toBeNull();
  });

  it("asks whether to save the changes to the file, Save first", () => {
    void ask();
    expect(dialog()!.textContent).toContain("Save the changes to deck.html?");
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Don’t save", "Save"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
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
