// What the app asks of its shadcn/ui components beyond what the registry ships: the variants and
// sizes added to them, how they sit in the app's layers and keys, and how a test works them.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "@/components/AppProviders";
import { DarkScope } from "@/lib/darkScope";
import { dismissTopLayer, hasOpenLayer } from "@/lib/layers";
import { pickOption, settle, tooltipOf } from "@/test/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTitle,
} from "./alert-dialog";
import { Attachment, AttachmentContent, AttachmentMedia, AttachmentTitle } from "./attachment";
import { Button, buttonVariants } from "./button";
import { Checkbox } from "./checkbox";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./context-menu";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Field, FieldLabel } from "./field";
import { Input } from "./input";
import { NativeSelect, NativeSelectOption } from "./native-select";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Slider } from "./slider";
import { Switch } from "./switch";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { Toaster, toast } from "./toast";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

afterEach(() => vi.restoreAllMocks());

const classes = (element: Element) => element.className.split(/\s+/);

describe("Button", () => {
  it("is a plain button that does not submit a form", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(button.type).toBe("button");
    expect(button.dataset.slot).toBe("button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("has the app's variants and compact sizes beside shadcn's", () => {
    expect(buttonVariants({ variant: "tool" })).toContain("text-muted-foreground");
    expect(buttonVariants({ variant: "presenter" })).toContain("hover:bg-foreground/10");
    const heights = { "2xs": "h-5", xs: "h-6", sm: "h-7", default: "h-8", lg: "h-9", xl: "h-10" } as const;
    for (const [size, height] of Object.entries(heights)) {
      expect(buttonVariants({ size: size as keyof typeof heights }).split(" ")).toContain(height);
    }
    const boxes = { "icon-2xs": "size-5", "icon-xs": "size-6", "icon-sm": "size-7", icon: "size-8" } as const;
    for (const [size, box] of Object.entries(boxes)) {
      expect(buttonVariants({ size: size as keyof typeof boxes }).split(" ")).toContain(box);
    }
  });

  it("is filled while pressed, as a toggle", () => {
    render(
      <Button variant="tool" size="icon-xs" aria-label="Bold" aria-pressed>
        B
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Bold", pressed: true });
    expect(classes(button)).toContain("aria-pressed:bg-muted");
  });

  it("names an icon button after its tooltip, and shows the shortcut in it", () => {
    render(
      <Button variant="tool" size="icon-xs" tooltip="Group" shortcut="mod+g">
        <svg />
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Group" });
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull();
    expect(tooltipOf(button)).toMatch(/^Group(⌘G|Ctrl\+G)$/);
    expect(document.querySelector("[data-slot=tooltip-content] [data-slot=kbd]")).toBeNull();
  });

  it("keeps a name of its own, and names no text button after its tooltip", () => {
    render(
      <>
        <Button size="icon-xs" aria-label="Fill" tooltip="Fill: red">
          <svg />
        </Button>
        <Button tooltip="Saves the deck">Save</Button>
      </>,
    );
    expect(tooltipOf(screen.getByRole("button", { name: "Fill" }))).toBe("Fill: red");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("aria-label")).toBe(false);
  });

  it("has no tooltip without one", () => {
    render(<Button aria-label="Plain" />);
    expect(tooltipOf(screen.getByRole("button", { name: "Plain" }))).toBeNull();
  });

  it("disabled, cannot be pressed", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled with a tooltip, still says why: focusable, under the pointer, and not pressed", () => {
    const onClick = vi.fn();
    render(
      <Button size="icon-xs" disabled tooltip="Select something first" aria-label="Group" onClick={onClick}>
        <svg />
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Group" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(classes(button)).toContain("aria-disabled:opacity-50");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(tooltipOf(button)).toBe("Select something first");
  });

  it("keeps the focus where it is when its press is prevented", () => {
    render(
      <>
        <input aria-label="field" />
        <Button onMouseDown={(event) => event.preventDefault()}>Bold</Button>
      </>,
    );
    // What the browser does with a prevented press is its own; the handler has to get there.
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Bold" }))).toBe(false);
  });

  it("with keepFocus, leaves the focus where it is when pressed, off or not", () => {
    const onMouseDown = vi.fn();
    render(
      <>
        <input aria-label="Slide text" />
        <Button keepFocus onMouseDown={onMouseDown}>
          Bold
        </Button>
        <Button keepFocus size="icon" aria-label="Group" disabled tooltip="Select two or more elements" />
        <Button>Plain</Button>
      </>,
    );
    screen.getByLabelText("Slide text").focus();
    // The press's default, which would move the focus, is prevented; who listens still hears it.
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Bold" }))).toBe(false);
    expect(onMouseDown).toHaveBeenCalledOnce();
    // A button that is off but focusable, for its tooltip, would take the focus all the same.
    const group = screen.getByRole("button", { name: "Group" }) as HTMLButtonElement;
    expect(group.disabled).toBe(false);
    expect(fireEvent.mouseDown(group)).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Plain" }))).toBe(true);
  });

  it("keeps what a trigger hands down when it is the trigger's button, tooltip and all", () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="tool" size="icon-xs" tooltip="More" />} />
        <DropdownMenuContent>
          <DropdownMenuItem>One</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const button = screen.getByRole("button", { name: "More" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(tooltipOf(button)).toBe("More");
    fireEvent.click(button);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Tooltip", () => {
  it("leaves Escape to the app, and is no layer over it", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    render(
      <Tooltip>
        <TooltipTrigger render={<button type="button">Zoom</button>} />
        <TooltipContent>Zoom in</TooltipContent>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByRole("button"));
    expect(screen.getByText("Zoom in")).toBeTruthy();
    expect(hasOpenLayer()).toBe(false);
    fireEvent.keyDown(screen.getByRole("button"), { key: "Escape" });
    expect(screen.queryByText("Zoom in")).toBeNull();
    expect(page).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", page);
  });
});

/** A dialog its button opens, with a field in it. */
function Example(props: { onKeyDown?: (event: { key: string }) => void }) {
  return (
    <>
      <button type="button">Before</button>
      <Dialog>
        <DialogTrigger render={<Button>Open</Button>} />
        <DialogContent onKeyDown={props.onKeyDown}>
          <DialogTitle>Settings</DialogTitle>
          <input aria-label="Name" />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A dialog that is rendered only while it is asked for, as most of the app's are. */
function Asked() {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setAsking(true)}>
        Ask
      </button>
      {asking && (
        <Dialog open onOpenChange={(open) => !open && setAsking(false)}>
          <DialogContent>
            <DialogTitle>Sure?</DialogTitle>
            <button type="button" onClick={() => setAsking(false)}>
              Yes
            </button>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

describe("Dialog", () => {
  it("is named by its title, takes the focus in, and gives it back", async () => {
    render(<Example />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await settle();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await settle();
    expect(document.activeElement).toBe(opener);
  });

  it("counts as open over the app while it is", () => {
    render(<Example />);
    expect(hasOpenLayer()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(hasOpenLayer()).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(hasOpenLayer()).toBe(false);
  });

  it("closes on an Escape that a slide preview hands over", () => {
    render(<Example />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    act(() => {
      expect(dismissTopLayer()).toBe(true);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps its keys from the app's shortcuts, after its own handler", () => {
    const page = vi.fn();
    const own = vi.fn();
    window.addEventListener("keydown", page);
    render(<Example onKeyDown={(event) => own(event.key)} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "z", metaKey: true });
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "ArrowRight" });
    expect(own.mock.calls).toEqual([["z"], ["ArrowRight"]]);
    expect(page).not.toHaveBeenCalled();
    window.removeEventListener("keydown", page);
  });

  it("closes on a press beside it unless told not to", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <Dialog open onOpenChange={onOpenChange} disablePointerDismissal>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const press = () => {
      const overlay = document.querySelector("[data-slot=dialog-overlay]") as Element;
      fireEvent.pointerDown(overlay, { pointerType: "mouse", button: 0 });
      fireEvent.click(overlay);
    };
    press();
    expect(onOpenChange).not.toHaveBeenCalled();
    rerender(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    press();
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
    expect(onOpenChange.mock.calls[0]?.[1].reason).toBe("outside-press");
  });

  it("gives the focus back when what rendered it open takes it away", async () => {
    render(<Asked />);
    const opener = screen.getByRole("button", { name: "Ask" });
    opener.focus();
    fireEvent.click(opener);
    await settle();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await settle();
    expect(document.activeElement).toBe(opener);
    expect(hasOpenLayer()).toBe(false);
  });
});

/** The question about unsaved edits, as the app asks it: Save has the focus, Escape cancels. */
function Question({ answer }: { answer: (answer: string) => void }) {
  const [open, setOpen] = useState(true);
  const save = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) answer("cancel");
        setOpen(next);
      }}
    >
      <AlertDialogContent initialFocus={save}>
        <AlertDialogTitle>Save the changes?</AlertDialogTitle>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction ref={save} onClick={() => answer("save")}>
          Save
        </AlertDialogAction>
      </AlertDialogContent>
    </AlertDialog>
  );
}

describe("AlertDialog", () => {
  it("asks, answers on Escape as cancelled, and starts on the button it is told to", async () => {
    const answer = vi.fn();
    render(<Question answer={answer} />);
    await settle();
    expect(screen.getByRole("alertdialog", { name: "Save the changes?" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
    expect(hasOpenLayer()).toBe(true);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(answer.mock.calls).toEqual([["cancel"]]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not close on a press beside it", async () => {
    const answer = vi.fn();
    render(<Question answer={answer} />);
    await settle();
    const overlay = document.querySelector("[data-slot=alert-dialog-overlay]") as Element;
    fireEvent.pointerDown(overlay, { pointerType: "mouse", button: 0 });
    fireEvent.click(overlay);
    expect(answer).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });
});

describe("Popover", () => {
  it("is a named dialog that closes on Escape and on a press outside, and counts as open", async () => {
    render(
      <>
        <Popover>
          <PopoverTrigger render={<Button>Colors</Button>} />
          <PopoverContent aria-label="Fill">
            <input aria-label="Hex" />
          </PopoverContent>
        </Popover>
        <button type="button">Elsewhere</button>
      </>,
    );
    const opener = screen.getByRole("button", { name: "Colors" });
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Fill" })).toBeTruthy();
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    expect(hasOpenLayer()).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Hex"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hasOpenLayer()).toBe(false);

    fireEvent.click(opener);
    expect(screen.getByRole("dialog")).toBeTruthy();
    const outside = screen.getByRole("button", { name: "Elsewhere" });
    fireEvent.pointerDown(outside, { pointerType: "mouse", button: 0 });
    fireEvent.click(outside);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves the focus where it is when asked to, opening and closing", async () => {
    render(
      <>
        <input aria-label="Slide text" />
        <Popover>
          <PopoverTrigger render={<Button onMouseDown={(event) => event.preventDefault()}>Size</Button>} />
          <PopoverContent initialFocus={false} finalFocus={false}>
            <button type="button">Bigger</button>
          </PopoverContent>
        </Popover>
      </>,
    );
    const field = screen.getByLabelText("Slide text");
    field.focus();
    fireEvent.click(screen.getByRole("button", { name: "Size" }));
    await settle();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: "Escape" });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(field);
  });

  it("closes on a press in a slide preview, in a window with the app's providers", async () => {
    render(
      <AppProviders>
        <Popover>
          <PopoverTrigger render={<Button>Colors</Button>} />
          <PopoverContent>Swatches</PopoverContent>
        </Popover>
        <iframe title="slide" />
      </AppProviders>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Colors" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    const frame = document.querySelector("iframe") as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:press" }, source: frame.contentWindow }));
    });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("DropdownMenu", () => {
  it("opens on a click, runs a choice and closes, and leaves a disabled one alone", () => {
    const run = vi.fn();
    const off = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button>File</Button>} />
        <DropdownMenuContent>
          <DropdownMenuItem onClick={run}>
            Save
            <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled onClick={off}>
            Export
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.click(screen.getByRole("button", { name: "File" }));
    expect(hasOpenLayer()).toBe(true);
    const [save, exportItem] = screen.getAllByRole("menuitem");
    expect(exportItem?.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(exportItem as Element);
    expect(off).not.toHaveBeenCalled();
    fireEvent.click(save as Element);
    expect(run).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(hasOpenLayer()).toBe(false);
  });

  it("opens at a point, with no trigger, for a menu something else asks for", async () => {
    const onOpenChange = vi.fn();
    render(
      <DropdownMenu open onOpenChange={onOpenChange}>
        <DropdownMenuContent aria-label="Slide" anchor={{ getBoundingClientRect: () => new DOMRect(40, 60, 0, 0) }}>
          <DropdownMenuItem>Duplicate</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await settle();
    const menu = screen.getByRole("menu", { name: "Slide" });
    expect(menu.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });
});

describe("ContextMenu", () => {
  it("opens on a right-click of what it wraps", () => {
    const run = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger render={<li>Slide 1</li>} />
        <ContextMenuContent>
          <ContextMenuItem variant="destructive" onClick={run}>
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    expect(screen.getByText("Slide 1").tagName).toBe("LI");
    fireEvent.contextMenu(screen.getByText("Slide 1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("Select", () => {
  it("shows the label of its value when given its items, and picks with a press", () => {
    const onValueChange = vi.fn();
    const items = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ];
    render(
      <Select items={items} defaultValue="a" onValueChange={onValueChange}>
        <SelectTrigger aria-label="Voice" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole("combobox", { name: "Voice" });
    expect(trigger.textContent).toContain("Alpha");
    fireEvent.click(trigger);
    expect(hasOpenLayer()).toBe(true);
    pickOption(screen.getByRole("option", { name: "Beta" }));
    expect(onValueChange.mock.calls[0]?.[0]).toBe("b");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

/** A dialog with a select in it: one popup open over another. */
function Nested() {
  return (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Rename</DialogTitle>
        <Select items={{ a: "Alpha", b: "Beta" }} defaultValue="a">
          <SelectTrigger aria-label="Kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="a">Alpha</SelectItem>
            <SelectItem value="b">Beta</SelectItem>
          </SelectContent>
        </Select>
      </DialogContent>
    </Dialog>
  );
}

describe("a popup open in another", () => {
  it("closes alone on Escape, the one under it staying open", async () => {
    render(<Nested />);
    await settle();
    fireEvent.click(screen.getByRole("combobox", { name: "Kind" }));
    // The two know of each other a frame after the inner one opens.
    await settle();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Rename" })).toBeTruthy();
    expect(hasOpenLayer()).toBe(true);
  });

  it("closes alone on an Escape a slide preview hands over", async () => {
    render(<Nested />);
    await settle();
    fireEvent.click(screen.getByRole("combobox", { name: "Kind" }));
    await settle();
    act(() => {
      dismissTopLayer();
    });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Rename" })).toBeTruthy();
  });
});

describe("DarkScope", () => {
  it("makes what opens from a dark part of the app dark too, though it opens outside it", async () => {
    render(
      <>
        <DarkScope>
          <div className="dark" data-testid="chrome">
            <Button size="icon" tooltip="Pen" shortcut="p" />
            <Popover>
              <PopoverTrigger>Timer</PopoverTrigger>
              <PopoverContent aria-label="Timer settings">Times</PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger>More</DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>End show</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Dialog>
              <DialogTrigger>Keys</DialogTrigger>
              <DialogContent>
                <DialogTitle>Keys while presenting</DialogTitle>
              </DialogContent>
            </Dialog>
          </div>
        </DarkScope>
        <Button size="icon" tooltip="Bold" />
      </>,
    );
    const chrome = screen.getByTestId("chrome");
    const dark = (popup: Element | null) => {
      expect(popup).toBeTruthy();
      expect(chrome.contains(popup)).toBe(false);
      return popup?.classList.contains("dark");
    };
    fireEvent.focus(screen.getByRole("button", { name: "Pen" }));
    expect(dark(document.querySelector("[data-slot=tooltip-content]"))).toBe(true);
    fireEvent.blur(screen.getByRole("button", { name: "Pen" }));
    fireEvent.click(screen.getByRole("button", { name: "Timer" }));
    expect(dark(screen.getByRole("dialog", { name: "Timer settings" }))).toBe(true);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(dark(screen.getByRole("menu"))).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    expect(dark(screen.getByRole("dialog", { name: "Keys while presenting" }))).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Keys while presenting" }), { key: "Escape" });
    // Anywhere else, a popup follows the app's theme.
    fireEvent.focus(screen.getByRole("button", { name: "Bold" }));
    expect(dark(document.querySelector("[data-slot=tooltip-content]"))).toBe(false);
  });
});

describe("the form controls", () => {
  it("are named by their label, and say what they hold in ARIA", () => {
    const onSwitch = vi.fn();
    const onCheck = vi.fn();
    render(
      <>
        <Field>
          <FieldLabel htmlFor="width">Width</FieldLabel>
          <Input id="width" size="sm" defaultValue="12" />
        </Field>
        <Switch aria-label="Loop" checked={false} onCheckedChange={onSwitch} />
        <Checkbox aria-label="Hidden" checked onCheckedChange={onCheck} />
      </>,
    );
    const input = screen.getByLabelText("Width") as HTMLInputElement;
    expect(input.dataset.size).toBe("sm");
    expect(input.hasAttribute("size")).toBe(false);
    const toggle = screen.getByRole("switch", { name: "Loop" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onSwitch.mock.calls[0]?.[0]).toBe(true);
    const box = screen.getByRole("checkbox", { name: "Hidden" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(box);
    expect(onCheck.mock.calls[0]?.[0]).toBe(false);
  });

  it("slides through a range input, hidden until it is laid out", () => {
    const onValueChange = vi.fn();
    render(<Slider aria-label="Volume" value={40} onValueChange={onValueChange} />);
    const [range] = screen.getAllByRole("slider", { hidden: true });
    fireEvent.change(range as Element, { target: { value: "60" } });
    expect(onValueChange.mock.calls[0]?.[0]).toBe(60);
  });

  it("draws one thumb for a single value, and two for a range or for no value at all", () => {
    const thumbs = (slider: React.ReactElement) => {
      const { container, unmount } = render(slider);
      const count = container.querySelectorAll("[data-slot=slider-thumb]").length;
      unmount();
      return count;
    };
    expect(thumbs(<Slider aria-label="Volume" value={40} />)).toBe(1);
    expect(thumbs(<Slider aria-label="Volume" defaultValue={40} />)).toBe(1);
    expect(thumbs(<Slider aria-label="Volume" value={[40]} />)).toBe(1);
    expect(thumbs(<Slider aria-label="Volume" value={[20, 60]} />)).toBe(2);
    expect(thumbs(<Slider aria-label="Volume" />)).toBe(2);
  });

  it("picks one of a toggle group, as a list of what is pressed", () => {
    const onValueChange = vi.fn();
    render(
      <ToggleGroup aria-label="Align" size="xs" value={["left"]} onValueChange={onValueChange}>
        <ToggleGroupItem value="left" aria-label="Left" />
        <ToggleGroupItem value="right" aria-label="Right" />
      </ToggleGroup>,
    );
    expect(screen.getByRole("group", { name: "Align" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Left" }).getAttribute("aria-pressed")).toBe("true");
    expect(classes(screen.getByRole("button", { name: "Right" }))).toContain("h-6");
    fireEvent.click(screen.getByRole("button", { name: "Right" }));
    expect(onValueChange.mock.calls[0]?.[0]).toEqual(["right"]);
    // Pressing the one that is on turns it off: a group that always has one ignores the empty list.
    fireEvent.click(screen.getByRole("button", { name: "Left" }));
    expect(onValueChange.mock.calls[1]?.[0]).toEqual([]);
  });
});

describe("Attachment", () => {
  it("has a chip size: one line as wide as its name, with its icon in its own color", () => {
    render(
      <Attachment size="chip" data-testid="chip">
        <AttachmentMedia data-testid="icon">
          <svg />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>notes.md</AttachmentTitle>
        </AttachmentContent>
      </Attachment>,
    );
    const chip = screen.getByTestId("chip");
    expect(chip.dataset.size).toBe("chip");
    const classes = chip.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["h-6", "min-w-0", "max-w-full", "bg-transparent"]));
    // Not the least width of a row of an attachment list, which comes with the orientation.
    expect(classes).not.toContain("min-w-40");
    expect(screen.getByTestId("icon").className).toContain("group-data-[size=chip]/attachment:text-current");
  });
});

describe("NativeSelect", () => {
  it("is a real select, as small as the small input beside it", () => {
    const onChange = vi.fn();
    render(
      <NativeSelect size="sm" aria-label="Unit" value="px" onChange={(event) => onChange(event.target.value)}>
        <NativeSelectOption value="px">px</NativeSelectOption>
        <NativeSelectOption value="cm">cm</NativeSelectOption>
      </NativeSelect>,
    );
    const select = screen.getByRole("combobox", { name: "Unit" });
    expect(select.tagName).toBe("SELECT");
    expect(select.className).toContain("data-[size=sm]:text-xs");
    fireEvent.change(select, { target: { value: "cm" } });
    expect(onChange).toHaveBeenCalledWith("cm");
  });
});

describe("Tabs", () => {
  it("stops Tab at the selected tab, moves with the arrows, and picks on a click", async () => {
    const onValueChange = vi.fn();
    render(
      <Tabs value="view" onValueChange={onValueChange}>
        <TabsList aria-label="Mode">
          <TabsTrigger value="view">View</TabsTrigger>
          <TabsTrigger value="edit">Edit</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole("tablist", { name: "Mode" })).toBeTruthy();
    const [view, edit] = screen.getAllByRole("tab") as [HTMLElement, HTMLElement];
    expect([view.getAttribute("aria-selected"), edit.getAttribute("aria-selected")]).toEqual(["true", "false"]);
    expect([view.tabIndex, edit.tabIndex]).toEqual([0, -1]);
    view.focus();
    fireEvent.keyDown(view, { key: "ArrowRight" });
    await settle();
    expect(document.activeElement).toBe(edit);
    // The arrows only move the focus; a click (or Enter, or Space) picks.
    expect(onValueChange).not.toHaveBeenCalled();
    fireEvent.click(edit);
    expect(onValueChange.mock.calls[0]?.[0]).toBe("edit");
  });
});

describe("Toaster", () => {
  it("shows what is added to it, with an action and a way to dismiss it", async () => {
    const onClose = vi.fn();
    const retry = vi.fn();
    render(<Toaster />);
    act(() => {
      toast.add({
        id: "broken",
        type: "error",
        title: "It broke",
        timeout: 0,
        onClose,
        actionProps: { children: "Retry", onClick: retry },
      });
    });
    await settle();
    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText("It broke").closest("[data-slot=toast]")?.getAttribute("data-type")).toBe("error");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await settle();
    expect(screen.queryByText("It broke")).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it("takes a toast away when told to", async () => {
    render(<Toaster />);
    act(() => {
      toast.add({ id: "saved", type: "success", title: "Saved" });
    });
    await settle();
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => toast.close("saved"));
    await settle();
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
