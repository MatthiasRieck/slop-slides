import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EditElement } from "../lib/editTools";
import { EditContextMenu } from "./EditContextMenu";

const ELEMENT: EditElement = { path: "#intro > img", markup: "<img>", name: "<img>", added: true };

function menu(more: Partial<Parameters<typeof EditContextMenu>[0]> = {}) {
  const onAction = vi.fn();
  render(
    <EditContextMenu
      x={10}
      y={10}
      element={ELEMENT}
      running={false}
      onAction={onAction}
      onClose={() => {}}
      {...more}
    />,
  );
  return onAction;
}

const item = (name: RegExp) => screen.getByRole("menuitem", { name }) as HTMLButtonElement;

describe("EditContextMenu", () => {
  it("opens the ribbon's panels for a link, exact numbers, and another image", () => {
    const onAction = menu({ image: true });
    fireEvent.click(item(/^Link…/));
    expect(onAction).toHaveBeenLastCalledWith("link");
    fireEvent.click(item(/^Position and size…/));
    expect(onAction).toHaveBeenLastCalledWith("position");
    fireEvent.click(item(/^Replace image…/));
    expect(onAction).toHaveBeenLastCalledWith("replace-image");
  });

  it("offers Replace image only for an image, and Link only for one element", () => {
    menu({ elements: [ELEMENT, { ...ELEMENT, path: "#intro > p" }] });
    expect(screen.queryByRole("menuitem", { name: /^Replace image/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /^Link/ })).toBeNull();
  });

  it("aligns from a submenu: one element with the slide, three or more also spread out", () => {
    const onAction = menu();
    const row = item(/^Align with the slide/);
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.mouseEnter(row.parentElement!);
    const submenu = within(screen.getByRole("menu", { name: "Align" }));
    expect(submenu.queryByRole("menuitem", { name: /Distribute/ })).toBeNull();
    fireEvent.click(submenu.getByRole("menuitem", { name: "Align left" }));
    expect(onAction).toHaveBeenLastCalledWith("align-left");
  });

  it("spreads three or more out, and opens the submenu with the arrow key", () => {
    const three = [ELEMENT, { ...ELEMENT, path: "a" }, { ...ELEMENT, path: "b" }];
    const onAction = menu({ elements: three });
    fireEvent.keyDown(item(/^Align$/), { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Distribute vertically" }));
    expect(onAction).toHaveBeenLastCalledWith("distribute-v");
  });

  it("turns a quarter either way, with the keys that do it", () => {
    const onAction = menu();
    expect(item(/^Rotate right 90°/).textContent).toContain("Ctrl+Alt+R");
    fireEvent.click(item(/^Rotate left 90°/));
    expect(onAction).toHaveBeenLastCalledWith("rotate-left");
  });

  it("always shows Paste style, disabled with the way to copy one until a look was copied", () => {
    const onAction = menu({ canPasteStyle: false });
    expect(item(/^Paste style/).disabled).toBe(true);
    expect(item(/^Paste style/).title).toBe("Copy a style first (Ctrl+Alt+C)");
    expect(onAction).not.toHaveBeenCalled();
  });
});
