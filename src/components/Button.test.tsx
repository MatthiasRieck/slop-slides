import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, buttonClass, ToolButton, toolButtonClass, withShortcut } from "./Button";

const classes = (value: string) => new Set(value.split(/\s+/).filter(Boolean));
const ICON_SIZE = "[&_svg:not([class*='size-'])]:size-4";
const TEXT_ICON_SIZE = "[&_svg:not([class*='size-'])]:size-3.5";
/** A disabled button: faded text-color ink, a plain cursor, and the pointer still on it for its tooltip. */
const DISABLED = "disabled:cursor-default disabled:text-foreground disabled:opacity-45";
/** A disabled button that has a color of its own while enabled: a plain muted box. */
const DISABLED_FLAT = "disabled:cursor-default disabled:border-border disabled:bg-muted disabled:text-muted-foreground";
/** A toggle or tool that is on. */
const ON = "bg-primary/10 text-primary enabled:hover:bg-primary/15 enabled:hover:text-primary";
/** The 24px that the tightest icon button takes presses on, around its 20px box. */
const HIT_AREA = "relative after:absolute after:top-1/2 after:left-1/2 after:size-6 after:-translate-1/2";

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
      // Faded, but in the text color: a muted icon faded further could not be read.
      expect(all.has("disabled:opacity-45")).toBe(true);
      expect(all.has("disabled:text-foreground")).toBe(true);
      expect([...all].filter((name) => name.includes("hover:") && !name.startsWith("enabled:"))).toEqual([]);
    }
  });

  it("takes presses on 24px at its tightest, without looking bigger", () => {
    const tight = classes(toolButtonClass("toolbar", "xs"));
    for (const name of HIT_AREA.split(" ")) expect(tight.has(name)).toBe(true);
    expect(tight.has("p-0.5")).toBe(true);
    // The others are 24px and more as they are.
    expect(classes(toolButtonClass("toolbar", "sm")).has("after:size-6")).toBe(false);
    // A caller placing it absolutely still can.
    render(<ToolButton label="Close" size="xs" className="absolute" />);
    const placed = screen.getByRole("button", { name: "Close" });
    expect(placed.classList.contains("absolute")).toBe(true);
    expect(placed.classList.contains("relative")).toBe(false);
  });

  it("hands its tooltip to the app's tooltips: the keys apart, a disabled reason beside its name", () => {
    const { rerender } = render(<ToolButton label="Group" shortcut="mod+g" />);
    const button = screen.getByRole("button", { name: "Group" });
    expect(button.getAttribute("data-tip-keys")).toBe("Ctrl+G");
    expect(button.hasAttribute("data-tip-label")).toBe(false);
    rerender(<ToolButton label="Group" shortcut="mod+g" disabled disabledReason="Select two or more elements" />);
    expect(button.getAttribute("title")).toBe("Select two or more elements");
    expect(button.getAttribute("data-tip-label")).toBe("Group");
    expect(button.hasAttribute("data-tip-keys")).toBe(false);
    rerender(<ToolButton label="Group" />);
    expect(button.hasAttribute("data-tip-keys")).toBe(false);
    expect(button.hasAttribute("data-tip-label")).toBe(false);
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
    expect(button.classList.contains("bg-primary/10")).toBe(false);
    rerender(<ToolButton label="Pen" active />);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    // The accent's tint, not the fill of a button under the pointer.
    expect(button.classList.contains("bg-primary/10")).toBe(true);
    expect(button.classList.contains("text-primary")).toBe(true);
    expect(button.classList.contains("bg-accent")).toBe(false);
  });

  it("shows what is on the same way in the toolbars, the panels and plain rows", () => {
    for (const variant of ["toolbar", "panel", "plain"] as const) {
      const on = classes(toolButtonClass(variant, "sm", true));
      for (const name of ON.split(" ")) expect(on.has(name)).toBe(true);
    }
  });

  it("shows the presenter's toggles on with their own colors", () => {
    render(<ToolButton variant="presenter" label="Pen" active />);
    const button = screen.getByRole("button", { name: "Pen" });
    expect(button.classList.contains("bg-foreground/20")).toBe(true);
    expect(button.classList.contains("bg-primary/10")).toBe(false);
  });

  it("passes aria-pressed through without the on look when not a styled toggle", () => {
    render(<ToolButton label="Hide slides" aria-pressed />);
    const button = screen.getByRole("button", { name: "Hide slides" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.classList.contains("bg-primary/10")).toBe(false);
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

  // Every class of each look, so a change to one is a change made on purpose.
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
      `rounded-md p-0.5 ${HIT_AREA} text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE}`,
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
    ["toolbar, on", toolButtonClass("toolbar", "sm", true), `rounded-md p-1 ${DISABLED} ${ICON_SIZE} ${ON}`],
    [
      "presenter, on",
      toolButtonClass("presenter", "sm", true),
      `flex size-8 items-center justify-center rounded-lg enabled:hover:bg-foreground/10 enabled:hover:text-foreground ${DISABLED} ${ICON_SIZE} bg-foreground/20 text-foreground`,
    ],
  ])("looks as it should: %s", (_, actual, expected) => {
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

  it("looks disabled in every variant, with no hover and the pointer still on it", () => {
    for (const variant of ["outline", "primary", "ghost", "destructive"] as const) {
      const all = classes(buttonClass(variant));
      expect(all.has("disabled:cursor-default")).toBe(true);
      expect(all.has("disabled:pointer-events-none")).toBe(false);
      expect([...all].filter((name) => name.includes("hover:") && !name.startsWith("enabled:"))).toEqual([]);
    }
  });

  it("drops its color while disabled, so a disabled primary button does not read as one to press", () => {
    for (const variant of ["primary", "destructive"] as const) {
      const all = classes(buttonClass(variant));
      for (const name of DISABLED_FLAT.split(" ")) expect(all.has(name)).toBe(true);
      // Not just faded: a faded fill still looks like a soft button.
      expect([...all].some((name) => name.startsWith("disabled:opacity"))).toBe(false);
      // The edge it gets is there all along, so it keeps its size.
      expect(all.has("border")).toBe(true);
    }
    for (const variant of ["outline", "ghost"] as const) {
      expect(classes(buttonClass(variant)).has("disabled:opacity-45")).toBe(true);
    }
  });

  it("is as tall as its neighbours whatever its variant: 24px in dense rows, 28px in bars and dialogs", () => {
    const heights = { xs: "min-h-6", sm: "min-h-6", md: "min-h-6", lg: "min-h-7", xl: "min-h-7" } as const;
    for (const [size, height] of Object.entries(heights) as [keyof typeof heights, string][]) {
      for (const variant of ["outline", "primary", "ghost", "destructive"] as const) {
        const all = classes(buttonClass(variant, size));
        expect(all.has(height)).toBe(true);
        // Never by padding, which a border or an icon adds to.
        expect([...all].filter((name) => /^p[ytb]-/.test(name))).toEqual([]);
      }
    }
  });

  it("takes a tooltip with the keys that do the same", () => {
    render(
      <Button title="Start the show" shortcut="mod+enter">
        Present
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Present" });
    expect(button.getAttribute("title")).toBe("Start the show (Ctrl+Enter)");
    expect(button.getAttribute("data-tip-keys")).toBe("Ctrl+Enter");
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

  // Every class of each look, so a change to one is a change made on purpose.
  it.each([
    [
      "outline (narration)",
      buttonClass("outline", "md"),
      `flex items-center gap-1 rounded-md border min-h-6 px-2.5 text-xs font-medium enabled:hover:bg-accent ${DISABLED} ${TEXT_ICON_SIZE}`,
    ],
    [
      "outline, tight (timeline)",
      buttonClass("outline", "xs"),
      `flex items-center gap-1 rounded-md border min-h-6 px-1.5 text-xs font-medium enabled:hover:bg-accent ${DISABLED} ${TEXT_ICON_SIZE}`,
    ],
    [
      "outline, large (export)",
      buttonClass("outline", "xl"),
      `flex items-center gap-1.5 rounded-md border min-h-7 px-3 text-xs font-medium enabled:hover:bg-accent ${DISABLED} ${TEXT_ICON_SIZE}`,
    ],
    [
      "primary",
      buttonClass("primary", "lg"),
      `flex items-center gap-1.5 rounded-md border border-transparent bg-primary min-h-7 px-2.5 text-xs font-medium text-primary-foreground enabled:hover:opacity-90 ${DISABLED_FLAT} ${TEXT_ICON_SIZE}`,
    ],
    [
      "ghost",
      buttonClass("ghost", "sm"),
      `flex items-center gap-1 rounded-md min-h-6 px-2 text-xs enabled:hover:bg-accent enabled:hover:text-foreground ${DISABLED} ${TEXT_ICON_SIZE}`,
    ],
  ])("looks as it should: %s", (_, actual, expected) => {
    expect(classes(actual)).toEqual(classes(expected));
  });
});
