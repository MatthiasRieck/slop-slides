import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSaves, useSaves } from "../lib/saves";
import { useApp } from "../store";
import { SAVING_AFTER_MS, SaveStatus } from "./SaveStatus";

beforeEach(() => {
  resetSaves();
  useApp.setState({ codeDirty: false });
});
afterEach(() => vi.useRealTimers());

describe("SaveStatus", () => {
  it("says the deck is saved, quietly", () => {
    render(<SaveStatus />);
    expect(screen.getByRole("status").textContent).toBe("Saved");
  });

  it("says Saving… only for a write that takes its time", () => {
    vi.useFakeTimers();
    render(<SaveStatus />);
    act(() => useSaves.setState({ pending: 1 }));
    expect(screen.getByRole("status").textContent).toBe("Saved");
    act(() => vi.advanceTimersByTime(SAVING_AFTER_MS));
    expect(screen.getByRole("status").textContent).toBe("Saving…");
    act(() => useSaves.setState({ pending: 0 }));
    expect(screen.getByRole("status").textContent).toBe("Saved");
  });

  it("stands out when the last change was not saved", () => {
    useSaves.setState({ failed: true });
    render(<SaveStatus compact />);
    expect(screen.getByRole("status").textContent).toBe("Not saved");
  });

  it("leaves the word out where the bar is short of room", () => {
    const { container } = render(<SaveStatus compact />);
    expect(container.innerHTML).toBe("");
  });

  it("offers to save edits the HTML tab holds", () => {
    const confirmSaved = vi.fn(async () => true);
    useApp.setState({ codeDirty: true, confirmSaved });
    render(<SaveStatus compact />);
    fireEvent.click(screen.getByRole("button", { name: "Unsaved edits" }));
    expect(confirmSaved).toHaveBeenCalled();
  });
});
