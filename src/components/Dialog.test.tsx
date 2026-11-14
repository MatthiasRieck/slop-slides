import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { hasOpenLayer } from "../lib/layers";
import { Dialog, DialogActions } from "./Dialog";
import { Popover } from "./Popover";

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
      {props.children ?? <p>Body</p>}
    </Dialog>,
  );
  return { onClose, ...view };
}

const dialog = () => screen.getByRole("dialog", { name: "Things" });
const pressEscape = (target: Element = document.body) => fireEvent.keyDown(target, { key: "Escape" });

/** The app's root, as index.html has it, with a button in it that has the focus. */
function appWithFocus() {
  const root = document.createElement("div");
  root.id = "root";
  root.innerHTML = `<button type="button">Before</button>`;
  document.body.append(root);
  const before = root.querySelector("button")!;
  before.focus();
  return { root, before };
}

afterEach(() => document.getElementById("root")?.remove());

/** A dialog whose second button is what takes the focus. */
function Asked() {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <Dialog label="Things" onClose={() => {}} className="box" initialFocus={ref}>
      <button type="button">First</button>
      <button type="button" ref={ref}>
        Asked for
      </button>
    </Dialog>
  );
}

/** Shows what `children` render until they call the `close` they are given. */
function Asking({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(true);
  return open ? children(() => setOpen(false)) : null;
}

/** A dialog with a popover open in it. */
function WithPopover({ onClose }: { onClose: () => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <Dialog label="Things" onClose={onClose} className="box">
      <button type="button" ref={anchor}>
        More
      </button>
      {open && (
        <Popover anchor={anchor} width={100} label="Options" onClose={() => setOpen(false)}>
          Options
        </Popover>
      )}
    </Dialog>
  );
}

describe("Dialog", () => {
  it("shows its heading and body in a named modal dialog over a scrim, in the body", () => {
    const { container } = open();
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    // Its own classes, after the one it comes in with.
    expect(dialog().className).toBe("enter-pop box");
    expect(screen.getByRole("heading", { level: 2, name: "The things" })).toBeTruthy();
    expect(dialog().textContent).toBe("The thingsBody");
    const scrim = screen.getByTestId(BACKDROP);
    expect(scrim.className).toBe("enter-fade fixed inset-0 z-overlay flex items-center justify-center bg-scrim");
    // Rendered into the body: nothing it is used in clips it, and the app under it can go inert.
    expect(scrim.parentElement).toBe(document.body);
    expect(container.contains(scrim)).toBe(false);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("goes without a heading", () => {
    open({ heading: undefined });
    expect(dialog().textContent).toBe("Body");
    expect(dialog().children).toHaveLength(1);
  });

  it("closes on Escape wherever the focus is, before the page sees the key, and stops once gone", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    const { onClose, unmount } = open();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
    const pressed = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(pressed);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pressed.defaultPrevented).toBe(true);
    pressEscape(screen.getByText("Body"));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(page.mock.calls.filter(([event]) => event.key === "Escape")).toEqual([]);
    unmount();
    expect(hasOpenLayer()).toBe(false);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(page.mock.calls.filter(([event]) => event.key === "Escape")).toHaveLength(1);
    window.removeEventListener("keydown", page);
  });

  it("keeps Escape from what is under it even when Escape does not close it", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    const { onClose } = open({ closeKeys: ["q"] });
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: "q" });
    expect(onClose).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", page);
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

  it("has a Close button, with a tooltip, when asked for one", () => {
    const { onClose } = open({ closeButton: true });
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.getAttribute("title")).toBe("Close");
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("focus", () => {
    it("moves to the first control as the dialog opens, and back to what had it when it closes", () => {
      const { before } = appWithFocus();
      const { unmount } = open({
        children: (
          <>
            <button type="button">First</button>
            <button type="button">Second</button>
          </>
        ),
      });
      expect(document.activeElement).toBe(screen.getByText("First"));
      unmount();
      expect(document.activeElement).toBe(before);
    });

    it("moves to the box when the dialog has no control", () => {
      appWithFocus();
      open();
      expect(document.activeElement).toBe(dialog());
      expect(dialog().tabIndex).toBe(-1);
    });

    it("moves to what the markup marks, or to the element asked for", () => {
      const marked = open({
        children: (
          <>
            <button type="button">First</button>
            <input aria-label="Name" data-autofocus="" />
          </>
        ),
      });
      expect(document.activeElement).toBe(screen.getByLabelText("Name"));
      marked.unmount();

      render(<Asked />);
      expect(document.activeElement).toBe(screen.getByText("Asked for"));
    });

    it("leaves the focus with a control that took it as it mounted", () => {
      open({
        children: (
          <>
            <button type="button">First</button>
            <input aria-label="Name" autoFocus />
          </>
        ),
      });
      expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    });

    it("gives the focus back however the dialog goes away", () => {
      const { before } = appWithFocus();
      render(
        <Asking>
          {(close) => (
            <Dialog label="Things" onClose={() => {}} className="box">
              <button type="button" onClick={close}>
                Continue
              </button>
            </Dialog>
          )}
        </Asking>,
      );
      expect(document.activeElement).toBe(screen.getByText("Continue"));
      fireEvent.click(screen.getByText("Continue"));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(before);
    });

    it("keeps Tab inside, going round at either end", () => {
      appWithFocus();
      open({
        closeButton: true,
        children: (
          <>
            <button type="button">First</button>
            <button type="button">Last</button>
          </>
        ),
      });
      const close = screen.getByRole("button", { name: "Close" });
      const last = screen.getByText("Last");
      expect(document.activeElement).toBe(close);
      const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
      close.dispatchEvent(back);
      expect(document.activeElement).toBe(last);
      expect(back.defaultPrevented).toBe(true);
      fireEvent.keyDown(last, { key: "Tab" });
      expect(document.activeElement).toBe(close);
      // In between, the browser moves the focus itself.
      const within = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      close.dispatchEvent(within);
      expect(within.defaultPrevented).toBe(false);
    });

    it("takes a key pressed with the focus lost as its own, and brings the focus back in", () => {
      const page = vi.fn();
      window.addEventListener("keydown", page);
      const { onClose } = open({ closeKeys: ["Escape", "?"], children: <button type="button">Only</button> });
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      fireEvent.keyDown(document.body, { key: "ArrowRight" });
      expect(page).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(dialog());
      (document.activeElement as HTMLElement).blur();
      fireEvent.keyDown(document.body, { key: "Tab" });
      expect(document.activeElement).toBe(screen.getByText("Only"));
      (document.activeElement as HTMLElement).blur();
      fireEvent.keyDown(document.body, { key: "?" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(page).not.toHaveBeenCalled();
      window.removeEventListener("keydown", page);
    });
  });

  it("puts the rest of the app out of reach while open, until the last dialog closes", () => {
    const { root } = appWithFocus();
    const first = open();
    expect(root.hasAttribute("inert")).toBe(true);
    const second = open({ label: "More" });
    first.unmount();
    expect(root.hasAttribute("inert")).toBe(true);
    second.unmount();
    expect(root.hasAttribute("inert")).toBe(false);
  });

  it("keeps the keys pressed in it from the page, and closes on its own keys, not while typing", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    const { onClose } = open({
      closeKeys: ["Escape", "?"],
      closeButton: true,
      children: <input aria-label="Name" />,
    });
    fireEvent.keyDown(dialog(), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "?" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog(), { key: "?" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
    window.removeEventListener("keydown", page);
  });

  it("closes a popover open in it first, on one Escape, and itself on the next", () => {
    const onClose = vi.fn();
    render(<WithPopover onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "Options" })).toBeTruthy();
    pressEscape();
    expect(screen.queryByRole("dialog", { name: "Options" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("the one look", () => {
    const box = () => screen.getByRole("dialog");

    it("gives a dialog with a size the standard box, heading and text", () => {
      render(
        <Dialog
          label="Delete the recording"
          size="sm"
          title="Delete your recording?"
          description="It cannot be brought back."
          onClose={() => {}}
        >
          <DialogActions>
            <button type="button">Cancel</button>
            <button type="button">Delete</button>
          </DialogActions>
        </Dialog>,
      );
      for (const name of ["enter-pop", "w-96", "rounded-xl", "border", "bg-card", "p-5", "shadow-dialog"]) {
        expect(box().classList.contains(name)).toBe(true);
      }
      // Never past the window, however small.
      expect(box().className).toContain("max-w-[calc(100vw-2rem)]");
      expect(box().className).toContain("max-h-[calc(100vh-2rem)]");
      const heading = screen.getByRole("heading", { level: 2, name: "Delete your recording?" });
      expect(heading.className).toBe("text-sm font-semibold");
      const text = screen.getByText("It cannot be brought back.");
      expect(text.tagName).toBe("P");
      expect(text.classList.contains("text-muted-foreground")).toBe(true);
      // Heading, then what it says, then the buttons.
      expect([...box().children].map((child) => child.tagName)).toEqual(["H2", "P", "DIV"]);
    });

    it("comes in three widths, and lets the caller add to the box", () => {
      const { rerender } = render(
        <Dialog label="Things" size="md" onClose={() => {}}>
          Body
        </Dialog>,
      );
      expect(box().classList.contains("w-[32rem]")).toBe(true);
      rerender(
        <Dialog label="Things" size="lg" className="gap-0 p-0" onClose={() => {}}>
          Body
        </Dialog>,
      );
      expect(box().classList.contains("w-[44rem]")).toBe(true);
      // What the caller adds wins over the standard box's.
      expect(box().classList.contains("p-0")).toBe(true);
      expect(box().classList.contains("p-5")).toBe(false);
    });

    it("puts the Close button beside the title, the text under both", () => {
      render(
        <Dialog label="Things" size="md" title="The things" description="All of them." closeButton onClose={() => {}}>
          Body
        </Dialog>,
      );
      const row = screen.getByRole("heading", { name: "The things" }).parentElement!;
      expect(row.contains(screen.getByRole("button", { name: "Close" }))).toBe(true);
      expect(row.nextElementSibling).toBe(screen.getByText("All of them."));
    });

    it("lines its buttons up at the right, with a third way out apart at the left", () => {
      render(
        <DialogActions aside={<button type="button">Don’t save</button>}>
          <button type="button">Cancel</button>
          <button type="button">Save</button>
        </DialogActions>,
      );
      const row = screen.getByRole("button", { name: "Save" }).parentElement!;
      expect(row.classList.contains("justify-end")).toBe(true);
      const aside = screen.getByRole("button", { name: "Don’t save" }).parentElement!;
      expect(aside.parentElement).toBe(row);
      expect(aside.classList.contains("mr-auto")).toBe(true);
      expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
        "Don’t save",
        "Cancel",
        "Save",
      ]);
    });
  });
});
