import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck } from "../lib/api";
import { type DesignChange, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { SlideSizeSettings } from "./SlideSize";

const DECK = deckFor(DECK_HTML);
const sizedDeck = (
  size: { width: number; height: number; unit: "px" | "in" | "cm" },
  pixels: [number, number],
): Deck => ({
  ...DECK,
  size: { ...size, pixelWidth: pixels[0], pixelHeight: pixels[1] },
});

const resizeSlides = vi.fn<() => Promise<DesignChange | null>>(async () => null);

beforeEach(() => {
  invoke.mockReset();
  resizeSlides.mockReset().mockResolvedValue(null);
  useApp.setState({ deck: DECK, running: false, resizeSlides });
});

const field = (name: "Width" | "Height") => screen.getByRole("spinbutton", { name }) as HTMLInputElement;
const unit = () => screen.getByRole("combobox", { name: "Unit" }) as HTMLSelectElement;
const apply = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");

describe("slide size", () => {
  it("shows the deck's size", () => {
    render(<SlideSizeSettings />);
    expect(field("Width").value).toBe("1920");
    expect(field("Height").value).toBe("1080");
    expect(unit().value).toBe("px");
    expect(pressed("Landscape")).toBe("true");
    expect(pressed("Widescreen 16:9")).toBe("true");
    expect(apply().disabled).toBe(true);
  });

  it("turns the slides to portrait and applies the new size", () => {
    render(<SlideSizeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Portrait" }));
    expect(field("Width").value).toBe("1080");
    expect(field("Height").value).toBe("1920");
    expect(pressed("Portrait")).toBe("true");
    expect(pressed("Story 9:16")).toBe("true");
    fireEvent.click(apply());
    expect(resizeSlides).toHaveBeenCalledWith({ width: 1080, height: 1920, unit: "px" });
  });

  it("makes the slides square", () => {
    render(<SlideSizeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Square" }));
    fireEvent.click(apply());
    expect(resizeSlides).toHaveBeenCalledWith({ width: 1080, height: 1080, unit: "px" });
  });

  it("takes a width and height in inches or centimetres", () => {
    render(<SlideSizeSettings />);
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
    render(<SlideSizeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "A4" }));
    expect(unit().value).toBe("cm");
    expect(field("Width").value).toBe("21");
    expect(field("Height").value).toBe("29.7");
    fireEvent.click(apply());
    expect(resizeSlides).toHaveBeenCalledWith({ width: 21, height: 29.7, unit: "cm" });
  });

  it("refuses sizes that are empty, too small or too large", () => {
    render(<SlideSizeSettings />);
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

  it("starts from a size given in another unit, and resets without changes", () => {
    useApp.setState({ deck: sizedDeck({ width: 21, height: 29.7, unit: "cm" }, [794, 1123]) });
    render(<SlideSizeSettings />);
    expect(unit().value).toBe("cm");
    expect(pressed("Portrait")).toBe("true");
    fireEvent.change(field("Width"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(field("Width").value).toBe("21");
    expect((screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement).disabled).toBe(true);
    expect(resizeSlides).not.toHaveBeenCalled();
  });

  it("follows a size changed elsewhere, as by the agent", () => {
    render(<SlideSizeSettings />);
    act(() => useApp.setState({ deck: sizedDeck({ width: 1080, height: 1080, unit: "px" }, [1080, 1080]) }));
    expect(field("Width").value).toBe("1080");
    expect(apply().disabled).toBe(true);
  });

  it("explains that the agent re-lays out a deck with slides", () => {
    const { unmount } = render(<SlideSizeSettings />);
    expect(screen.getByText(/asking the agent to lay them out again/)).toBeTruthy();
    unmount();
    useApp.setState({ deck: { ...DECK, slides: [] } });
    render(<SlideSizeSettings />);
    expect(screen.queryByText(/asking the agent/)).toBeNull();
  });

  it("waits for the agent to finish", () => {
    useApp.setState({ running: true });
    render(<SlideSizeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Portrait" }));
    expect(apply().disabled).toBe(true);
    expect(apply().title).toContain("Wait for the agent");
    // Said beside the button too, not only in its tooltip.
    expect(screen.getByText("Wait for the agent to finish to change the slide size.")).toBeTruthy();
    fireEvent.submit(apply().closest("form")!);
    expect(resizeSlides).not.toHaveBeenCalled();
  });

  it("says that the layout request waits in the chat, also once the panel shows the new size", async () => {
    resizeSlides.mockImplementation(async () => {
      useApp.setState({ deck: sizedDeck({ width: 1080, height: 1080, unit: "px" }, [1080, 1080]) });
      return "requested";
    });
    render(<SlideSizeSettings />);
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Square" }));
    await act(async () => fireEvent.click(apply()));
    expect(field("Width").value).toBe("1080");
    expect(screen.getByRole("status").textContent).toBe(
      "Slides resized. Request added to the chat. Send it to lay the slides out again.",
    );
  });

  it("says that an empty deck's size changed, and nothing when it did not", async () => {
    resizeSlides.mockResolvedValueOnce("applied");
    render(<SlideSizeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Square" }));
    await act(async () => fireEvent.click(apply()));
    expect(screen.getByRole("status").textContent).toBe("Slide size changed.");
    // A refusal is the toast's to report.
    fireEvent.click(screen.getByRole("button", { name: "Portrait" }));
    await act(async () => fireEvent.click(apply()));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the last deck's status to itself", async () => {
    resizeSlides.mockResolvedValueOnce("applied");
    render(<SlideSizeSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Square" }));
    await act(async () => fireEvent.click(apply()));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => useApp.setState({ deck: { ...DECK, id: "/other/deck.html" } }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
