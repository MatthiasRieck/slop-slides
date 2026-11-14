import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Deck, Section } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { SlideOverview, StageOrOverview } from "./SlideOverview";
import { SlideRail } from "./SlideRail";

/** The rows that rendered, by their key, since it was last emptied. */
const rendered = vi.hoisted(() => [] as string[]);
vi.mock("@dnd-kit/sortable", async (original) => {
  const actual = await original<typeof import("@dnd-kit/sortable")>();
  const useSortable: typeof actual.useSortable = (args) => {
    rendered.push(String(args.id));
    return actual.useSortable(args);
  };
  return { ...actual, useSortable };
});
vi.mock("./Stage", () => ({ Stage: () => <div data-testid="stage" /> }));

const slide = (id: string) => ({ id, hash: id, hidden: false, locked: false, moved: false });
const deckOf = (ids: string[], sections: Section[] = []): Deck => ({
  ...deckFor(DECK_HTML),
  slides: ids.map(slide),
  sections,
});
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid=slide-overview] li[data-rail-slide]")];
const thumb = (n: number) => rows()[n]!.querySelector<HTMLButtonElement>("button[data-thumbnail]")!;

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({
    deck: deckOf(["a", "b", "c", "d"]),
    selected: "a",
    editing: false,
    overview: true,
    railSelected: [],
    railAnchor: null,
    collapsedSections: [],
    comments: {},
    lint: null,
    presenting: false,
  });
  useApp.getState().clearSearch();
});
afterEach(() => useApp.setState({ overview: false }));

describe("the grid of all slides", () => {
  it("takes the stage's place while it is on", () => {
    render(<StageOrOverview />);
    expect(screen.getByTestId("slide-overview")).toBeTruthy();
    act(() => useApp.getState().setOverview(false));
    expect(screen.getByTestId("stage")).toBeTruthy();
  });

  it("shows every slide with its number, as the slide list's thumbnails, loading them only near the view", () => {
    render(<SlideOverview />);
    expect(rows().map((li) => li.querySelector("span")?.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(screen.getByText("Slides · 4")).toBeTruthy();
    // jsdom shows nothing, so nothing is near the view: no slide has loaded a document.
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
  });

  it("lays the sections out as headed groups across the grid, which fold", () => {
    useApp.setState({ deck: deckOf(["a", "b", "c"], [{ index: 0, title: "Part two", before: 1 }]) });
    render(<SlideOverview />);
    const header = screen.getByTestId("section-header");
    expect(header.className).toContain("col-span-full");
    fireEvent.click(within(header).getByTitle("Collapse section"));
    expect(rows().filter((li) => li.classList.contains("hidden"))).toHaveLength(2);
  });

  it("picks like the list, and opens a slide on a double-click or Enter, leaving the grid", () => {
    render(<SlideOverview />);
    fireEvent.click(thumb(2), { shiftKey: true });
    expect(useApp.getState().railSelected).toEqual(["a", "b", "c"]);
    expect(screen.getByRole("toolbar", { name: "Selected slides" })).toBeTruthy();
    fireEvent.click(thumb(1));
    fireEvent.doubleClick(thumb(3));
    expect(useApp.getState()).toMatchObject({ selected: "d", overview: false });
    act(() => useApp.getState().setOverview(true));
    fireEvent.keyDown(thumb(1), { key: "Enter" });
    expect(useApp.getState()).toMatchObject({ selected: "b", overview: false });
  });

  it("opens the slide's menu, with editing it and presenting from it", () => {
    render(<SlideOverview />);
    fireEvent.contextMenu(thumb(1), { clientX: 10, clientY: 10 });
    const menu = within(screen.getByRole("menu", { name: "Slide" }));
    fireEvent.click(menu.getByRole("menuitem", { name: "Edit slide" }));
    expect(useApp.getState()).toMatchObject({ selected: "b", editing: true, overview: false });
  });

  it("goes back to the stage on Escape, once nothing is picked", () => {
    render(<SlideOverview />);
    act(() => useApp.getState().pickSlides(["a", "b"]));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState()).toMatchObject({ overview: true, railSelected: [] });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useApp.getState().overview).toBe(false);
  });

  it("goes up and down a row with the arrows, and picks the way there with ⇧", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // Two to a row.
      const at = rows().indexOf(this as HTMLLIElement);
      const top = Math.floor(at / 2) * 100;
      const left = (at % 2) * 100;
      return { top, left, bottom: top + 60, right: left + 90, width: 90, height: 60, x: left, y: top } as DOMRect;
    });
    render(<SlideOverview />);
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(useApp.getState().selected).toBe("c");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(useApp.getState().selected).toBe("d");
    fireEvent.keyDown(window, { key: "ArrowUp", shiftKey: true });
    expect(useApp.getState()).toMatchObject({ selected: "b", railSelected: ["b", "c", "d"] });
    vi.restoreAllMocks();
  });

  it("sets how large the thumbnails are with its slider, and remembers it", () => {
    render(<SlideOverview />);
    const slider = screen.getByRole("slider", { name: "Thumbnail size" });
    fireEvent.change(slider, { target: { value: "300" } });
    expect(document.querySelector<HTMLElement>("[data-testid=slide-overview] ol")!.style.gridTemplateColumns).toBe(
      "repeat(auto-fill, minmax(300px, 1fr))",
    );
    expect(localStorage.getItem("slopslide.overviewSize")).toBe("300");
  });

  it("renders two rows when the selection goes to the next slide", () => {
    useApp.setState({ deck: deckOf(Array.from({ length: 40 }, (_, i) => `s${i}`)), selected: "s0" });
    render(<SlideOverview />);
    rendered.length = 0;
    act(() => useApp.getState().selectRelative(1));
    expect([...rendered].sort()).toEqual(["s0", "s1"]);
  });
});

describe("the slide list's button for the grid", () => {
  it("turns it on and off, and says so", () => {
    useApp.setState({ overview: false });
    render(<SlideRail />);
    const button = screen.getByRole("button", { name: "All slides" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(useApp.getState().overview).toBe(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.title).toBe("Back to the slide (G)");
  });

  it("turns it on and off with G, but not while typing or during a show", () => {
    useApp.setState({ overview: false });
    render(
      <>
        <SlideRail />
        <input aria-label="Field" />
      </>,
    );
    fireEvent.keyDown(window, { key: "g" });
    expect(useApp.getState().overview).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Field"), { key: "g" });
    expect(useApp.getState().overview).toBe(true);
    useApp.setState({ presenting: true });
    fireEvent.keyDown(window, { key: "g" });
    expect(useApp.getState().overview).toBe(true);
    useApp.setState({ presenting: false });
    fireEvent.keyDown(window, { key: "g" });
    expect(useApp.getState().overview).toBe(false);
  });
});
