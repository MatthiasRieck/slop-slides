import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useDropdown } from "./useDropdown";
import { menuItems, useMenuKeys } from "./useMenuKeys";

function Menu(props: { onPick?: (choice: string) => void }) {
  const { open, setOpen, ref } = useDropdown();
  const menu = useMenuKeys();
  return (
    <>
      <div ref={ref}>
        <button type="button" aria-haspopup="menu" onClick={() => setOpen((was) => !was)}>
          File
        </button>
        {open && (
          <div role="menu" {...menu}>
            <button type="button" role="menuitem" onClick={() => setOpen(false)}>
              Open
            </button>
            <button type="button" role="menuitem" disabled>
              Save
            </button>
            <button type="button" role="menuitemradio" aria-checked="false" onClick={() => props.onPick?.("dark")}>
              Dark
            </button>
            <button type="button">Not a choice</button>
            <button type="button" role="menuitem">
              Close
            </button>
          </div>
        )}
      </div>
      <button type="button">Elsewhere</button>
    </>
  );
}

const trigger = () => screen.getByText("File");
const menu = () => screen.getByRole("menu");
const focused = () => document.activeElement?.textContent;
const key = (name: string) => fireEvent.keyDown(document.activeElement!, { key: name });

/** Opens the menu as Enter on its focused button does. */
function openWithKeyboard() {
  trigger().focus();
  fireEvent.keyDown(trigger(), { key: "Enter" });
  fireEvent.click(trigger());
}

/** Opens the menu as a press with the pointer does. */
function openWithPointer() {
  fireEvent.pointerDown(trigger());
  fireEvent.click(trigger());
}

describe("useMenuKeys", () => {
  it("puts the focus on the first choice when the menu is opened with the keyboard", () => {
    render(<Menu />);
    openWithKeyboard();
    expect(focused()).toBe("Open");
  });

  it("puts the focus on the menu itself when it is opened with the pointer, ready for the arrows", () => {
    render(<Menu />);
    openWithPointer();
    expect(document.activeElement).toBe(menu());
    expect(menu().tabIndex).toBe(-1);
    key("ArrowDown");
    expect(focused()).toBe("Open");
  });

  it("goes through the choices that can be picked with the arrows, round again, and to the ends", () => {
    render(<Menu />);
    openWithKeyboard();
    key("ArrowDown");
    expect(focused()).toBe("Dark");
    key("ArrowDown");
    expect(focused()).toBe("Close");
    key("ArrowDown");
    expect(focused()).toBe("Open");
    key("ArrowUp");
    expect(focused()).toBe("Close");
    key("Home");
    expect(focused()).toBe("Open");
    key("End");
    expect(focused()).toBe("Close");
    expect(menuItems(menu()).map((item) => item.textContent)).toEqual(["Open", "Dark", "Close"]);
  });

  it("goes to the last choice on ↑ from the menu itself", () => {
    render(<Menu />);
    openWithPointer();
    key("ArrowUp");
    expect(focused()).toBe("Close");
  });

  it("keeps its arrows from the page, and leaves other keys and shortcuts alone", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    render(<Menu />);
    openWithKeyboard();
    page.mockClear();
    const arrow = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    expect(page).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", metaKey: true });
    fireEvent.keyDown(document.activeElement!, { key: "a" });
    expect(focused()).toBe("Dark");
    expect(page).toHaveBeenCalledTimes(2);
    window.removeEventListener("keydown", page);
  });

  it("gives the focus back to the button when the menu closes, on Escape or on a choice", () => {
    render(<Menu />);
    openWithKeyboard();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    openWithKeyboard();
    fireEvent.click(screen.getByText("Open"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("leaves the focus where a press outside put it", () => {
    render(<Menu />);
    openWithKeyboard();
    const elsewhere = screen.getByText("Elsewhere");
    elsewhere.focus();
    fireEvent.pointerDown(elsewhere);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});
