import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { type RefObject, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DropdownPanel, dropdownPanel, Popover, useDismiss } from "./Popover";

const created: HTMLElement[] = [];
const element = () => {
  const el = document.createElement("div");
  document.body.append(el);
  created.push(el);
  return el;
};
const refTo = (el: HTMLElement | null): RefObject<HTMLElement | null> => ({ current: el });
const pressEscape = (target: Element = document.body) => fireEvent.keyDown(target, { key: "Escape" });

afterEach(() => {
  for (const el of created.splice(0)) el.remove();
  vi.restoreAllMocks();
});

describe("useDismiss", () => {
  it("closes on a press outside, not inside", () => {
    const inside = element();
    const outside = element();
    const close = vi.fn();
    renderHook(() => useDismiss(true, refTo(inside), close));
    fireEvent.pointerDown(inside);
    expect(close).not.toHaveBeenCalled();
    fireEvent.pointerDown(outside);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("treats a press in any of several elements as inside", () => {
    const button = element();
    const panel = element();
    const close = vi.fn();
    renderHook(() => useDismiss(true, [refTo(button), refTo(panel)], close));
    fireEvent.pointerDown(button);
    fireEvent.pointerDown(panel);
    expect(close).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does nothing while closed", () => {
    const close = vi.fn();
    renderHook(() => useDismiss(false, refTo(element()), close, { escape: true }));
    fireEvent.pointerDown(document.body);
    pressEscape();
    expect(close).not.toHaveBeenCalled();
  });

  it("ignores Escape unless asked to close on it", () => {
    const close = vi.fn();
    renderHook(() => useDismiss(true, refTo(element()), close));
    pressEscape();
    expect(close).not.toHaveBeenCalled();
  });

  it("closes on Escape and lets it go on without capture", () => {
    const close = vi.fn();
    const after = vi.fn();
    document.addEventListener("keydown", after);
    renderHook(() => useDismiss(true, refTo(element()), close, { escape: true }));
    pressEscape();
    expect(close).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", after);
  });

  it("listens on the window in the bubble phase without capture", () => {
    const add = vi.spyOn(window, "addEventListener");
    renderHook(() => useDismiss(true, refTo(element()), vi.fn(), { escape: true }));
    expect(add).toHaveBeenCalledWith("pointerdown", expect.any(Function), false);
    expect(add).toHaveBeenCalledWith("keydown", expect.any(Function), false);
  });

  it("with capture, sees Escape first on the document and stops it there", () => {
    const close = vi.fn();
    const inner = vi.fn();
    const target = element();
    target.addEventListener("keydown", inner);
    const add = vi.spyOn(document, "addEventListener");
    renderHook(() => useDismiss(true, refTo(element()), close, { escape: true, capture: true }));
    expect(add).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    pressEscape(target);
    expect(close).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it("calls the latest close without listening again", () => {
    const first = vi.fn();
    const second = vi.fn();
    const ref = refTo(element());
    const add = vi.spyOn(window, "addEventListener");
    const { rerender } = renderHook(({ close }) => useDismiss(true, ref, close), { initialProps: { close: first } });
    rerender({ close: second });
    fireEvent.pointerDown(document.body);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.filter(([type]) => type === "pointerdown")).toHaveLength(1);
  });

  it.each([false, true])("stops listening when closed or unmounted (capture %s)", (capture) => {
    const close = vi.fn();
    const ref = refTo(element());
    const { rerender, unmount } = renderHook(({ open }) => useDismiss(open, ref, close, { escape: true, capture }), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    fireEvent.pointerDown(document.body);
    pressEscape();
    expect(close).not.toHaveBeenCalled();
    rerender({ open: true });
    unmount();
    fireEvent.pointerDown(document.body);
    pressEscape();
    expect(close).not.toHaveBeenCalled();
  });
});

/** A button at `rect` with a popover for it. */
function Harness(props: Omit<Parameters<typeof Popover>[0], "anchor" | "children"> & { rect: DOMRect }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const { rect, ...popover } = props;
  return (
    <div data-testid="host">
      <button
        type="button"
        ref={(el) => {
          anchor.current = el;
          if (el) el.getBoundingClientRect = () => rect;
        }}
      >
        Anchor
      </button>
      <span>Elsewhere</span>
      <Popover anchor={anchor} {...popover}>
        <p>Panel content</p>
      </Popover>
    </div>
  );
}

let movingRect = new DOMRect(0, 0, 0, 0);

/** A button that can move, with a popover that follows it or not. */
function Moving(props: { follow: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        ref={(el) => {
          anchor.current = el;
          if (el) el.getBoundingClientRect = () => movingRect;
        }}
      >
        Anchor
      </button>
      <Popover anchor={anchor} placement="below" width={100} follow={props.follow} onClose={vi.fn()}>
        <p>Panel content</p>
      </Popover>
    </>
  );
}

const panel = () => screen.getByText("Panel content").parentElement as HTMLElement;

/** A popover that focuses its field. */
function Focusing() {
  const anchor = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        ref={(el) => {
          anchor.current = el;
          if (el) el.getBoundingClientRect = () => new DOMRect(0, 0, 10, 10);
        }}
      >
        Anchor
      </button>
      <Popover anchor={anchor} width={100} initialFocus={field} onClose={vi.fn()}>
        <input ref={field} aria-label="Field" />
      </Popover>
    </>
  );
}

describe("Popover", () => {
  // jsdom's window is 1024 by 768.
  it("renders its children below the anchor, kept on screen", () => {
    render(<Harness rect={new DOMRect(1000, 100, 20, 20)} placement="below" width={300} onClose={vi.fn()} />);
    expect(screen.getByText("Panel content")).toBeTruthy();
    const style = panel().style;
    expect([style.left, style.top, style.width, style.bottom]).toEqual(["716px", "126px", "300px", ""]);
    expect(style.maxHeight).toBe(`${768 - 120 - 16}px`);
  });

  it("lines its right edge up with the anchor's when aligned to the end, kept on screen", () => {
    const { unmount } = render(
      <Harness rect={new DOMRect(500, 100, 40, 20)} placement="below" align="end" width={300} onClose={vi.fn()} />,
    );
    expect(panel().style.left).toBe(`${540 - 300}px`);
    unmount();
    render(<Harness rect={new DOMRect(20, 100, 40, 20)} placement="below" align="end" width={300} onClose={vi.fn()} />);
    expect(panel().style.left).toBe("8px");
  });

  it("opens above the anchor when asked", () => {
    render(<Harness rect={new DOMRect(40, 700, 20, 20)} placement="above" width={200} onClose={vi.fn()} />);
    const style = panel().style;
    expect([style.left, style.bottom, style.top, style.maxHeight]).toEqual(["40px", `${768 - 700 + 6}px`, "", "684px"]);
  });

  it("takes the side with more room on auto, with the menu's gap", () => {
    const { unmount } = render(
      <Harness rect={new DOMRect(40, 600, 20, 20)} variant="menu" width={200} onClose={vi.fn()} />,
    );
    expect(panel().style.bottom).toBe(`${768 - 600 + 8}px`);
    unmount();
    render(<Harness rect={new DOMRect(40, 50, 20, 20)} variant="menu" width={200} onClose={vi.fn()} />);
    expect(panel().style.top).toBe("78px");
  });

  it("names itself a dialog only with a label", () => {
    const { unmount } = render(
      <Harness rect={new DOMRect(0, 0, 10, 10)} placement="below" width={100} label="Replace" onClose={vi.fn()} />,
    );
    expect(screen.getByRole("dialog", { name: "Replace" })).toBe(panel());
    unmount();
    render(<Harness rect={new DOMRect(0, 0, 10, 10)} width={100} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on a press outside, not on the panel or the anchor", () => {
    const onClose = vi.fn();
    render(<Harness rect={new DOMRect(0, 0, 10, 10)} width={100} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText("Panel content"));
    fireEvent.pointerDown(screen.getByText("Anchor"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText("Elsewhere"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<Harness rect={new DOMRect(0, 0, 10, 10)} width={100} onClose={onClose} />);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays in place, or with a portal goes into the body", () => {
    const { unmount } = render(<Harness rect={new DOMRect(0, 0, 10, 10)} width={100} onClose={vi.fn()} />);
    expect(screen.getByTestId("host").contains(panel())).toBe(true);
    unmount();
    render(<Harness rect={new DOMRect(0, 0, 10, 10)} width={100} portal onClose={vi.fn()} />);
    expect(screen.getByTestId("host").contains(panel())).toBe(false);
    expect(panel().parentElement).toBe(document.body);
  });

  it("focuses what it is given once it is placed, and again if something takes the focus away", async () => {
    render(<Focusing />);
    const field = screen.getByRole("textbox", { name: "Field" });
    expect(document.activeElement).toBe(field);
    screen.getByText("Anchor").focus();
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  it("follows the anchor on resize only when asked", () => {
    movingRect = new DOMRect(10, 10, 10, 10);
    const { unmount } = render(<Moving follow={false} />);
    movingRect = new DOMRect(50, 10, 10, 10);
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(panel().style.left).toBe("10px");
    unmount();
    movingRect = new DOMRect(10, 10, 10, 10);
    render(<Moving follow />);
    movingRect = new DOMRect(50, 10, 10, 10);
    act(() => void window.dispatchEvent(new Event("resize")));
    expect(panel().style.left).toBe("50px");
  });
});

describe("DropdownPanel", () => {
  it("drops down centered under its button, with the site's layout", () => {
    render(
      <DropdownPanel role="dialog" aria-label="Spacing" className="grid w-max">
        content
      </DropdownPanel>,
    );
    const el = screen.getByRole("dialog", { name: "Spacing" });
    for (const name of [...dropdownPanel.split(" "), "grid", "w-max"]) expect(el.classList).toContain(name);
  });
});
