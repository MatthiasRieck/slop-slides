import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import { tooltipOf } from "../test/ui";
import { SLIDE_TOOL, unlessOff } from "./toolProps";

describe("SLIDE_TOOL", () => {
  it("makes a compact tool button that keeps the focus where it is when pressed", () => {
    const onClick = vi.fn();
    render(
      <>
        <input aria-label="Slide text" />
        <Button {...SLIDE_TOOL} tooltip="Bold" onClick={onClick}>
          B
        </Button>
      </>,
    );
    const slide = screen.getByLabelText("Slide text");
    slide.focus();
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(bold.className.split(" ")).toEqual(expect.arrayContaining(["size-6", "text-muted-foreground"]));
    // The press's default, which would move the focus, is prevented.
    expect(fireEvent.mouseDown(bold)).toBe(false);
    fireEvent.click(bold);
    expect(onClick).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(slide);
  });

  it("keeps the focus from a tool that is off too, which could take it", () => {
    const onClick = vi.fn();
    render(
      <Button
        {...SLIDE_TOOL}
        aria-label="Group"
        {...unlessOff(true, "Select two or more elements", "Group", "mod+g")}
        onClick={onClick}
      >
        G
      </Button>,
    );
    const group = screen.getByRole("button", { name: "Group" }) as HTMLButtonElement;
    expect(group.getAttribute("aria-disabled")).toBe("true");
    // It is not disabled natively: the pointer and the keyboard reach it, for its tooltip.
    expect(group.disabled).toBe(false);
    expect(fireEvent.mouseDown(group)).toBe(false);
    fireEvent.click(group);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("unlessOff", () => {
  it("says what a tool does, with its keys, while it is on", () => {
    expect(unlessOff(false, "Select a group", "Ungroup", "mod+shift+g")).toEqual({
      disabled: false,
      tooltip: "Ungroup",
      shortcut: "mod+shift+g",
    });
    // No keys, no `shortcut` at all: one that is there but undefined is no better.
    expect(unlessOff(false, "Select a group", "Ungroup")).toEqual({ disabled: false, tooltip: "Ungroup" });
  });

  it("says what a tool waits for while it is off, without its keys", () => {
    expect(unlessOff(true, "Select a group", "Ungroup", "mod+shift+g")).toEqual({
      disabled: true,
      tooltip: "Select a group",
    });
  });

  it("shows on the button as its tooltip, the name staying the same either way", () => {
    const tool = (off: boolean) => (
      <Button
        {...SLIDE_TOOL}
        aria-label="Ungroup"
        {...unlessOff(off, "Select a group", "Take the group apart", "mod+g")}
      >
        U
      </Button>
    );
    const { rerender } = render(tool(false));
    const ungroup = screen.getByRole("button", { name: "Ungroup" });
    expect(tooltipOf(ungroup)).toBe("Take the group apartCtrl+G");
    rerender(tool(true));
    expect(tooltipOf(screen.getByRole("button", { name: "Ungroup" }))).toBe("Select a group");
  });
});
