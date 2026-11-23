import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { tooltipOf } from "../../test/ui";
import { ShowButton, ShowTooltip } from "./ShowButton";

/** Presses the mouse button on `element`; true when that was kept from moving the focus. */
function pressKept(element: Element): boolean {
  const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  element.dispatchEvent(down);
  return down.defaultPrevented;
}

describe("ShowButton", () => {
  it("is the presenter's icon button, named by its tooltip", () => {
    const onClick = vi.fn();
    render(
      <ShowButton tooltip="Next slide" shortcut="right" onClick={onClick}>
        <svg />
      </ShowButton>,
    );
    const button = screen.getByRole("button", { name: "Next slide" });
    expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(["size-8", "hover:bg-foreground/10"]));
    expect(button.hasAttribute("title")).toBe(false);
    expect(tooltipOf(button)).toBe("Next slide→");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("shows its tooltip dark, outside the dark subtree it belongs to, with the key in a key cap", () => {
    render(
      <div className="dark" data-testid="chrome">
        <ShowButton tooltip="Pen" shortcut="p">
          <svg />
        </ShowButton>
      </div>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Pen" }));
    const tooltip = document.querySelector("[data-slot=tooltip-content]")!;
    expect(screen.getByTestId("chrome").contains(tooltip)).toBe(false);
    expect(tooltip.classList.contains("dark")).toBe(true);
    expect(tooltip.querySelector("[data-slot=kbd]")?.textContent).toBe("P");
  });

  it("leaves the focus where it was when pressed, and still tells who else listens for the press", () => {
    const onMouseDown = vi.fn();
    render(
      <>
        <ShowButton tooltip="Pen">
          <svg />
        </ShowButton>
        <ShowButton aria-label="Plain" onMouseDown={onMouseDown} />
      </>,
    );
    expect(pressKept(screen.getByRole("button", { name: "Pen" }))).toBe(true);
    expect(pressKept(screen.getByRole("button", { name: "Plain" }))).toBe(true);
    expect(onMouseDown).toHaveBeenCalledOnce();
  });

  it("keeps a name of its own, and names no text button after its tooltip", () => {
    render(
      <>
        <ShowButton aria-label="Play" tooltip="Play: speak each slide's narration">
          <svg />
        </ShowButton>
        <ShowButton size="default" tooltip="End show" shortcut="escape">
          End
        </ShowButton>
      </>,
    );
    expect(tooltipOf(screen.getByRole("button", { name: "Play" }))).toBe("Play: speak each slide's narration");
    const end = screen.getByRole("button", { name: "End" });
    expect(end.hasAttribute("aria-label")).toBe(false);
    expect(tooltipOf(end)).toBe("End showEsc");
  });

  it("has no tooltip without one, and is then natively disabled", () => {
    render(<ShowButton aria-label="Plain" disabled />);
    const button = screen.getByRole("button", { name: "Plain" }) as HTMLButtonElement;
    expect(tooltipOf(button)).toBeNull();
    expect(button.disabled).toBe(true);
  });

  it("disabled with a tooltip, still says why: focusable, and not pressed", () => {
    const onClick = vi.fn();
    render(
      <ShowButton aria-label="Undo" tooltip="Nothing to undo on this slide" disabled onClick={onClick}>
        <svg />
      </ShowButton>,
    );
    const button = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(tooltipOf(button)).toBe("Nothing to undo on this slide");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("opens a popover as its trigger, tooltip and all", () => {
    render(
      <Popover>
        <PopoverTrigger render={<ShowButton size="icon-sm" tooltip="Timer settings" />}>
          <svg />
        </PopoverTrigger>
        <PopoverContent aria-label="Timer settings">Times</PopoverContent>
      </Popover>,
    );
    const button = screen.getByRole("button", { name: "Timer settings" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(tooltipOf(button)).toBe("Timer settings");
    expect(pressKept(button)).toBe(true);
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Timer settings" }).textContent).toBe("Times");
  });
});

describe("ShowTooltip", () => {
  it("is the dark tooltip of an element that is no ShowButton", () => {
    render(
      <ShowTooltip text="Red">
        <button type="button" aria-label="Red" />
      </ShowTooltip>,
    );
    const swatch = screen.getByRole("button", { name: "Red" });
    fireEvent.focus(swatch);
    const tooltip = document.querySelector("[data-slot=tooltip-content]")!;
    expect(tooltip.textContent).toBe("Red");
    expect(tooltip.classList.contains("dark")).toBe(true);
    expect(tooltip.querySelector("[data-slot=kbd]")).toBeNull();
  });
});
