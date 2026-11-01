import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, buttonClass, keepFocus, ToolButton, toolButtonClass } from "./Button";

const classes = (value: string) => new Set(value.split(/\s+/).filter(Boolean));
const ICON_SIZE = "[&_svg:not([class*='size-'])]:size-4";
const TEXT_ICON_SIZE = "[&_svg:not([class*='size-'])]:size-3.5";

/** Whether a mouse-down on the element had its default (moving focus) prevented. */
function mouseDownPrevented(element: HTMLElement) {
  const event = createEvent.mouseDown(element);
  fireEvent(element, event);
  return event.defaultPrevented;
}

describe("ToolButton", () => {
  it("names itself by its label, for screen readers and as its tooltip", () => {
    render(<ToolButton label="Bold" onClick={() => {}} />);
    const button = screen.getByRole("button", { name: "Bold" });
    expect(button.getAttribute("aria-label")).toBe("Bold");
    expect(button.getAttribute("title")).toBe("Bold");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.hasAttribute("aria-pressed")).toBe(false);
  });

  it("takes a tooltip of its own over the label", () => {
    render(<ToolButton label="Link" title="Add a link" onClick={() => {}} />);
    const button = screen.getByRole("button", { name: "Link" });
    expect(button.getAttribute("title")).toBe("Add a link");
  });

  it("goes without a label, named by its title or aria-label as given", () => {
    render(
      <>
        <ToolButton title="Refresh the list" />
        <ToolButton aria-label="Close" />
      </>,
    );
    const titled = screen.getByRole("button", { name: "Refresh the list" });
    expect(titled.hasAttribute("aria-label")).toBe(false);
    const labelled = screen.getByRole("button", { name: "Close" });
    expect(labelled.hasAttribute("title")).toBe(false);
  });

  it("marks a toggle as pressed and shows it as on", () => {
    const { rerender } = render(<ToolButton label="Pen" active={false} />);
    const button = screen.getByRole("button", { name: "Pen" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.classList.contains("bg-accent")).toBe(false);
    rerender(<ToolButton label="Pen" active />);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("bg-accent")).toBe(true);
    expect(button.classList.contains("text-foreground")).toBe(true);
  });

  it("shows the presenter's toggles on with their own colors", () => {
    render(<ToolButton variant="presenter" label="Pen" active />);
    const button = screen.getByRole("button", { name: "Pen" });
    expect(button.classList.contains("bg-foreground/20")).toBe(true);
    expect(button.classList.contains("bg-accent")).toBe(false);
  });

  it("passes aria-pressed through without the on look when not a styled toggle", () => {
    render(<ToolButton label="Hide slides" aria-pressed />);
    const button = screen.getByRole("button", { name: "Hide slides" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("bg-accent")).toBe(false);
  });

  it("is disabled and not clicked when disabled", () => {
    const onClick = vi.fn();
    render(<ToolButton label="Undo" disabled onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("clicks", () => {
    const onClick = vi.fn();
    render(<ToolButton label="Undo" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps focus where it was on a press only with keepFocus", () => {
    render(
      <>
        <ToolButton label="Keeps" keepFocus />
        <ToolButton label="Takes" />
      </>,
    );
    expect(mouseDownPrevented(screen.getByRole("button", { name: "Keeps" }))).toBe(true);
    expect(mouseDownPrevented(screen.getByRole("button", { name: "Takes" }))).toBe(false);
  });

  it("adds layout classes without losing its look", () => {
    render(<ToolButton label="Cancel" variant="panel" className="-ml-1" />);
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button.classList.contains("-ml-1")).toBe(true);
    expect(button.classList.contains("p-1")).toBe(true);
  });

  // The classes each look replaced, so the shared button looks as the buttons did before it.
  it.each([
    [
      "toolbar",
      toolButtonClass(),
      `rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 ${ICON_SIZE}`,
    ],
    [
      "toolbar, roomy",
      toolButtonClass("toolbar", "md"),
      `rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 ${ICON_SIZE}`,
    ],
    [
      "toolbar, tight",
      toolButtonClass("toolbar", "xs"),
      `rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 ${ICON_SIZE}`,
    ],
    [
      "panel",
      toolButtonClass("panel"),
      `rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 ${ICON_SIZE}`,
    ],
    [
      "plain",
      toolButtonClass("plain"),
      `rounded-md p-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 ${ICON_SIZE}`,
    ],
    [
      "presenter",
      toolButtonClass("presenter", "md"),
      `flex size-8 items-center justify-center rounded-lg text-foreground/80 hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-35 ${ICON_SIZE}`,
    ],
    [
      "toolbar, on",
      toolButtonClass("toolbar", "sm", true),
      `rounded-md p-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 ${ICON_SIZE} bg-accent text-foreground`,
    ],
    [
      "presenter, on",
      toolButtonClass("presenter", "sm", true),
      `flex size-8 items-center justify-center rounded-lg hover:bg-foreground/10 hover:text-foreground disabled:pointer-events-none disabled:opacity-35 ${ICON_SIZE} bg-foreground/20 text-foreground`,
    ],
  ])("looks the same as before: %s", (_, actual, expected) => {
    expect(classes(actual)).toEqual(classes(expected));
  });
});

describe("Button", () => {
  it("is a plain button with its text, disabled when asked", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button title="Play the audio" onClick={onClick}>
        Play
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Play" }) as HTMLButtonElement;
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe("Play the audio");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    rerender(
      <Button title="Play the audio" disabled onClick={onClick}>
        Play
      </Button>,
    );
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("submits its form when a submit button", () => {
    render(
      <Button variant="primary" type="submit">
        Apply
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Apply" }).getAttribute("type")).toBe("submit");
  });

  it("passes aria attributes through", () => {
    render(
      <Button aria-haspopup="menu" aria-expanded={false} aria-label="Export the deck">
        Export
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Export the deck" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("adds layout classes without losing its look", () => {
    render(
      <Button size="lg" className="mt-1">
        Show in folder
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Show in folder" });
    expect(classes(button.className)).toEqual(classes(`${buttonClass("outline", "lg")} mt-1`));
  });

  // The classes each look replaced, so the shared button looks as the buttons did before it.
  it.each([
    [
      "outline (narration)",
      buttonClass("outline", "md"),
      `flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent ${TEXT_ICON_SIZE}`,
    ],
    [
      "outline, tight (timeline)",
      buttonClass("outline", "xs"),
      `flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent ${TEXT_ICON_SIZE}`,
    ],
    [
      "outline, large (export)",
      buttonClass("outline", "xl"),
      `flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent ${TEXT_ICON_SIZE}`,
    ],
    [
      "primary",
      buttonClass("primary", "lg"),
      `flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40 ${TEXT_ICON_SIZE}`,
    ],
    [
      "ghost",
      buttonClass("ghost", "sm"),
      `flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 ${TEXT_ICON_SIZE}`,
    ],
  ])("looks the same as before: %s", (_, actual, expected) => {
    expect(classes(actual)).toEqual(classes(expected));
  });
});

describe("keepFocus", () => {
  it("cancels the default press, so focus stays in the slide", () => {
    const preventDefault = vi.fn();
    keepFocus({ preventDefault } as unknown as React.MouseEvent);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
