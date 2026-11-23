import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { openLayer } from "../lib/layers";
import { showError, showInfo, showSuccess, useApp } from "../store";
import { MAX_TOASTS } from "../store/ui";
import { TOAST_MS, Toasts } from "./Toasts";

const texts = () => useApp.getState().toasts.map((toast) => toast.text);
const pressEscape = (target: Element | Document = document.body) => fireEvent.keyDown(target, { key: "Escape" });

/** Lets the toaster show what it was just given, or take away what was just closed. */
const flush = () => act(() => void vi.advanceTimersByTime(20));

/** The toasts on show, the oldest first, as elements. */
const cards = () =>
  [...document.querySelectorAll<HTMLElement>("[data-slot=toast]")].sort(
    (a, b) => Number(b.style.getPropertyValue("--toast-index")) - Number(a.style.getPropertyValue("--toast-index")),
  );
const card = (text: string) =>
  screen.getByText(text, { selector: "[data-slot=toast-title]" }).closest("[data-slot=toast]")!;
// An error is read out as it shows, and its toast is out of a screen reader's way until the focus
// is in the toasts: its button is not found by role.
const dismissButton = (text: string) => card(text).querySelector<HTMLElement>("[data-slot=toast-close]")!;

/** The toasts with a dialog over the app, as the settings are. */
function UnderDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <>
      <Toasts />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe("Toasts", () => {
  it("shows no toast until there is something to say", () => {
    render(<Toasts />);
    flush();
    expect(cards()).toEqual([]);
  });

  it("stacks them at the bottom right over everything, in the notifications region", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showInfo("Imported");
    });
    flush();
    const stack = document.querySelector<HTMLElement>("[data-slot=toast-viewport]")!;
    // In the body, so that a dialog, which takes the rest of the app out of reach, leaves them in it.
    expect(stack.closest("#root")).toBeNull();
    expect(screen.getByRole("region", { name: "Notifications" })).toBe(stack);
    for (const name of ["fixed", "bottom-4", "z-70"]) expect(stack.classList.contains(name)).toBe(true);
    expect(
      cards().map((toast) => within(toast).getByText(/./, { selector: "[data-slot=toast-title]" }).textContent),
    ).toEqual(["disk full", "Imported"]);
  });

  it("shows each as a dialog of its kind, in the colors of what they mean", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showInfo("Imported");
      showSuccess("Exported");
    });
    flush();
    const error = card("disk full");
    // An error interrupts (an alert dialog); the rest are said when there is a pause.
    expect(error.getAttribute("role")).toBe("alertdialog");
    expect(card("Imported").getAttribute("role")).toBe("dialog");
    expect(error.getAttribute("aria-modal")).toBe("false");
    expect(error.getAttribute("data-type")).toBe("error");
    expect(error.className).toContain("data-[type=error]:border-destructive/30");
    expect(error.querySelector("[data-slot=toast-icon] svg")?.getAttribute("class")).toContain("text-destructive");
    expect(card("Imported").getAttribute("data-type")).toBe("info");
    expect(card("Imported").querySelector("[data-slot=toast-icon] svg")?.getAttribute("class")).toContain(
      "text-primary",
    );
    expect(card("Exported").getAttribute("data-type")).toBe("success");
    expect(card("Exported").querySelector("[data-slot=toast-icon] svg")?.getAttribute("class")).toContain(
      "text-success",
    );
  });

  it("says an error at once, and the rest when there is a pause", () => {
    const add = vi.spyOn(toast, "add");
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showInfo("Imported");
    });
    expect(add.mock.calls.map(([options]) => [options.title, options.priority, options.timeout])).toEqual([
      ["disk full", "high", 0],
      ["Imported", "low", TOAST_MS],
    ]);
    add.mockRestore();
  });

  it("hands each toast to the toaster once, however often the store changes", () => {
    const add = vi.spyOn(toast, "add");
    render(<Toasts />);
    act(() => showError("disk full"));
    act(() => showInfo("Imported"));
    act(() => showSuccess("Exported"));
    expect(add).toHaveBeenCalledTimes(3);
    add.mockRestore();
  });

  it("dismisses a toast with its labelled button", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showError("busy");
    });
    flush();
    expect(dismissButton("busy").getAttribute("aria-label")).toBe("Dismiss");
    fireEvent.click(dismissButton("disk full"));
    expect(texts()).toEqual(["busy"]);
    flush();
    expect(screen.queryByText("disk full", { selector: "[data-slot=toast-title]" })).toBeNull();
    expect(card("busy")).toBeTruthy();
  });

  it("takes a toast away when the store drops it", () => {
    render(<Toasts />);
    act(() => {
      showError("disk full");
      showInfo("Imported");
    });
    flush();
    const [first] = useApp.getState().toasts;
    act(() => useApp.getState().dismissToast(first!.id));
    flush();
    expect(screen.queryByText("disk full", { selector: "[data-slot=toast-title]" })).toBeNull();
    expect(card("Imported")).toBeTruthy();
    // The last one leaves none behind.
    fireEvent.click(dismissButton("Imported"));
    flush();
    expect(cards()).toEqual([]);
    expect(texts()).toEqual([]);
  });

  it("leaves nothing in the toaster when it goes away itself", () => {
    const close = vi.spyOn(toast, "close");
    const { unmount } = render(<Toasts />);
    act(() => showError("disk full"));
    const [shown] = useApp.getState().toasts;
    unmount();
    expect(close).toHaveBeenCalledWith(String(shown!.id));
    close.mockRestore();
  });

  it("shows no more at once than the store keeps", () => {
    render(<Toasts />);
    act(() => {
      for (let i = 0; i <= MAX_TOASTS; i++) showError(`error ${i}`);
    });
    flush();
    expect(texts()).toHaveLength(MAX_TOASTS);
    expect(cards().filter((toast) => !toast.hasAttribute("data-limited"))).toHaveLength(MAX_TOASTS);
  });

  it("scrolls a long message rather than growing over the window, and lets it be selected", () => {
    render(<Toasts />);
    act(() => showError("x".repeat(5000)));
    flush();
    const text = screen.getByText("x".repeat(5000), { selector: "[data-slot=toast-title]" }).parentElement!;
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

  it("waits while the pointer is on the toasts", () => {
    render(<Toasts />);
    act(() => showInfo("Imported"));
    flush();
    const stack = screen.getByRole("region", { name: "Notifications" });
    fireEvent.mouseEnter(stack);
    act(() => void vi.advanceTimersByTime(TOAST_MS * 2));
    expect(texts()).toEqual(["Imported"]);
    fireEvent.mouseLeave(stack);
    act(() => void vi.advanceTimersByTime(TOAST_MS));
    expect(texts()).toEqual([]);
  });

  it("waits while the focus is in a toast", () => {
    render(<Toasts />);
    act(() => showInfo("Imported"));
    flush();
    const dismiss = dismissButton("Imported");
    act(() => dismiss.focus());
    act(() => void vi.advanceTimersByTime(TOAST_MS * 2));
    expect(texts()).toEqual(["Imported"]);
    act(() => dismiss.blur());
    act(() => void vi.advanceTimersByTime(TOAST_MS));
    expect(texts()).toEqual([]);
  });

  it("names the button that dismisses a toast, in reach once the toasts are pointed at", () => {
    render(<Toasts />);
    act(() => showInfo("Imported"));
    flush();
    expect(within(card("Imported") as HTMLElement).queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.mouseEnter(screen.getByRole("region", { name: "Notifications" }));
    fireEvent.click(within(card("Imported") as HTMLElement).getByRole("button", { name: "Dismiss" }));
    expect(texts()).toEqual([]);
  });

  it("stays in reach over a dialog, which a press on a toast does not close", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<UnderDialog open={false} onOpenChange={onOpenChange} />);
    // One that was there before the dialog opened, and one that came while it was open.
    act(() => showInfo("Imported"));
    flush();
    rerender(<UnderDialog open onOpenChange={onOpenChange} />);
    flush();
    act(() => showInfo("Exported"));
    flush();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    const stack = document.querySelector<HTMLElement>("[data-slot=toast-viewport]")!;
    expect(stack.closest("[inert]")).toBeNull();
    for (const text of ["Exported", "Imported"]) {
      const dismiss = dismissButton(text);
      fireEvent.pointerDown(dismiss, { pointerType: "mouse", button: 0 });
      fireEvent.mouseDown(dismiss);
      fireEvent.click(dismiss);
      flush();
    }
    expect(texts()).toEqual([]);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("runs a toast's action from its button, and takes the toast away", () => {
    const run = vi.fn();
    render(<Toasts />);
    act(() => showInfo("The agent made notes.html.", { label: "Open", run }));
    flush();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(run).toHaveBeenCalledOnce();
    expect(texts()).toEqual([]);
    flush();
    expect(cards()).toEqual([]);
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
