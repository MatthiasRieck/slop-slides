import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EditToolbar } from "./EditToolbar";

const SECTIONS = ["Insert", "Text", "Paragraph", "Style", "Arrange"];
const SECTION_WIDTH = 200;

let resize: ResizeObserverCallback | null = null;
let ribbonWidth = 0;
const NoLayout = globalThis.ResizeObserver;

function toolbar(overrides: Partial<Parameters<typeof EditToolbar>[0]> = {}) {
  return (
    <EditToolbar
      sizeMode="resize"
      onSizeMode={() => {}}
      tool="select"
      selection={null}
      styles={{ text: {}, shape: {}, line: {} } as never}
      onTool={() => {}}
      onStyle={() => {}}
      onOrder={() => {}}
      onDelete={() => {}}
      {...overrides}
    />
  );
}

/** Lays the ribbon out `width` pixels wide. */
function widen(width: number) {
  ribbonWidth = width;
  act(() => resize?.([], {} as ResizeObserver));
}

const collapsedButton = (section: string) => screen.queryByRole("button", { name: `${section} tools` });

describe("EditToolbar ribbon", () => {
  beforeEach(() => {
    resize = null;
    ribbonWidth = 0;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(SECTION_WIDTH);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => ribbonWidth);
  });

  afterEach(() => {
    globalThis.ResizeObserver = NoLayout;
    vi.restoreAllMocks();
  });

  it("groups its tools in captioned sections", () => {
    render(toolbar());
    for (const name of SECTIONS) within(screen.getByRole("group", { name })).getByText(name);
    const inGroup = (group: string, tool: string) =>
      within(screen.getByRole("group", { name: group })).getByRole("button", { name: tool });
    expect(inGroup("Insert", "Add an image from a file")).toBeTruthy();
    expect(inGroup("Text", "Bold (⌘B)")).toBeTruthy();
    expect(inGroup("Paragraph", "Bulleted list (Tab indents, Shift+Tab outdents)")).toBeTruthy();
    expect(inGroup("Style", "Fill")).toBeTruthy();
    expect(inGroup("Arrange", "Delete (⌫)")).toBeTruthy();
  });

  it("keeps every section open while there is room, and with no layout to go by", () => {
    render(toolbar());
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
    widen(5000);
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
  });

  it("collapses sections to an icon from the right as it narrows, and opens them again as it widens", () => {
    render(toolbar());
    widen(4 * SECTION_WIDTH);
    expect(collapsedButton("Arrange")).toBeTruthy();
    expect(collapsedButton("Style")).toBeTruthy();
    expect(collapsedButton("Paragraph")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete (⌫)" })).toBeNull();

    widen(100);
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeTruthy();

    widen(5000);
    for (const name of SECTIONS) expect(collapsedButton(name)).toBeNull();
    expect(screen.getByRole("button", { name: "Delete (⌫)" })).toBeTruthy();
  });

  it("opens a collapsed section's tools from its icon, working as they do in the ribbon", () => {
    const onOrder = vi.fn();
    render(toolbar({ onOrder, selection: { kind: "element" } as never }));
    widen(100);
    expect(screen.queryByRole("button", { name: "Bring to front" })).toBeNull();

    fireEvent.click(collapsedButton("Arrange")!);
    expect(collapsedButton("Arrange")!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Bring to front" }));
    expect(onOrder).toHaveBeenCalledWith("front");
    expect(screen.getByRole("button", { name: "Bring to front" })).toBeTruthy();

    fireEvent.click(collapsedButton("Arrange")!);
    expect(screen.queryByRole("button", { name: "Bring to front" })).toBeNull();
  });

  it("closes a section's flyout on a press outside it", () => {
    render(toolbar());
    widen(100);
    fireEvent.click(collapsedButton("Text")!);
    fireEvent.pointerDown(screen.getByRole("group", { name: "Text" }));
    expect(collapsedButton("Text")!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);
    expect(collapsedButton("Text")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes a section's flyout when a tool is picked, to get out of the way of the slide", () => {
    const { rerender } = render(toolbar());
    widen(100);
    fireEvent.click(collapsedButton("Insert")!);
    rerender(toolbar({ tool: "rect" }));
    expect(collapsedButton("Insert")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("drops the flyout when its section has room again", () => {
    render(toolbar());
    widen(100);
    fireEvent.click(collapsedButton("Style")!);
    widen(5000);
    widen(100);
    expect(collapsedButton("Style")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a flyout inside the bar around the ribbon", async () => {
    const { container } = render(<div>{toolbar()}</div>);
    const rect = (left: number, right: number) => ({ left, right }) as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.matches("[data-flyout]") ? rect(400, 620) : rect(0, 500);
    });
    widen(100);
    await act(async () => {});
    expect(container.querySelector<HTMLElement>("[data-flyout]")!.style.marginLeft).toBe("-124px");
  });
});
