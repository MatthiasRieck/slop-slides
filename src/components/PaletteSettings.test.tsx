import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PaletteEntry } from "../lib/api";
import { parseColor, toOklch } from "../lib/colorWheel";
import { PALETTE_PRESETS } from "../lib/palette";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { DeckSettings } from "./DeckSettings";
import { PaletteSettings } from "./PaletteSettings";

const PALETTE: PaletteEntry[] = [
  { name: "bg", value: "#f4f1ea" },
  { name: "ink", value: "#1c1b19" },
  { name: "accent", value: "#d6461f" },
  { name: "shade", value: "color-mix(in srgb, var(--accent) 20%, transparent)" },
];

const setPaletteColors = vi.fn(async (_colors: PaletteEntry[]) => {});
const adoptPalette = vi.fn(async () => {});

beforeEach(() => {
  setPaletteColors.mockClear();
  adoptPalette.mockClear();
  useApp.setState({
    deck: { ...deckFor(DECK_HTML), palette: PALETTE },
    running: false,
    lint: [],
    setPaletteColors,
    adoptPalette,
  });
});

const hue = (value: string) => toOklch(parseColor(value)!).h;
const wheel = () => screen.getByRole("slider", { name: /Color wheel/ });

describe("PaletteSettings", () => {
  it("is part of the deck's settings", () => {
    render(<DeckSettings />);
    expect(screen.getByRole("list", { name: "Palette colors" })).toBeTruthy();
  });

  it("lists the palette, and shows colors it cannot pick as they are", () => {
    render(<PaletteSettings />);
    const list = screen.getByRole("list", { name: "Palette colors" });
    expect(list.textContent).toContain("--accent");
    expect(list.textContent).toContain("color-mix(in srgb, var(--accent) 20%, transparent)");
    expect((screen.getByLabelText("Color accent") as HTMLInputElement).value).toBe("#d6461f");
    expect(screen.queryByLabelText("Color shade")).toBeNull();
  });

  it("puts each color it can read on the wheel, joined into a star", () => {
    const { container } = render(<PaletteSettings />);
    expect(container.querySelectorAll("circle[data-color]")).toHaveLength(3);
    expect(container.querySelector("polygon")).toBeTruthy();
  });

  it("sets one color from its swatch", () => {
    render(<PaletteSettings />);
    const input = screen.getByLabelText("Color accent") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "#00ff00" } });
    expect(setPaletteColors).not.toHaveBeenCalled();
    act(() => void input.dispatchEvent(new Event("change")));
    expect(setPaletteColors).toHaveBeenCalledWith([{ name: "accent", value: "#00ff00" }]);
  });

  it("turns every color with the arrow keys, grays staying put", async () => {
    render(<PaletteSettings />);
    fireEvent.keyDown(wheel(), { key: "ArrowRight", shiftKey: true });
    await waitFor(() => expect(setPaletteColors).toHaveBeenCalledTimes(1));
    const sent = setPaletteColors.mock.calls[0]![0];
    // Only the accent has a hue to turn: the background and ink are near gray.
    expect(sent.map((c) => c.name)).toEqual(["accent"]);
    const accent = sent.find((c) => c.name === "accent")!;
    expect(hue(accent.value)).toBeCloseTo((hue("#d6461f") + 30) % 360, 0);
    expect(wheel().getAttribute("aria-valuenow")).toBe("30");
  });

  it("turns every color by dragging the wheel", async () => {
    render(<PaletteSettings />);
    const svg = wheel();
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 220, height: 220 }) as DOMRect;
    // From the top of the wheel to its right: a quarter turn.
    fireEvent.pointerDown(svg, { button: 0, clientX: 110, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 200, clientY: 110, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 200, clientY: 110, pointerId: 1 });
    await waitFor(() => expect(setPaletteColors).toHaveBeenCalled());
    const last = setPaletteColors.mock.calls.at(-1)![0];
    const accent = last.find((c) => c.name === "accent")!;
    expect(hue(accent.value)).toBeCloseTo((hue("#d6461f") + 90) % 360, 0);
  });

  it("moves one color by dragging its dot", async () => {
    const { container } = render(<PaletteSettings />);
    const svg = wheel();
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 220, height: 220 }) as DOMRect;
    const dot = container.querySelector('circle[data-color="accent"]')!;
    fireEvent.pointerDown(dot, { button: 0, clientX: 150, clientY: 60, pointerId: 1 });
    // Straight down, halfway out: a hue of 180°.
    fireEvent.pointerMove(svg, { clientX: 110, clientY: 110 + 49, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 110, clientY: 110 + 49, pointerId: 1 });
    await waitFor(() => expect(setPaletteColors).toHaveBeenCalled());
    const last = setPaletteColors.mock.calls.at(-1)![0];
    expect(last.map((c) => c.name)).toEqual(["accent"]);
    expect(hue(last[0]!.value)).toBeCloseTo(180, 0);
  });

  it("applies a preset palette to the deck's colors", () => {
    render(<PaletteSettings />);
    fireEvent.change(screen.getByRole("combobox", { name: "Apply a palette" }), { target: { value: "midnight" } });
    const midnight = PALETTE_PRESETS.find((p) => p.id === "midnight")!.colors;
    expect(setPaletteColors).toHaveBeenCalledWith([
      { name: "bg", value: midnight.bg },
      { name: "ink", value: midnight.ink },
      { name: "accent", value: midnight.accent },
    ]);
  });

  it("offers to move colors written out in the deck into the palette", () => {
    useApp.setState({
      lint: [
        { rule: "palette-color", severity: "warning", message: "", line: 3, slide: null },
        { rule: "palette-color", severity: "warning", message: "", line: 9, slide: "a" },
        { rule: "slide-id-style", severity: "error", message: "", line: 4, slide: "a" },
      ],
    });
    render(<PaletteSettings />);
    expect(screen.getByText(/2 lines of the deck write colors out/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move into the palette" }));
    expect(adoptPalette).toHaveBeenCalled();
  });

  it("explains a deck without a palette", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), palette: [] } });
    render(<PaletteSettings />);
    expect(screen.getByText(/no palette yet/)).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("changes nothing while the agent works", () => {
    useApp.setState({ running: true });
    render(<PaletteSettings />);
    fireEvent.keyDown(wheel(), { key: "ArrowRight" });
    expect(setPaletteColors).not.toHaveBeenCalled();
    expect((screen.getByRole("combobox", { name: "Apply a palette" }) as HTMLSelectElement).disabled).toBe(true);
  });
});
