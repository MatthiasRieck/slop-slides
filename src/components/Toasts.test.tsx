import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openLayer } from "../lib/layers";
import { showError, showInfo, showSuccess, useApp } from "../store";
import { TOAST_MS, Toasts } from "./Toasts";

const texts = () => useApp.getState().toasts.map((toast) => toast.text);
const pressEscape = (target: Element | Document = document.body) => fireEvent.keyDown(target, { key: "Escape" });

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe("Toasts", () => {
  it("shows nothing until there is something to say", () => {
    render(<Toasts />);
    expect(screen.queryByTestId("toasts")).toBeNull();
  });

  it("stacks them at the bottom right over everything, the newest last", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showInfo("Imported");
    });
    const stack = screen.getByTestId("toasts");
    expect(stack.parentElement).toBe(document.body);
    for (const name of ["fixed", "right-4", "bottom-4", "z-[70]"]) expect(stack.classList.contains(name)).toBe(true);
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

  it("scrolls a long message rather than growing over the window", () => {
    render(<Toasts />);
    act(() => showError("x".repeat(5000)));
    const text = screen.getByText("x".repeat(5000));
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
});
