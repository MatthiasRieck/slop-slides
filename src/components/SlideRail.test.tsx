import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { SlideRail } from "./SlideRail";

const DECK = deckFor(DECK_HTML);
const withSlides = (...ids: string[]): Deck => ({ ...DECK, slides: ids.map((id) => ({ id, hash: id, hidden: false })) });

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({ deck: DECK, selected: "intro", error: null, revealRev: 0 });
});

// dnd-kit gives sortable items role="button", so find them by tag.
const items = () => [...document.querySelectorAll<HTMLElement>("ol > li")];
const item = (index: number) => within(items()[index]!);

const HIDDEN_HTML = DECK_HTML.replace(`id="outro"`, `id="outro" data-hidden`);
const thumbnail = (li: HTMLElement) => li.querySelector("button > div") as HTMLElement;

describe("SlideRail", () => {
  it("numbers every slide and shows the count", () => {
    render(<SlideRail />);
    expect(screen.getByText("Slides · 3")).toBeTruthy();
    expect(items().map((li) => li.textContent)).toEqual(["1", "2", "3"]);
  });

  it("explains what to do in an empty deck", () => {
    useApp.setState({ deck: { ...DECK, slides: [] }, selected: null });
    render(<SlideRail />);
    expect(screen.getByText("Slides · 0")).toBeTruthy();
    expect(screen.getByText(/No slides yet/)).toBeTruthy();
    expect(items()).toEqual([]);
  });

  it("renders nothing without a deck", () => {
    useApp.setState({ deck: null });
    const { container } = render(<SlideRail />);
    expect(container.innerHTML).toBe("");
  });

  it("selects a slide when its thumbnail is clicked", () => {
    render(<SlideRail />);
    const thumbnail = items()[2]!.querySelector("button")!;
    fireEvent.click(thumbnail);
    expect(useApp.getState().selected).toBe("outro");
    expect(useApp.getState().revealRev).toBe(1);
  });

  it("highlights the selected slide's number", () => {
    render(<SlideRail />);
    expect(item(0).getByText("1").className).toContain("font-semibold");
    expect(item(1).getByText("2").className).not.toContain("font-semibold");
  });

  it("adds a blank slide after the selected one and selects it", async () => {
    invoke.mockResolvedValue({ deck: withSlides("intro", "slide", "#2", "outro"), slide: "slide" });
    render(<SlideRail />);
    await act(async () => fireEvent.click(screen.getByTitle("Add blank slide")));
    expect(invoke).toHaveBeenCalledWith("add_slide", { id: "talk", after: "intro" });
    expect(useApp.getState().selected).toBe("slide");
    expect(items()).toHaveLength(4);
  });

  it("adds the first slide of an empty deck", async () => {
    useApp.setState({ deck: { ...DECK, slides: [] }, selected: null });
    invoke.mockResolvedValue({ deck: withSlides("slide"), slide: "slide" });
    render(<SlideRail />);
    await act(async () => fireEvent.click(screen.getByTitle("Add blank slide")));
    expect(invoke).toHaveBeenCalledWith("add_slide", { id: "talk", after: null });
    expect(useApp.getState().selected).toBe("slide");
  });

  it("duplicates a slide and selects the copy", async () => {
    invoke.mockResolvedValue({ deck: withSlides("intro", "#2", "outro", "outro-copy"), slide: "outro-copy" });
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(2).getByTitle("Duplicate")));
    expect(invoke).toHaveBeenCalledWith("duplicate_slide", { id: "talk", slide: "outro" });
    expect(useApp.getState().selected).toBe("outro-copy");
  });

  it("deleting the selected slide selects the next one", async () => {
    useApp.setState({ selected: "#2" });
    invoke.mockResolvedValue(withSlides("intro", "outro"));
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(1).getByTitle("Delete")));
    expect(invoke).toHaveBeenCalledWith("delete_slide", { id: "talk", slide: "#2" });
    expect(useApp.getState().selected).toBe("outro");
    expect(items()).toHaveLength(2);
  });

  it("deleting the last slide selects the one before it", async () => {
    useApp.setState({ selected: "outro" });
    invoke.mockResolvedValue(withSlides("intro", "#2"));
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(2).getByTitle("Delete")));
    expect(useApp.getState().selected).toBe("#2");
  });

  it("deleting another slide keeps the selection", async () => {
    invoke.mockResolvedValue(withSlides("intro", "#2"));
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(2).getByTitle("Delete")));
    expect(useApp.getState().selected).toBe("intro");
  });

  it("slide actions do not also select the slide", async () => {
    invoke.mockResolvedValue(withSlides("intro", "#2"));
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(2).getByTitle("Delete")));
    expect(useApp.getState().revealRev).toBe(0);
  });

  it.each([
    ["Add blank slide", () => screen.getByTitle("Add blank slide")],
    ["Duplicate", () => item(0).getByTitle("Duplicate")],
    ["Delete", () => item(0).getByTitle("Delete")],
  ])("reports a failed %s", async (_, button) => {
    invoke.mockRejectedValue("Slide not found: intro");
    render(<SlideRail />);
    await act(async () => fireEvent.click(button()));
    await waitFor(() => expect(useApp.getState().error).toBe("Slide not found: intro"));
    expect(useApp.getState().deck).toEqual(DECK);
  });
});

describe("hidden slides in the rail", () => {
  beforeEach(() => {
    useApp.setState({ deck: deckFor(HIDDEN_HTML) });
  });

  it("mutes hidden slides and strikes them through", () => {
    render(<SlideRail />);
    const [intro, , outro] = items() as [HTMLElement, HTMLElement, HTMLElement];
    expect(thumbnail(outro).className).toMatch(/opacity-35/);
    expect(thumbnail(outro).className).toMatch(/grayscale/);
    expect(within(outro).getByTestId("hidden-mark")).toBeTruthy();
    expect(within(outro).getByText("3").className).toMatch(/line-through/);

    expect(thumbnail(intro).className).not.toMatch(/opacity-35/);
    expect(within(intro).queryByTestId("hidden-mark")).toBeNull();
  });

  it("still renders hidden slides in place, keeping their number", () => {
    render(<SlideRail />);
    expect(items()).toHaveLength(3);
    expect(screen.getByText("Slides · 3")).toBeTruthy();
    expect(items().map((li) => li.querySelector("span")?.textContent)).toEqual(["1", "2", "3"]);
    expect(thumbnail(items()[2]!)).toBeTruthy();
  });

  it("hides a shown slide", async () => {
    const next = deckFor(HIDDEN_HTML.replace(`id="intro"`, `id="intro" data-hidden`), "2");
    invoke.mockResolvedValue(next);
    render(<SlideRail />);
    await act(async () => fireEvent.click(within(items()[0]!).getByTitle("Hide slide")));
    expect(invoke).toHaveBeenCalledWith("set_slide_hidden", { id: "talk", slide: "intro", hidden: true });
    expect(useApp.getState().deck).toBe(next);
    expect(within(items()[0]!).getByTestId("hidden-mark")).toBeTruthy();
  });

  it("shows a hidden slide again", async () => {
    invoke.mockResolvedValue(deckFor(DECK_HTML, "2"));
    render(<SlideRail />);
    await act(async () => fireEvent.click(within(items()[2]!).getByTitle("Show slide")));
    expect(invoke).toHaveBeenCalledWith("set_slide_hidden", { id: "talk", slide: "outro", hidden: false });
    expect(screen.queryByTestId("hidden-mark")).toBeNull();
  });

  it("reports a failed toggle", async () => {
    invoke.mockRejectedValue("disk full");
    render(<SlideRail />);
    await act(async () => fireEvent.click(within(items()[0]!).getByTitle("Hide slide")));
    expect(useApp.getState().error).toBe("disk full");
    expect(useApp.getState().deck?.slides[0]?.hidden).toBe(false);
  });
});
