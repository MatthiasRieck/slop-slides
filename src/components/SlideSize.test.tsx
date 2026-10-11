import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { SlideSizeButton } from "./SlideSize";

const DECK = deckFor(DECK_HTML);
const sizedDeck = (size: { width: number; height: number; unit: "px" | "in" | "cm" }, pixels: [number, number]): Deck => ({
  ...DECK,
  size: { ...size, pixelWidth: pixels[0], pixelHeight: pixels[1] },
});

const resizeSlides = vi.fn(async () => {});

beforeEach(() => {
  invoke.mockReset();
  resizeSlides.mockClear();
  useApp.setState({ deck: DECK, running: false, resizeSlides });
});

const open = () => fireEvent.click(screen.getByRole("button", { name: "Slide size" }));
const field = (name: "Width" | "Height") => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const unit = () => screen.getByRole("combobox", { name: "Unit" }) as HTMLSelectElement;
const apply = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("slide size", () => {
  it("shows the deck's size and opens a panel with it", () => {
    render(<SlideSizeButton />);
    expect(screen.getByRole("button", { name: "Slide size" }).textContent).toBe("1920 × 1080 px");
    open();
    expect(screen.getByRole("dialog", { name: "Slide size" })).toBeTruthy();
    expect(field("Width").value).toBe("1920");
    expect(field("Height").value).toBe("1080");
    expect(unit().value).toBe("px");
    expect(pressed("Landscape")).toBe("true");
    expect(pressed("Widescreen 16:9")).toBe("true");
    expect(apply().disabled).toBe(true);
  });

  it("turns the slides to portrait and applies the new size", () => {
    render(<SlideSizeButton />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Portrait" }));
    expect(field("Width").value).toBe("1080");
    expect(field("Height").value).toBe("1920");
    expect(pressed("Portrait")).toBe("true");
    expect(pressed("Story 9:16")).toBe("true");
    fireEvent.click(apply());
    expect(resizeSlides).toHaveBeenCalledWith({ width: 1080, height: 1920, unit: "px" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("makes the slides square", () => {
    render(<SlideSizeButton />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Square" }));
    fireEvent.click(apply());
    expect(resizeSlides).toHaveBeenCalledWith({ width: 1080, height: 1080, unit: "px" });
  });

  it("takes a width and height in inches or centimetres", () => {
    render(<SlideSizeButton />);
    open();
    fireEvent.change(unit(), { target: { value: "in" } });
    // The size stays, shown in inches.
    expect(field("Width").value).toBe("20");
    expect(field("Height").value).toBe("11.25");
    expect(screen.getByText("A 1920 × 1080 px canvas (96 px per inch).")).toBeTruthy();
    fireEvent.change(field("Width"), { target: { value: "8.5" } });
    fireEvent.change(field("Height"), { target: { value: "11" } });
    expect(screen.getByText("A 816 × 1056 px canvas (96 px per inch).")).toBeTruthy();
    expect(pressed("US Letter")).toBe("true");
    fireEvent.submit(apply().closest("form")!);
    expect(resizeSlides).toHaveBeenCalledWith({ width: 8.5, height: 11, unit: "in" });
  });

  it("offers common sizes", () => {
    render(<SlideSizeButton />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "A4" }));
    expect(unit().value).toBe("cm");
    expect(field("Width").value).toBe("21");
    expect(field("Height").value).toBe("29.7");
    fireEvent.click(apply());
    expect(resizeSlides).toHaveBeenCalledWith({ width: 21, height: 29.7, unit: "cm" });
  });

  it("refuses sizes that are empty, too small or too large", () => {
    render(<SlideSizeButton />);
    open();
    fireEvent.change(field("Width"), { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toBe("Enter a width and a height.");
    expect(apply().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Portrait" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field("Width"), { target: { value: "50" } });
    expect(screen.getByRole("alert").textContent).toContain("Each side must be 100–10,000 px");
    expect(apply().disabled).toBe(true);
    fireEvent.change(field("Width"), { target: { value: "1440" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(apply().disabled).toBe(false);
    expect(resizeSlides).not.toHaveBeenCalled();
  });

  it("starts from a size given in another unit, and cancels without changes", () => {
    useApp.setState({ deck: sizedDeck({ width: 21, height: 29.7, unit: "cm" }, [794, 1123]) });
    render(<SlideSizeButton />);
    expect(screen.getByRole("button", { name: "Slide size" }).textContent).toBe("21 × 29.7 cm");
    open();
    expect(unit().value).toBe("cm");
    expect(pressed("Portrait")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(resizeSlides).not.toHaveBeenCalled();
  });

  it("explains that the agent re-lays out a deck with slides", () => {
    const { unmount } = render(<SlideSizeButton />);
    open();
    expect(screen.getByText(/asking the agent to lay them out again/)).toBeTruthy();
    unmount();
    useApp.setState({ deck: { ...DECK, slides: [] } });
    render(<SlideSizeButton />);
    open();
    expect(screen.queryByText(/asking the agent/)).toBeNull();
  });

  it("waits for the agent to finish", () => {
    useApp.setState({ running: true });
    render(<SlideSizeButton />);
    const button = screen.getByRole("button", { name: "Slide size" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toContain("Wait for the agent");
  });
});
