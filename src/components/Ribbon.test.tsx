import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Bold, Type } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { hasOpenLayer } from "../lib/layers";
import { tooltipOf } from "../test/ui";
import { RibbonRow, RibbonSection, RibbonSelect, RibbonToggle, useRibbonReveal } from "./Ribbon";

/** A tool that asks its section to show it, as the search field does on its shortcut. */
function Reveal() {
  const reveal = useRibbonReveal();
  return (
    <button type="button" onClick={reveal}>
      reveal
    </button>
  );
}

/** A section with a tool, a tool that opens a popover, and something beside the ribbon. */
function Section(props: { collapsed: boolean; closeOn?: unknown }) {
  return (
    <>
      <RibbonSection title="Text" icon={<Type />} collapsed={props.collapsed} closeOn={props.closeOn}>
        <RibbonRow>
          <button type="button">Bold</button>
          <Reveal />
          <Popover>
            <PopoverTrigger>More</PopoverTrigger>
            <PopoverContent aria-label="More text tools">
              <button type="button">Strike</button>
            </PopoverContent>
          </Popover>
        </RibbonRow>
      </RibbonSection>
      <button type="button">beside</button>
    </>
  );
}

const section = () => screen.getByRole("group", { name: "Text" });
const opener = () => screen.getByRole("button", { name: "Text tools" });
const body = () => section().querySelector<HTMLElement>("[data-ribbon-body]")!;
/** Whether the section's tools show: always, unless it is collapsed with its flyout closed. */
const toolsShow = () => body().style.visibility !== "hidden";
const pressOn = (element: Element) => fireEvent.pointerDown(element, { pointerType: "mouse", button: 0 });

describe("RibbonSection", () => {
  it("is a group named by its title, its tools in it, with no button to open them while it fits", () => {
    render(<Section collapsed={false} />);
    expect(within(section()).getByRole("button", { name: "Bold" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Text tools" })).toBeNull();
    expect(toolsShow()).toBe(true);
    expect(body().hasAttribute("data-flyout")).toBe(false);
    // Its caption, under the tools.
    expect(body().lastElementChild!.textContent).toBe("Text");
  });

  it("collapses to a button, its tools still in the page to be measured, out of sight", () => {
    render(<Section collapsed />);
    expect(opener().getAttribute("aria-expanded")).toBe("false");
    expect(tooltipOf(opener())).toBe("Text");
    expect(within(section()).getByText("Bold")).toBeTruthy();
    expect(toolsShow()).toBe(false);
    expect(hasOpenLayer()).toBe(false);
  });

  it("opens its tools in a flyout on a press of the button, and closes them on another", () => {
    render(<Section collapsed />);
    fireEvent.click(opener());
    expect(opener().getAttribute("aria-expanded")).toBe("true");
    expect(toolsShow()).toBe(true);
    expect(body().hasAttribute("data-flyout")).toBe(true);
    fireEvent.click(opener());
    expect(opener().getAttribute("aria-expanded")).toBe("false");
    expect(toolsShow()).toBe(false);
  });

  it("leaves the focus where it is when its button is pressed, for the tools that work on the slide", () => {
    render(<Section collapsed />);
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    opener().dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it("stays open on a press inside it, and closes on a press outside", () => {
    render(<Section collapsed />);
    fireEvent.click(opener());
    pressOn(screen.getByText("Bold"));
    expect(toolsShow()).toBe(true);
    pressOn(screen.getByText("beside"));
    expect(toolsShow()).toBe(false);
  });

  it("stays open on a press in a popover one of its tools opened, which is in the body", () => {
    render(<Section collapsed />);
    fireEvent.click(opener());
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const strike = screen.getByRole("button", { name: "Strike" });
    expect(section().contains(strike)).toBe(false);
    pressOn(strike);
    expect(toolsShow()).toBe(true);
    expect(screen.getByRole("dialog", { name: "More text tools" })).toBeTruthy();
  });

  it("closes on Escape, keeping the key from what is under it", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    render(<Section collapsed />);
    fireEvent.click(opener());
    expect(hasOpenLayer()).toBe(true);
    act(() => void fireEvent.keyDown(document.body, { key: "Escape" }));
    expect(toolsShow()).toBe(false);
    expect(hasOpenLayer()).toBe(false);
    expect(page).not.toHaveBeenCalled();
    window.removeEventListener("keydown", page);
  });

  it("closes on a press in a slide preview, which never reaches this window", () => {
    render(
      <>
        <Section collapsed />
        <iframe title="slide" />
      </>,
    );
    fireEvent.click(opener());
    const frame = document.querySelector("iframe")!;
    // From somewhere else, it is not a press in the app.
    act(() => void window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:press" }, source: window })));
    expect(toolsShow()).toBe(true);
    act(
      () =>
        void window.dispatchEvent(
          new MessageEvent("message", { data: { type: "slop:press" }, source: frame.contentWindow }),
        ),
    );
    expect(toolsShow()).toBe(false);
  });

  it("closes when what it watches changes, as a tool that goes on to work on the slide is picked", () => {
    const { rerender } = render(<Section collapsed closeOn="select" />);
    fireEvent.click(opener());
    expect(toolsShow()).toBe(true);
    rerender(<Section collapsed closeOn="text" />);
    expect(toolsShow()).toBe(false);
  });

  it("is closed again once it fits, and collapses closed", () => {
    const { rerender } = render(<Section collapsed />);
    fireEvent.click(opener());
    rerender(<Section collapsed={false} />);
    expect(screen.queryByRole("button", { name: "Text tools" })).toBeNull();
    expect(toolsShow()).toBe(true);
    rerender(<Section collapsed />);
    expect(opener().getAttribute("aria-expanded")).toBe("false");
    expect(toolsShow()).toBe(false);
  });

  it("shows its tools at once when one of them asks to be revealed", () => {
    render(<Section collapsed />);
    expect(toolsShow()).toBe(false);
    fireEvent.click(screen.getByText("reveal"));
    expect(toolsShow()).toBe(true);
    expect(opener().getAttribute("aria-expanded")).toBe("true");
  });

  it("reveals nothing outside a ribbon", () => {
    render(<Reveal />);
    expect(() => fireEvent.click(screen.getByText("reveal"))).not.toThrow();
  });
});

describe("RibbonSelect", () => {
  const select = (name: string) => screen.getByRole("combobox", { name }) as HTMLSelectElement;
  const options = (
    <>
      <option value="12">12</option>
      <option value="24">24</option>
    </>
  );

  it("is a list named by its label, which is its tooltip too", () => {
    render(
      <RibbonSelect label="Font size" value="12" onPick={() => {}}>
        {options}
      </RibbonSelect>,
    );
    expect(select("Font size").value).toBe("12");
    expect(select("Font size").title).toBe("Font size");
    expect(Array.from(select("Font size").options).map((option) => option.value)).toEqual(["12", "24"]);
  });

  it("hands the pick over, then the focus back", () => {
    const calls: string[] = [];
    render(
      <RibbonSelect
        label="Font size"
        value="12"
        onPick={(value) => calls.push(`pick ${value}`)}
        onDone={() => calls.push("done")}
      >
        {options}
      </RibbonSelect>,
    );
    fireEvent.change(select("Font size"), { target: { value: "24" } });
    expect(calls).toEqual(["pick 24", "done"]);
  });

  it("says what it waits for while it is off, and a tooltip of its own otherwise", () => {
    const { rerender } = render(
      <RibbonSelect
        label="Font size"
        title="The size of the text"
        disabled
        disabledReason="Select some text"
        onPick={() => {}}
      >
        {options}
      </RibbonSelect>,
    );
    expect(select("Font size").disabled).toBe(true);
    expect(select("Font size").title).toBe("Select some text");
    rerender(
      <RibbonSelect label="Font size" title="The size of the text" disabledReason="Select some text" onPick={() => {}}>
        {options}
      </RibbonSelect>,
    );
    expect(select("Font size").title).toBe("The size of the text");
  });

  it("is as wide as it is told to be, the list filling its box", () => {
    render(
      <RibbonSelect label="Font size" className="w-24" onPick={() => {}}>
        {options}
      </RibbonSelect>,
    );
    const box = select("Font size").parentElement!;
    expect(box.getAttribute("data-slot")).toBe("native-select-wrapper");
    expect(box.classList.contains("w-24")).toBe(true);
    expect(select("Font size").className).toContain("w-full");
  });
});

describe("RibbonToggle", () => {
  it("is a button named by its label, with what it shows beside its icon, and its label as its tooltip", () => {
    const onClick = vi.fn();
    render(
      <RibbonToggle label="Make the text bold" onClick={onClick}>
        <Bold />
        Bold
      </RibbonToggle>,
    );
    const button = screen.getByRole("button", { name: "Make the text bold" });
    expect(button.textContent).toBe("Bold");
    expect(button.hasAttribute("aria-pressed")).toBe(false);
    expect(tooltipOf(button)).toBe("Make the text bold");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("is pressed while the choice it stands for is the one made", () => {
    const { rerender } = render(
      <RibbonToggle label="Bold" active onClick={() => {}}>
        Bold
      </RibbonToggle>,
    );
    expect(screen.getByRole("button", { name: "Bold", pressed: true })).toBeTruthy();
    rerender(
      <RibbonToggle label="Bold" active={false} onClick={() => {}}>
        Bold
      </RibbonToggle>,
    );
    expect(screen.getByRole("button", { name: "Bold", pressed: false })).toBeTruthy();
  });

  it("is off while disabled, and does nothing", () => {
    const onClick = vi.fn();
    render(
      <RibbonToggle label="Bold" disabled onClick={onClick}>
        Bold
      </RibbonToggle>,
    );
    const button = screen.getByRole("button", { name: "Bold" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
