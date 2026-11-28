import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EditElement } from "../lib/editTools";
import { hasOpenLayer } from "../lib/layers";
import { settle } from "../test/ui";
import { EditContextMenu } from "./EditContextMenu";

const ELEMENT = {
  path: "#intro > h1",
  markup: "<h1>Hi</h1>",
  name: '<h1> "Hi"',
  added: true,
} as unknown as EditElement;
const DRAWING = { ...ELEMENT, markup: " <svg viewBox='0 0 1 1'></svg>" } as EditElement;

function menu(props: Partial<Parameters<typeof EditContextMenu>[0]> = {}) {
  const onAction = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <EditContextMenu
      x={90}
      y={45}
      element={ELEMENT}
      running={false}
      onAction={onAction}
      onClose={onClose}
      {...props}
    />,
  );
  return { ...view, onAction, onClose };
}

const items = () => screen.getAllByRole("menuitem").map((item) => item.textContent);
const item = (name: RegExp) => screen.getByRole("menuitem", { name });

describe("EditContextMenu", () => {
  it("is a menu named for what was clicked, open at that point and over the app", async () => {
    menu();
    const popup = screen.getByRole("menu", { name: "Element" });
    expect(hasOpenLayer()).toBe(true);
    await settle();
    expect(popup.parentElement!.style.transform).toBe("translate(90px, 45px)");
    expect(document.activeElement).toBe(popup);
  });

  it("offers what applies to an element, in sections, with the keys that do the same", () => {
    menu({ editable: true, canPasteStyle: true, flippable: true });
    expect(items()).toEqual([
      "Edit textEnter",
      "CutCtrl+X",
      "CopyCtrl+C",
      "PasteCtrl+V",
      "DuplicateCtrl+D",
      "DeleteBackspace",
      "Copy styleCtrl+Alt+C",
      "Paste styleCtrl+Alt+V",
      "Bring to frontCtrl+Shift+]",
      "Bring forwardCtrl+]",
      "Send backwardCtrl+[",
      "Send to backCtrl+Shift+[",
      "LockCtrl+Alt+L",
      "Flip horizontallyCtrl+Shift+H",
      "Flip verticallyCtrl+Shift+V",
      "Ask the agent about this…",
      "Tidy this element",
    ]);
    // A line between each two sections, and none before the first or after the last.
    expect(within(screen.getByRole("menu")).getAllByRole("separator")).toHaveLength(6);
    expect(screen.getAllByRole("group")).toHaveLength(7);
  });

  it("offers an empty spot pasting, selecting all, unlocking and the slide's background", () => {
    menu({ element: null, unlockable: true });
    expect(screen.getByRole("menu", { name: "Slide" })).toBeTruthy();
    expect(items()).toEqual(["PasteCtrl+V", "Select allCtrl+A", "Unlock all on this slide", "Slide background…"]);
  });

  it("offers a locked element little more than unlocking it", () => {
    menu({ locked: true });
    expect(items()).toEqual(["UnlockCtrl+Alt+L", "CopyCtrl+C", "Ask the agent about this…"]);
  });

  it("offers several elements grouping, and asks about all of them", () => {
    menu({ elements: [ELEMENT, ELEMENT, ELEMENT], editable: true });
    expect(item(/^Group/)).toBeTruthy();
    expect(item(/^Ask the agent about these 3 elements/)).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /^Edit text/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^Tidy/ })).toBeNull();
  });

  it("offers a drawing the SVG editor, and a group taking it apart", () => {
    menu({ element: DRAWING, group: true });
    expect(item(/^Edit in the SVG editor/)).toBeTruthy();
    expect(item(/^Ungroup/)).toBeTruthy();
  });

  it("picks a choice once, which closes the menu by itself", () => {
    const { onAction, onClose } = menu();
    fireEvent.click(item(/^Duplicate/));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("duplicate");
    // Closing after a pick is the pick's part: it is not reported as a dismissal too.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("picks with the keyboard", async () => {
    const { onAction } = menu();
    await settle();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await settle();
    expect(document.activeElement).toBe(item(/^Cut/));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await settle();
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith("copy");
  });

  it("says why what waits for the agent is off, and does not pick it", () => {
    const { onAction } = menu({ running: true });
    for (const busy of [item(/^Ask the agent/), item(/^Tidy this/)]) {
      expect(busy.getAttribute("aria-disabled")).toBe("true");
      expect(busy.title).toBe("The agent is busy");
      // Off, it still takes the pointer, for the tooltip.
      expect(busy.className).toContain("data-disabled:pointer-events-auto");
      fireEvent.click(busy);
    }
    expect(onAction).not.toHaveBeenCalled();
    expect(item(/^Cut/).getAttribute("aria-disabled")).toBeNull();
    expect(item(/^Cut/).title).toBe("");
  });

  it("closes on Escape and on a press beside it, saying so once", () => {
    const first = menu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(first.onClose).toHaveBeenCalledOnce();
    expect(first.onAction).not.toHaveBeenCalled();
    first.unmount();
    expect(hasOpenLayer()).toBe(false);

    const second = menu();
    fireEvent.pointerDown(document.body, { pointerType: "mouse", button: 0 });
    fireEvent.click(document.body);
    expect(second.onClose).toHaveBeenCalledOnce();
  });

  it("keeps its keys from the shortcuts of what is under it, but for Escape", async () => {
    menu();
    await settle();
    const onKey = vi.fn();
    window.addEventListener("keydown", onKey);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "z", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Delete" });
    window.removeEventListener("keydown", onKey);
    expect(onKey).not.toHaveBeenCalled();
  });

  describe("with other slides shown beside this one", () => {
    const TARGETS = [
      { id: "plan", number: 2 },
      { id: "outro", number: 5 },
    ];
    const moveTo = () => screen.queryByRole("menuitem", { name: "Move to slide" });

    it("opens the slides the selection can move to, and says which was picked instead of an action", async () => {
      const onMoveTo = vi.fn();
      const { onAction, onClose } = menu({ moveTargets: TARGETS, onMoveTo });
      // The move is one more choice of the menu, which opens the slides.
      expect(items()).toContain("Move to slide");
      expect(screen.queryByRole("menuitem", { name: "Slide 2" })).toBeNull();
      fireEvent.click(moveTo()!);
      const slides = await screen.findByRole("menu", { name: "Move to slide" });
      expect(
        within(slides)
          .getAllByRole("menuitem")
          .map((each) => each.textContent),
      ).toEqual(["Slide 2", "Slide 5"]);
      fireEvent.click(within(slides).getByRole("menuitem", { name: "Slide 5" }));
      expect(onMoveTo).toHaveBeenCalledExactlyOnceWith("outro");
      // Picking a slide is what closes the menu: it is not reported as closed beside that.
      expect(onAction).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("offers no move without them, on an empty spot or on a locked element", () => {
      const first = menu();
      expect(moveTo()).toBeNull();
      first.unmount();
      const second = menu({ moveTargets: [] });
      expect(moveTo()).toBeNull();
      second.unmount();
      const third = menu({ moveTargets: TARGETS, element: null });
      expect(moveTo()).toBeNull();
      third.unmount();
      menu({ moveTargets: TARGETS, locked: true });
      expect(moveTo()).toBeNull();
    });
  });
});
