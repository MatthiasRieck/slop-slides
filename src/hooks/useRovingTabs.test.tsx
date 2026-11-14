import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { useRovingTabs } from "./useRovingTabs";

function Tabs(props: { vertical?: boolean; initial?: string | null; names?: string[] }) {
  const [selected, setSelected] = useState(props.initial === undefined ? "Edit" : props.initial);
  const tabs = useRovingTabs(props.vertical ? "vertical" : "horizontal");
  return (
    <div role="tablist" {...tabs}>
      {(props.names ?? ["View", "Edit", "Git"]).map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          aria-selected={selected === name}
          disabled={name === "Off"}
          onClick={() => setSelected(name)}
        >
          {name}
        </button>
      ))}
      <button type="button">Not a tab</button>
    </div>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });
const stops = () => screen.getAllByRole("tab").map((element) => element.tabIndex);
const focused = () => document.activeElement?.textContent;
const key = (name: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement!, { key: name, ...init });

describe("useRovingTabs", () => {
  it("lets Tab stop at the selected tab only, following the selection", () => {
    render(<Tabs />);
    expect(stops()).toEqual([-1, 0, -1]);
    fireEvent.click(tab("Git"));
    expect(stops()).toEqual([-1, -1, 0]);
  });

  it("stops at the first tab when none is selected", () => {
    render(<Tabs initial={null} />);
    expect(stops()).toEqual([0, -1, -1]);
  });

  it("moves the focus with the arrows, round again, and to the ends, picking nothing", () => {
    render(<Tabs />);
    tab("Edit").focus();
    key("ArrowRight");
    expect(focused()).toBe("Git");
    key("ArrowRight");
    expect(focused()).toBe("View");
    key("ArrowLeft");
    expect(focused()).toBe("Git");
    key("Home");
    expect(focused()).toBe("View");
    key("End");
    expect(focused()).toBe("Git");
    // The focused tab is picked as a click picks it, which Enter and Space make of a button.
    expect(tab("Edit").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab("Git"));
    expect(tab("Git").getAttribute("aria-selected")).toBe("true");
  });

  it("takes ↑ and ↓ in a vertical list, and leaves ← and → alone there", () => {
    render(<Tabs vertical />);
    tab("Edit").focus();
    key("ArrowRight");
    expect(focused()).toBe("Edit");
    key("ArrowDown");
    expect(focused()).toBe("Git");
    key("ArrowUp");
    expect(focused()).toBe("Edit");
  });

  it("passes over a tab that is off", () => {
    render(<Tabs names={["View", "Off", "Git"]} initial="View" />);
    tab("View").focus();
    key("ArrowRight");
    expect(focused()).toBe("Git");
  });

  it("keeps its arrows from the page, and leaves shortcuts and the other controls in the list alone", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    render(<Tabs />);
    tab("Edit").focus();
    const arrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    tab("Edit").dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    expect(page).not.toHaveBeenCalled();
    key("ArrowLeft", { metaKey: true });
    expect(focused()).toBe("Git");
    screen.getByText("Not a tab").focus();
    key("ArrowRight");
    expect(focused()).toBe("Not a tab");
    expect(page).toHaveBeenCalledTimes(2);
    window.removeEventListener("keydown", page);
  });
});
