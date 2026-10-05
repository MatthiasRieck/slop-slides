import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { TopBar } from "./TopBar";

const toggle = (name: "Slides" | "HTML") => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  useApp.setState({ deck: deckFor(DECK_HTML), view: "slides", codeDirty: false });
});

describe("Slides / HTML toggle", () => {
  it("marks the current view as pressed", () => {
    render(<TopBar />);
    expect(toggle("Slides").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("HTML").getAttribute("aria-pressed")).toBe("false");
  });

  it("switches to the HTML view and back", () => {
    render(<TopBar />);
    fireEvent.click(toggle("HTML"));
    expect(useApp.getState().view).toBe("code");
    expect(toggle("HTML").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle("Slides"));
    expect(useApp.getState().view).toBe("slides");
    expect(localStorage.getItem("slopslide.view")).toBe("slides");
  });

  it("shows an unsaved-changes dot on the HTML button", () => {
    render(<TopBar />);
    expect(screen.queryByTitle("Unsaved changes")).toBeNull();
    act(() => useApp.setState({ codeDirty: true }));
    const dot = screen.getByTitle("Unsaved changes");
    expect(toggle("HTML").contains(dot)).toBe(true);
  });

  it("explains each view in its tooltip", () => {
    render(<TopBar />);
    expect(toggle("HTML").title).toMatch(/deck\.html/);
    expect(toggle("Slides").title).toMatch(/rendered slide/);
  });
});
