import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A toast's dismiss button, counted: each render of the toasts renders it.
vi.mock("./Button", async (original) => {
  const actual = await original<typeof import("./Button")>();
  return { ...actual, ToolButton: vi.fn(actual.ToolButton) };
});

import { openLayer } from "../lib/layers";
import { showError, showInfo, showSuccess, useApp } from "../store";
import { ToolButton } from "./Button";
import { TOAST_AREA, TOAST_EXIT_MS, TOAST_MS, Toasts } from "./Toasts";

const texts = () => useApp.getState().toasts.map((toast) => toast.text);
const pressEscape = (target: Element | Document = document.body) => fireEvent.keyDown(target, { key: "Escape" });

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ toasts: [], presenting: false, sidebarMaximized: false });
});

/** A stand-in for the slide's area (see ../App.tsx), placed where `rect` says. */
function slideArea(rect: Partial<DOMRect>) {
  const area = document.createElement("div");
  area.setAttribute(TOAST_AREA, "");
  area.getBoundingClientRect = () => ({ ...new DOMRect(), ...rect }) as DOMRect;
  document.body.append(area);
  return area;
}
afterEach(() => vi.useRealTimers());

describe("Toasts", () => {
  it("shows nothing until there is something to say", () => {
    render(<Toasts />);
    expect(screen.queryByTestId("toasts")).toBeNull();
  });

  it("stacks them at the bottom centre over everything, the newest last", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showInfo("Imported");
    });
    const stack = screen.getByTestId("toasts");
    expect(stack.parentElement).toBe(document.body);
    for (const name of ["fixed", "left-1/2", "-translate-x-1/2", "bottom-4", "z-toast"]) {
      expect(stack.classList.contains(name)).toBe(true);
    }
    // Not at the right, where the sidebar's footer and the chat's composer are.
    expect(stack.className).not.toContain("right-");
    expect([...stack.children].map((toast) => toast.textContent)).toEqual(["disk full", "Imported"]);
  });

  it("announces errors as alerts and the rest as status, in the colors of what they mean", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showInfo("Imported");
      showSuccess("Exported");
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("disk full");
    expect(alert.className).toContain("border-destructive/30");
    expect(screen.getByText("disk full").className).toContain("text-destructive");
    const [info, success] = screen.getAllByRole("status");
    expect(info!.textContent).toBe("Imported");
    expect(info!.className).not.toContain("destructive");
    expect(success!.querySelector("svg")?.getAttribute("class")).toContain("text-success");
  });

  it("dismisses a toast with its labelled button, which has a tooltip", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showError("busy");
    });
    const dismiss = screen.getAllByRole("button", { name: "Dismiss" });
    expect(dismiss[0]!.getAttribute("title")).toBe("Dismiss");
    fireEvent.click(dismiss[0]!);
    expect(texts()).toEqual(["busy"]);
  });

  it("rises in, and sinks out for a moment once dismissed, out of reach meanwhile", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showInfo("Imported");
    });
    const cards = () => [...screen.getByTestId("toasts").children] as HTMLElement[];
    expect(cards().map((card) => card.classList.contains("toast-enter"))).toEqual([true, true]);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(texts()).toEqual(["Imported"]);
    // Still there, in its place, on its way out: not announced, not to be pressed.
    expect(cards().map((card) => card.textContent)).toEqual(["disk full", "Imported"]);
    const leaving = cards()[0]!;
    expect(leaving.classList.contains("toast-exit")).toBe(true);
    expect(leaving.classList.contains("pointer-events-auto")).toBe(false);
    expect(leaving.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => void vi.advanceTimersByTime(TOAST_EXIT_MS));
    expect(cards().map((card) => card.textContent)).toEqual(["Imported"]);
    // The last one takes the stack with it.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByTestId("toasts")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(TOAST_EXIT_MS));
    expect(screen.queryByTestId("toasts")).toBeNull();
  });

  it("is gone at once for those who asked for less motion", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: query.includes("reduce") }) as MediaQueryList,
    );
    render(<Toasts />);
    act(() => showError("disk full"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("toasts")).toBeNull();
    vi.restoreAllMocks();
  });

  it("scrolls a long message rather than growing over the window", () => {
    render(<Toasts />);
    const long = "word ".repeat(70).trim();
    act(() => showError(long));
    const text = screen.getByText(long);
    for (const name of ["max-h-40", "overflow-y-auto", "selectable"]) expect(text.classList.contains(name)).toBe(true);
  });

  it("keeps errors until dismissed, and lets the rest go after a while", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showInfo("Imported");
      showSuccess("Exported");
    });
    act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
    expect(texts()).toEqual(["disk full", "Imported", "Exported"]);
    act(() => void vi.advanceTimersByTime(1));
    expect(texts()).toEqual(["disk full"]);
    act(() => void vi.advanceTimersByTime(TOAST_MS * 10));
    expect(texts()).toEqual(["disk full"]);
  });

  it("waits while the pointer is on a toast", () => {
    render(<Toasts />);
    act(() => showInfo("Imported"));
    const toast = screen.getByRole("status");
    act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
    fireEvent.pointerEnter(toast);
    act(() => void vi.advanceTimersByTime(TOAST_MS * 2));
    expect(texts()).toEqual(["Imported"]);
    fireEvent.pointerLeave(toast);
    act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
    expect(texts()).toEqual(["Imported"]);
    act(() => void vi.advanceTimersByTime(1));
    expect(texts()).toEqual([]);
  });

  it("waits while the focus is in a toast", () => {
    render(<Toasts />);
    act(() => showInfo("Imported"));
    const dismiss = screen.getByRole("button", { name: "Dismiss" });
    act(() => dismiss.focus());
    act(() => void vi.advanceTimersByTime(TOAST_MS * 2));
    expect(texts()).toEqual(["Imported"]);
    act(() => dismiss.blur());
    act(() => void vi.advanceTimersByTime(TOAST_MS));
    expect(texts()).toEqual([]);
  });

  it("runs a toast's action from its button, and takes the toast away", () => {
    const run = vi.fn();
    render(<Toasts />);
    act(() => showInfo("The agent made notes.html.", { label: "Open", run }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(run).toHaveBeenCalledOnce();
    expect(texts()).toEqual([]);
  });

  it("dismisses the newest on Escape, one at a time, keeping the key from the page", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showError("busy");
    });
    act(() => void pressEscape());
    expect(texts()).toEqual(["disk full"]);
    act(() => void pressEscape());
    expect(texts()).toEqual([]);
    expect(page).not.toHaveBeenCalled();
    // With none left, Escape is the page's again.
    act(() => void pressEscape());
    expect(page).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", page);
  });

  it("leaves Escape to a popover or dialog that is open, whichever came first", () => {
    const close = vi.fn();
    render(<Toasts />);
    const closeLayer = openLayer(close);
    act(() => showError("disk full"));
    act(() => void pressEscape());
    expect(close).toHaveBeenCalledOnce();
    expect(texts()).toEqual(["disk full"]);
    closeLayer();
    act(() => void pressEscape());
    expect(texts()).toEqual([]);
  });

  describe("place", () => {
    afterEach(() => {
      for (const area of document.querySelectorAll(`[${TOAST_AREA}]`)) area.remove();
    });

    it("sits at the bottom centre of the slide's area, clear of the bar under the slide and of the sidebar", () => {
      slideArea({ left: 220, width: 800, bottom: 700 });
      render(<Toasts />);
      act(() => showError("disk full"));
      const { style } = screen.getByTestId("toasts");
      expect(style.left).toBe("620px");
      expect(style.bottom).toBe(`${window.innerHeight - 700 + 56}px`);
      // No wider than the area, with a margin.
      expect(style.maxWidth).toBe("768px");
    });

    it("renders again as its area moves, not for a report of the place it already has", () => {
      const area = slideArea({ left: 220, width: 800, bottom: 700 });
      render(<Toasts />);
      act(() => showError("disk full"));
      const renders = vi.mocked(ToolButton).mock.calls.length;
      for (let i = 0; i < 5; i++) act(() => void window.dispatchEvent(new Event("resize")));
      expect(vi.mocked(ToolButton).mock.calls.length).toBe(renders);
      area.getBoundingClientRect = () => ({ ...new DOMRect(), left: 220, width: 600, bottom: 700 }) as DOMRect;
      act(() => void window.dispatchEvent(new Event("resize")));
      expect(vi.mocked(ToolButton).mock.calls.length).toBeGreaterThan(renders);
      expect(screen.getByTestId("toasts").style.left).toBe("520px");
    });

    it("sits at the bottom centre of the window without that area, or with it covered", () => {
      render(<Toasts />);
      act(() => showError("disk full"));
      expect(screen.getByTestId("toasts").style.left).toBe("");
      slideArea({ left: 220, width: 800, bottom: 700 });
      act(() => {
        useApp.setState({ sidebarMaximized: true });
        showError("busy");
      });
      expect(screen.getByTestId("toasts").style.left).toBe("");
      expect(screen.getByTestId("toasts").style.bottom).toBe("");
    });
  });

  describe("during a slide show", () => {
    it("shows nothing over the slide, and what waited once the show ends", () => {
      render(<Toasts />);
      act(() => {
        useApp.setState({ presenting: true });
        showInfo("The agent is done");
        showError("Could not save");
      });
      expect(screen.queryByTestId("toasts")).toBeNull();
      // Nothing that waits goes away meanwhile.
      act(() => void vi.advanceTimersByTime(TOAST_MS * 2));
      expect(texts()).toEqual(["The agent is done", "Could not save"]);
      act(() => useApp.setState({ presenting: false }));
      expect(screen.getByRole("status").textContent).toBe("The agent is done");
      expect(screen.getByRole("alert").textContent).toBe("Could not save");
      // Its time to go away starts when it shows.
      act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
      expect(texts()).toContain("The agent is done");
      act(() => void vi.advanceTimersByTime(1));
      expect(texts()).toEqual(["Could not save"]);
    });

    it("shows an error about the show itself", () => {
      render(<Toasts />);
      act(() => {
        useApp.setState({ presenting: true });
        showInfo("Exported");
        showError("No second screen", { doing: "Could not open the presenter view", duringShow: true });
      });
      expect(screen.getByRole("alert").textContent).toBe("Could not open the presenter view: No second screen");
      expect(screen.queryByRole("status")).toBeNull();
      // Escape dismisses what shows, not what waits.
      pressEscape();
      expect(texts()).toEqual(["Exported"]);
    });

    it("takes what was showing off the slide as the show starts", () => {
      render(<Toasts />);
      act(() => showError("disk full"));
      act(() => useApp.setState({ presenting: true }));
      act(() => void vi.advanceTimersByTime(TOAST_EXIT_MS));
      expect(screen.queryByTestId("toasts")).toBeNull();
      expect(texts()).toEqual(["disk full"]);
    });
  });

  describe("details", () => {
    const RAW = 'API error 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

    it("says a service's answer in words, with the raw answer behind Details", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      render(<Toasts />);
      act(() => showError(RAW, { doing: "Could not make the narration" }));
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toBe("Could not make the narration: API error 529: OverloadedDetails");
      expect(alert.textContent).not.toContain("{");
      const details = screen.getByRole("button", { name: "Details" });
      expect(details.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(details);
      expect(details.getAttribute("aria-expanded")).toBe("true");
      expect(alert.querySelector("pre")!.textContent).toBe(RAW);
      fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
      await act(async () => {});
      expect(writeText).toHaveBeenCalledWith(RAW);
      expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
      vi.unstubAllGlobals();
    });

    it("offers no details for an error that is a plain sentence, and a way on when there is one", () => {
      const retry = vi.fn();
      render(<Toasts />);
      act(() =>
        showError("The folder is gone.", { doing: "Could not open the deck", action: { label: "Retry", run: retry } }),
      );
      expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(retry).toHaveBeenCalledOnce();
      expect(texts()).toEqual([]);
    });
  });
});
