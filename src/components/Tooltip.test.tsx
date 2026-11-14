import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button, ToolButton } from "./Button";
import { placeTip, TOOLTIP_DELAY_MS, TOOLTIP_WARM_MS, Tooltips, tipText } from "./Tooltip";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const tip = () => screen.queryByRole("tooltip");
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const button = (name: string) => screen.getByRole("button", { name });
/** Rests the pointer on `element` until its tooltip shows. */
function rest(element: Element) {
  fireEvent.pointerOver(element);
  wait(TOOLTIP_DELAY_MS);
}
/** Moves the focus to `element` with the Tab key, as the browser does. */
function tabTo(element: HTMLElement) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
  act(() => element.focus());
}

function Toolbar() {
  const [muted, setMuted] = useState(false);
  return (
    <>
      <ToolButton label="Bold" shortcut="mod+b" />
      <ToolButton label="Italic" shortcut="mod+i" />
      <ToolButton label="Group" shortcut="mod+g" disabled disabledReason="Select two or more elements" />
      <ToolButton label={muted ? "Unmute" : "Mute"} onClick={() => setMuted(!muted)} />
      <Button title="Start the show" shortcut="mod+enter">
        Present
      </Button>
      <span title="deck.html, in /decks/pitch">deck.html</span>
      <iframe title="Slide 3" />
      <p>Plain text</p>
      <Tooltips />
    </>
  );
}

/** A control that can be taken away while its tooltip shows. */
function Passing() {
  const [there, setThere] = useState(true);
  return (
    <>
      {there && <ToolButton label="Dismiss" />}
      <button type="button" onClick={() => setThere(false)}>
        Remove
      </button>
      <Tooltips />
    </>
  );
}

describe("Tooltips", () => {
  it("shows a control's label and its keys once the pointer has rested on it", () => {
    render(<Toolbar />);
    fireEvent.pointerOver(button("Bold"));
    wait(TOOLTIP_DELAY_MS - 1);
    expect(tip()).toBeNull();
    wait(1);
    expect(tip()!.textContent).toBe("BoldCtrl+B");
    // The keys are set apart from the label, not in brackets after it.
    expect(tip()!.querySelector("kbd")!.textContent).toBe("Ctrl+B");
    // Over everything, for the eye only, in the body.
    expect(tip()!.classList.contains("z-tooltip")).toBe(true);
    expect(tip()!.classList.contains("pointer-events-none")).toBe(true);
    expect(document.body.contains(tip())).toBe(true);
  });

  it("keeps the browser's own tooltip away while the pointer is on the control, and the name as it is", () => {
    render(<Toolbar />);
    const bold = button("Bold");
    expect(bold.getAttribute("title")).toBe("Bold (Ctrl+B)");
    fireEvent.pointerOver(bold);
    expect(bold.hasAttribute("title")).toBe(false);
    expect(bold.getAttribute("aria-label")).toBe("Bold");
    wait(TOOLTIP_DELAY_MS);
    fireEvent.pointerOver(screen.getByText("Plain text"));
    expect(tip()).toBeNull();
    expect(bold.getAttribute("title")).toBe("Bold (Ctrl+B)");
  });

  it("does not show when the pointer only passes over", () => {
    render(<Toolbar />);
    fireEvent.pointerOver(button("Bold"));
    wait(TOOLTIP_DELAY_MS / 2);
    fireEvent.pointerOver(screen.getByText("Plain text"));
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).toBeNull();
  });

  it("shows the next control's at once after one showed, one at a time, and waits again after a while", () => {
    render(<Toolbar />);
    rest(button("Bold"));
    fireEvent.pointerOver(button("Italic"));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(tip()!.textContent).toBe("ItalicCtrl+I");
    // Just there, not fading in again.
    expect(tip()!.classList.contains("enter-fade")).toBe(false);
    fireEvent.pointerOver(screen.getByText("Plain text"));
    wait(TOOLTIP_WARM_MS);
    fireEvent.pointerOver(button("Bold"));
    expect(tip()).toBeNull();
    wait(TOOLTIP_DELAY_MS);
    expect(tip()!.classList.contains("enter-fade")).toBe(true);
  });

  it("shows at once when the keyboard moves the focus to a control, and goes when the focus leaves", () => {
    render(<Toolbar />);
    tabTo(button("Bold"));
    expect(tip()!.textContent).toBe("BoldCtrl+B");
    // The title stays where assistive tech reads it: nothing native shows on focus.
    expect(button("Bold").getAttribute("title")).toBe("Bold (Ctrl+B)");
    tabTo(button("Italic"));
    expect(tip()!.textContent).toBe("ItalicCtrl+I");
    act(() => button("Italic").blur());
    expect(tip()).toBeNull();
  });

  it("does not show for a focus the keyboard did not move: a click, or a dialog taking it", () => {
    render(<Toolbar />);
    act(() => button("Bold").focus());
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).toBeNull();
  });

  it("goes away on a press, and stays away until the pointer has left the control", () => {
    render(<Toolbar />);
    const mute = button("Mute");
    rest(mute);
    fireEvent.pointerDown(mute);
    expect(tip()).toBeNull();
    fireEvent.click(mute);
    // Still on it, over the icon inside or not.
    fireEvent.pointerOver(mute);
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).toBeNull();
    fireEvent.pointerOver(screen.getByText("Plain text"));
    rest(mute);
    expect(tip()!.textContent).toBe("Unmute");
  });

  it("goes away on Escape or any other key, and when something scrolls", () => {
    render(<Toolbar />);
    rest(button("Bold"));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(tip()).toBeNull();
    expect(button("Bold").getAttribute("title")).toBe("Bold (Ctrl+B)");
    fireEvent.pointerOver(screen.getByText("Plain text"));
    rest(button("Italic"));
    fireEvent.scroll(document.body);
    expect(tip()).toBeNull();
    // A tooltip that was only waiting does not show after either.
    fireEvent.pointerOver(screen.getByText("Plain text"));
    fireEvent.pointerOver(button("Bold"));
    fireEvent.scroll(document.body);
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).toBeNull();
  });

  it("goes away when the pointer leaves the window", () => {
    render(<Toolbar />);
    rest(button("Bold"));
    fireEvent.pointerOut(button("Bold"), { relatedTarget: null });
    expect(tip()).toBeNull();
  });

  it("says why a disabled control is disabled, under its name", () => {
    render(<Toolbar />);
    const group = button("Group");
    expect(group.getAttribute("title")).toBe("Select two or more elements");
    rest(group);
    expect([...tip()!.children].map((line) => line.textContent)).toEqual(["Group", "Select two or more elements"]);
  });

  it("follows a title that changes under the pointer", async () => {
    render(<Toolbar />);
    const mute = button("Mute");
    rest(mute);
    expect(tip()!.textContent).toBe("Mute");
    // Changed by something else than a press (the keyboard's shortcut, say).
    await act(async () => mute.setAttribute("title", "Unmute"));
    expect(tip()!.textContent).toBe("Unmute");
    // Still out of the browser's sight.
    expect(mute.hasAttribute("title")).toBe(false);
  });

  it("gives a text button's title and anything else with a title the same tooltip", () => {
    render(<Toolbar />);
    rest(button("Present"));
    expect(tip()!.textContent).toBe("Start the showCtrl+Enter");
    fireEvent.pointerOver(screen.getByText("deck.html"));
    expect(tip()!.textContent).toBe("deck.html, in /decks/pitch");
  });

  it("leaves a frame's title alone: it names the frame", () => {
    render(<Toolbar />);
    const frame = screen.getByTitle("Slide 3");
    rest(frame);
    expect(tip()).toBeNull();
    expect(frame.getAttribute("title")).toBe("Slide 3");
  });

  it("ignores a finger: there is nothing to rest", () => {
    render(<Toolbar />);
    fireEvent.pointerOver(button("Bold"), { pointerType: "touch" });
    wait(TOOLTIP_DELAY_MS);
    expect(tip()).toBeNull();
  });

  it("goes away when its control does", () => {
    render(<Passing />);
    rest(button("Dismiss"));
    expect(tip()).not.toBeNull();
    act(() => button("Remove").click());
    wait(500);
    expect(tip()).toBeNull();
  });

  it("is dark where the app stays dark, whatever the theme", () => {
    render(
      <div className="dark">
        <ToolButton variant="presenter" label="Pen" />
        <Tooltips />
      </div>,
    );
    rest(button("Pen"));
    expect(tip()!.parentElement!.classList.contains("dark")).toBe(true);
  });

  it("stops watching once unmounted, giving a held title back", () => {
    const { unmount } = render(<Toolbar />);
    const bold = button("Bold");
    const detached = bold.cloneNode(true) as HTMLElement;
    fireEvent.pointerOver(bold);
    expect(bold.hasAttribute("title")).toBe(false);
    document.body.append(detached);
    unmount();
    fireEvent.pointerOver(detached);
    expect(detached.getAttribute("title")).toBe("Bold (Ctrl+B)");
    detached.remove();
  });
});

describe("tipText", () => {
  it("takes the keys out of the title they end", () => {
    expect(tipText("Group (⌘G)", "⌘G", null)).toEqual({ text: "Group", keys: "⌘G", reason: null });
    expect(tipText("Group", null, null)).toEqual({ text: "Group", keys: null, reason: null });
    // Keys the title does not end with are not the title's.
    expect(tipText("Group", "⌘G", null)).toEqual({ text: "Group", keys: null, reason: null });
  });

  it("names a disabled control, with its title as the reason", () => {
    expect(tipText("Select two elements", null, "Group")).toEqual({
      text: "Group",
      keys: null,
      reason: "Select two elements",
    });
    expect(tipText("Group", null, "Group")).toEqual({ text: "Group", keys: null, reason: null });
  });
});

describe("placeTip", () => {
  const view = { width: 1000, height: 600 };
  const size = { width: 100, height: 24 };

  it("centres the tooltip under its control", () => {
    expect(placeTip({ left: 400, top: 100, bottom: 124, width: 24 }, size, view)).toEqual({ left: 362, top: 130 });
  });

  it("goes over the control when there is no room under it", () => {
    expect(placeTip({ left: 400, top: 570, bottom: 594, width: 24 }, size, view)).toEqual({ left: 362, top: 540 });
  });

  it("stays inside the window at either side", () => {
    expect(placeTip({ left: 2, top: 100, bottom: 124, width: 24 }, size, view).left).toBe(4);
    expect(placeTip({ left: 980, top: 100, bottom: 124, width: 24 }, size, view).left).toBe(896);
  });

  it("stays inside the window, over a control that leaves no room above or below it", () => {
    expect(placeTip({ left: 400, top: 10, bottom: 590, width: 24 }, size, view).top).toBe(572);
  });
});
