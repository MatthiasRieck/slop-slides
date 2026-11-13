import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, buttonClass, ToolButton, toolButtonClass, withShortcut } from "./Button";

const classes = (value: string) => new Set(value.split(/\s+/).filter(Boolean));
const ICON_SIZE = "[&_svg:not([class*='size-'])]:size-4";
const TEXT_ICON_SIZE = "[&_svg:not([class*='size-'])]:size-3.5";
/** Every disabled button: one opacity, a plain cursor, and the pointer still on it for its tooltip. */
const DISABLED = "disabled:cursor-default disabled:opacity-40";

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

  it("adds its shortcut to the tooltip, not to its name", () => {
    render(
      <>
        <ToolButton label="Group" shortcut="mod+g" />
        <ToolButton label="Undo" title="Undo typing" shortcut="mod+z" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Group" }).getAttribute("title")).toBe("Group (Ctrl+G)");
    expect(screen.getByRole("button", { name: "Undo" }).getAttribute("title")).toBe("Undo typing (Ctrl+Z)");
  });

  it("writes a shortcut after a tooltip, and leaves no tooltip alone", () => {
    expect(withShortcut("Redo", "mod+shift+z")).toBe("Redo (Ctrl+Shift+Z)");
    expect(withShortcut("Redo", undefined)).toBe("Redo");
    expect(withShortcut(undefined, "mod+z")).toBeUndefined();
  });

  it("keeps its tooltip while disabled, or says why it is", () => {
    const { rerender } = render(<ToolButton label="Group" shortcut="mod+g" disabled />);
    const button = screen.getByRole("button", { name: "Group" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("Group (Ctrl+G)");
    rerender(<ToolButton label="Group" shortcut="mod+g" disabled disabledReason="Select two or more elements" />);
    expect(button.getAttribute("title")).toBe("Select two or more elements");
    expect(button.getAttribute("aria-label")).toBe("Group");
    rerender(<ToolButton label="Group" shortcut="mod+g" disabledReason="Select two or more elements" />);
    expect(button.getAttribute("title")).toBe("Group (Ctrl+G)");
  });

  it("takes the pointer while disabled, so the tooltip shows, without a hover look", () => {
    for (const variant of ["toolbar", "panel", "plain", "presenter"] as const) {
      const all = classes(toolButtonClass(variant));
      expect(all.has("disabled:pointer-events-none")).toBe(false);
      expect(all.has("disabled:cursor-default")).toBe(true);
      expect(all.has("disabled:opacity-40")).toBe(true);
      expect([...all].filter((name) => name.includes("hover:") && !name.startsWith("enabled:"))).toEqual([]);
    }
  });

  it("turns red under the pointer when destructive", () => {
    render(
      <>
        <ToolButton label="Delete" destructive />
        <ToolButton label="Copy" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Delete" }).classList.contains("enabled:hover:text-destructive")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Copy" }).className).not.toContain("destructive");
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

  it("clicks, but not while disabled", () => {
    const onClick = vi.fn();
    const { rerender } = render(<ToolButton label="Undo" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<ToolButton label="Undo" disabled onClick={onClick} />);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
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
      `rounded-md p-1 text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE}`,
    ],
    [
      "toolbar, roomy",
      toolButtonClass("toolbar", "md"),
      `rounded-md p-1.5 text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE}`,
    ],
    [
      "toolbar, tight",
      toolButtonClass("toolbar", "xs"),
      `rounded-md p-0.5 text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE}`,
    ],
    [
      "panel",
      toolButtonClass("panel"),
      `rounded-md p-1 text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE}`,
    ],
    [
      "plain",
      toolButtonClass("plain"),
      `rounded-md p-1 enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE}`,
    ],
    [
      "presenter",
      toolButtonClass("presenter", "md"),
      `flex size-8 items-center justify-center rounded-lg text-foreground/80 enabled:hover:bg-foreground/10 enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE}`,
    ],
    [
      "toolbar, on",
      toolButtonClass("toolbar", "sm", true),
      `rounded-md p-1 enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE} bg-accent text-foreground`,
    ],
    [
      "presenter, on",
      toolButtonClass("presenter", "sm", true),
      `flex size-8 items-center justify-center rounded-lg enabled:hover:bg-foreground/10 enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE} bg-foreground/20 text-foreground`,
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

  it("shows a spinner and cannot be pressed while busy", () => {
    const onClick = vi.fn();
    const { rerender, container } = render(<Button onClick={onClick}>Export</Button>);
    const button = screen.getByRole("button", { name: "Export" }) as HTMLButtonElement;
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(container.querySelector(".animate-spin")).toBeNull();
    rerender(
      <Button busy onClick={onClick}>
        Export
      </Button>,
    );
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.disabled).toBe(true);
    expect(container.querySelector("svg.animate-spin")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("stays disabled when asked, busy or not", () => {
    render(<Button disabled>Export</Button>);
    const button = screen.getByRole("button", { name: "Export" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it("warns with its color when destructive", () => {
    const all = classes(buttonClass("destructive"));
    expect(all.has("text-destructive")).toBe(true);
    expect(all.has("enabled:hover:bg-destructive/10")).toBe(true);
  });

  it("comes as tall as the Home screen's buttons, with their text and icons", () => {
    const tall = classes(buttonClass("outline", "2xl"));
    for (const name of ["h-9", "px-3", "rounded-lg", "text-sm", ICON_SIZE]) expect(tall.has(name)).toBe(true);
    const taller = classes(buttonClass("primary", "3xl"));
    for (const name of ["h-10", "px-4", "rounded-lg", "text-sm", ICON_SIZE]) expect(taller.has(name)).toBe(true);
    expect(taller.has("text-xs")).toBe(false);
  });

  it("looks disabled the same in every variant, with no hover", () => {
    for (const variant of ["outline", "primary", "ghost", "destructive"] as const) {
      const all = classes(buttonClass(variant));
      expect(all.has("disabled:opacity-40")).toBe(true);
      expect(all.has("disabled:pointer-events-none")).toBe(false);
      expect([...all].filter((name) => name.includes("hover:") && !name.startsWith("enabled:"))).toEqual([]);
    }
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
      `flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium enabled:hover:bg-accent ${DISABLED} ${TEXT_ICON_SIZE}`,
    ],
    [
      "outline, tight (timeline)",
      buttonClass("outline", "xs"),
      `flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium enabled:hover:bg-accent ${DISABLED} ${TEXT_ICON_SIZE}`,
    ],
    [
      "outline, large (export)",
      buttonClass("outline", "xl"),
      `flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium enabled:hover:bg-accent ${DISABLED} ${TEXT_ICON_SIZE}`,
    ],
    [
      "primary",
      buttonClass("primary", "lg"),
      `flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground enabled:hover:opacity-90 ${DISABLED} ${TEXT_ICON_SIZE}`,
    ],
    [
      "ghost",
      buttonClass("ghost", "sm"),
      `flex items-center gap-1 rounded-md px-1.5 py-1 text-xs enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED} ${TEXT_ICON_SIZE}`,
    ],
  ])("looks the same as before: %s", (_, actual, expected) => {
    expect(classes(actual)).toEqual(classes(expected));
  });
});
