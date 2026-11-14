import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { confirmAction, confirmStopAgent } from "../store/confirm";
import { ask as nativeAsk } from "../test/tauri";
import { ConfirmDialog } from "./ConfirmDialog";

const DELETE = { title: "Delete your recording?", message: "This can’t be undone.", confirmLabel: "Delete" };

/** Asks with the dialog mounted. */
function ask(options: Parameters<typeof confirmAction>[0]) {
  render(<ConfirmDialog />);
  let asked!: Promise<boolean>;
  act(() => {
    asked = confirmAction(options);
  });
  return asked;
}
const dialog = () => screen.queryByRole("dialog");

describe("ConfirmDialog", () => {
  it("shows nothing until something asks", () => {
    render(<ConfirmDialog />);
    expect(dialog()).toBeNull();
  });

  it("asks in the app's own dialog, with the question as its heading and buttons named by what they do", () => {
    void ask(DELETE);
    expect(dialog()!.getAttribute("aria-label")).toBe("Delete your recording?");
    expect(screen.getByRole("heading", { name: "Delete your recording?" })).toBeTruthy();
    expect(screen.getByText("This can’t be undone.")).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel", "Delete"]);
    for (const name of ["w-96", "rounded-xl", "bg-card", "shadow-dialog"]) {
      expect(dialog()!.classList.contains(name)).toBe(true);
    }
  });

  it.each([
    ["Delete", true],
    ["Cancel", false],
  ])("answers %s and goes away", async (name, answer) => {
    const asked = ask(DELETE);
    fireEvent.click(screen.getByRole("button", { name }));
    expect(await asked).toBe(answer);
    expect(dialog()).toBeNull();
  });

  it("takes Escape for a no", async () => {
    const asked = ask(DELETE);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(await asked).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("starts on the button that goes ahead, which stands out", () => {
    void ask({ title: "Enable Full access?", message: "Files can change without asking.", confirmLabel: "Enable" });
    const enable = screen.getByRole("button", { name: "Enable" });
    expect(document.activeElement).toBe(enable);
    expect(enable.classList.contains("bg-primary")).toBe(true);
  });

  it("starts on the button that stays when going ahead destroys something, and warns with its color", () => {
    void ask({ ...DELETE, destructive: true, cancelLabel: "Keep it" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.getByRole("button", { name: "Delete" }).classList.contains("text-destructive")).toBe(true);
  });

  it("asks the next question once the first is answered, with the focus where it starts", async () => {
    const first = ask({ ...DELETE, title: "First?" });
    let second!: Promise<boolean>;
    act(() => {
      second = confirmAction({ ...DELETE, title: "Second?", destructive: true });
    });
    expect(dialog()!.getAttribute("aria-label")).toBe("First?");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await first).toBe(true);
    expect(dialog()!.getAttribute("aria-label")).toBe("Second?");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await second).toBe(false);
  });

  it("never opens a native alert", async () => {
    const stop = ask({ title: "Stop?", message: "The agent is working.", confirmLabel: "Stop the agent" });
    fireEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
    expect(await stop).toBe(true);
    // The stand-in is only how a test without the dialog answers (see ../test/setup.ts); it gave no answer here.
    expect(nativeAsk.mock.results.every((result) => result.value === undefined)).toBe(true);
  });

  it("is answered by the `ask` stand-in in a test that mounts no dialog", async () => {
    nativeAsk.mockResolvedValueOnce(true);
    expect(await confirmStopAgent("The agent is still working. Stop it?")).toBe(true);
    expect(nativeAsk).toHaveBeenCalledWith("The agent is still working. Stop it?", {
      title: "The agent is still working",
      kind: "warning",
      okLabel: "Stop the agent",
      cancelLabel: "Cancel",
    });
  });
});
