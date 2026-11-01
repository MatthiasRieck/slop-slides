import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog";

const BACKDROP = "dialog-backdrop";

function open(props: Partial<Parameters<typeof Dialog>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(
    <Dialog
      label="Things"
      onClose={onClose}
      className="box"
      heading={<h2>The things</h2>}
      backdropTestId={BACKDROP}
      {...props}
    >
      <p>Body</p>
    </Dialog>,
  );
  return { onClose, ...view };
}

describe("Dialog", () => {
  it("shows its heading and body in a named dialog over a scrim", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Things" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.className).toBe("box");
    expect(screen.getByRole("heading", { level: 2, name: "The things" })).toBeTruthy();
    expect(dialog.textContent).toBe("The thingsBody");
    expect(screen.getByTestId(BACKDROP).className).toBe("fixed inset-0 z-50 flex items-center justify-center bg-scrim");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("closes on Escape anywhere, and stops listening once gone", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { onClose, unmount } = open();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(remove).toHaveBeenCalledWith("keydown", expect.any(Function));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    remove.mockRestore();
  });

  it("stays open when the scrim is pressed, unless asked to close then", () => {
    const { onClose, unmount } = open();
    fireEvent.pointerDown(screen.getByTestId(BACKDROP));
    expect(onClose).not.toHaveBeenCalled();
    unmount();

    const closing = open({ closeOnBackdrop: true });
    fireEvent.pointerDown(screen.getByText("Body"));
    expect(closing.onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByTestId(BACKDROP));
    expect(closing.onClose).toHaveBeenCalledTimes(1);
  });

  it("has a Close button when asked for one", () => {
    const { onClose } = open({ closeButton: true });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("takes the focus, keeps its keys, closes on its keys and gives the focus back", () => {
    render(<button type="button">Before</button>);
    const before = screen.getByText("Before");
    before.focus();
    const { onClose } = open({ takeFocus: true, closeKeys: ["Escape", "?"], closeButton: true });
    const dialog = screen.getByRole("dialog", { name: "Things" });
    expect(dialog.tagName).toBe("DIV");
    expect(document.activeElement).toBe(dialog);

    let reached = false;
    const listen = () => {
      reached = true;
    };
    window.addEventListener("keydown", listen);
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    // Escape outside the dialog is the page's, not the dialog's.
    fireEvent.keyDown(window, { key: "Escape" });
    window.removeEventListener("keydown", listen);
    expect(reached).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    reached = false;
    window.addEventListener("keydown", listen);
    fireEvent.keyDown(dialog, { key: "?" });
    window.removeEventListener("keydown", listen);
    expect(reached).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(before);

    dialog.focus();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(before);
  });
});
