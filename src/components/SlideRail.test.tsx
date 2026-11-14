import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Deck, FindMatch, Section } from "../lib/api";
import { flushReviewSave, useApp } from "../store";
import { lastError } from "../store/errors";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { SlideRail } from "./SlideRail";

const DECK = deckFor(DECK_HTML);
const withSlides = (...ids: string[]): Deck => ({
  ...DECK,
  slides: ids.map((id) => ({ id, hash: id, hidden: false, locked: false, moved: false })),
});

beforeEach(() => {
  invoke.mockReset();
  useApp.setState({
    deck: DECK,
    selected: "intro",
    // Changing the slides is Edit mode's.
    editing: true,
    toasts: [],
    revealRev: 0,
    collapsedSections: [],
    railSelected: [],
    railAnchor: null,
    overview: false,
    addingSlide: false,
    lint: null,
    templates: [{ id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title"] }],
  });
  useApp.getState().clearSearch();
});

// A review save a test leaves waiting would otherwise run, and fail, in a later test.
afterEach(() => flushReviewSave());

// dnd-kit gives sortable items role="button", so find them by tag.
const items = () => [...document.querySelectorAll<HTMLElement>("ol > li")];
/** The number a slide's row shows before its thumbnail. */
const number = (li: HTMLElement) => li.querySelector("span")?.textContent;
const item = (index: number) => within(items()[index]!);

/** What the backend answers a rail change with. */
const edited = (deck: unknown, created: string[] = []) => ({ deck, previous: "<old>", source: "<new>", created });

const HIDDEN_HTML = DECK_HTML.replace(`id="outro"`, `id="outro" data-hidden`);
const thumbnail = (li: HTMLElement) => li.querySelector("button > div") as HTMLElement;
const markShown = (mark: HTMLElement) => mark.closest("[data-shown]")?.getAttribute("data-shown") === "true";

describe("SlideRail", () => {
  describe("while searching", () => {
    const found = (slide: string): FindMatch => ({
      slide,
      index: 0,
      locked: false,
      notes: false,
      before: "",
      text: "x",
      after: "",
    });
    const shown = () => items().filter((li) => !li.classList.contains("hidden"));
    afterEach(() => useApp.getState().clearSearch());

    const dimmed = () => items().flatMap((li) => (li.className.includes("opacity-40") ? [number(li)] : []));

    it("keeps every slide listed, counting the matches on those found and dimming the others", () => {
      const deck = withSlides("a", "b", "c");
      useApp.setState({ deck, selected: "a" });
      render(<SlideRail />);
      act(() => useApp.getState().setSearch({ query: "x" }));
      act(() => useApp.getState().setSearchMatches([found("b"), found("b"), found("c")]));
      expect(shown().map(number)).toEqual(["1", "2", "3"]);
      expect(dimmed()).toEqual(["1"]);
      expect(item(1).getByTestId("match-count").textContent).toBe("2");
      // The header says what the deck has, not what a search found.
      expect(screen.getByText("Slides · 3")).toBeTruthy();
      act(() => useApp.getState().setSearch({ query: "" }));
      expect(dimmed()).toEqual([]);
    });

    it("keeps the section headers when nothing matches", () => {
      useApp.setState({
        deck: { ...withSlides("a", "b"), sections: [{ index: 0, title: "One", before: 0 } as Section] },
        selected: "a",
      });
      render(<SlideRail />);
      act(() => {
        useApp.getState().setSearch({ query: "x" });
        useApp.getState().setSearchMatches([]);
      });
      // The header and both slides.
      expect(shown()).toHaveLength(3);
      expect(dimmed()).toEqual(["1", "2"]);
      expect(screen.getByTestId("section-header").classList.contains("hidden")).toBe(false);
    });

    it("still lets the slides be dragged, as every one of them is listed", () => {
      useApp.setState({ deck: withSlides("a", "b"), selected: "a" });
      render(<SlideRail />);
      act(() => {
        useApp.getState().setSearch({ query: "x" });
        useApp.getState().setSearchMatches([found("a")]);
      });
      expect(items().map((li) => li.getAttribute("data-draggable"))).toEqual(["true", "true"]);
    });
  });

  it("marks itself for the stage's keys, so ⌘C pressed on it copies the slide", () => {
    const { container } = render(<SlideRail />);
    expect(container.querySelector("[data-slide-rail]")).not.toBeNull();
  });

  it("numbers every slide and shows the count", () => {
    render(<SlideRail />);
    expect(screen.getByText("Slides · 3")).toBeTruthy();
    expect(items().map((li) => li.textContent)).toEqual(["1", "2", "3"]);
  });

  it("pads the top of the scroll area so the selection ring is not clipped", () => {
    const { container } = render(<SlideRail />);
    const scroller = container.querySelector(".overflow-y-auto");
    expect(scroller?.classList.contains("pt-1.5")).toBe(true);
  });

  it("leaves hiding the rail to the top bar", () => {
    render(<SlideRail />);
    expect(screen.queryByRole("button", { name: "Hide slides" })).toBeNull();
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

  it("rings the selected thumbnail with a gap so it stands out on dark slides", () => {
    render(<SlideRail />);
    const selected = items()[0]!.querySelector("button")!;
    const other = items()[1]!.querySelector("button")!;
    expect(selected.classList).toContain("ring-primary");
    expect(selected.classList).toContain("ring-offset-2");
    expect(selected.classList).toContain("ring-offset-sidebar");
    expect(other.classList).not.toContain("ring-offset-2");
  });

  it("lifts every thumbnail off the rail with a shadow, selected or not", () => {
    render(<SlideRail />);
    for (const li of items()) expect(li.querySelector("button")!.classList).toContain("shadow-thumbnail");
  });

  it("adds a blank slide after the selected one and selects it", async () => {
    invoke.mockResolvedValue({ deck: withSlides("intro", "slide", "#2", "outro"), slide: "slide" });
    render(<SlideRail />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New slide" })));
    await act(async () => fireEvent.click(screen.getByTitle("Add blank slide")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("add_slide", { id: "/decks/talk/deck.html", after: "intro" });
    expect(useApp.getState().selected).toBe("slide");
    expect(items()).toHaveLength(4);
  });

  it("adds the first slide of an empty deck", async () => {
    useApp.setState({ deck: { ...DECK, slides: [] }, selected: null });
    invoke.mockResolvedValue({ deck: withSlides("slide"), slide: "slide" });
    render(<SlideRail />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "New slide" })));
    await act(async () => fireEvent.click(screen.getByTitle("Add blank slide")));
    expect(invoke).toHaveBeenCalledWith("add_slide", { id: "/decks/talk/deck.html", after: null });
    expect(useApp.getState().selected).toBe("slide");
  });

  it("duplicates a slide and selects the copy", async () => {
    invoke.mockResolvedValue(edited(withSlides("intro", "#2", "outro", "outro-copy"), ["outro-copy"]));
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(2).getByTitle("Duplicate")));
    expect(invoke).toHaveBeenCalledWith("duplicate_slides", { id: "/decks/talk/deck.html", slides: ["outro"] });
    expect(useApp.getState().selected).toBe("outro-copy");
  });

  it("deleting the selected slide selects the next one", async () => {
    useApp.setState({ selected: "#2" });
    invoke.mockResolvedValue(edited(withSlides("intro", "outro")));
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(1).getByTitle("Delete")));
    expect(invoke).toHaveBeenCalledWith("delete_slides", { id: "/decks/talk/deck.html", slides: ["#2"] });
    expect(useApp.getState().selected).toBe("outro");
    expect(items()).toHaveLength(2);
  });

  it("deleting a slide drops its sketch", async () => {
    const stroke = { tool: "pen" as const, color: "#ef4444", points: [[0.1, 0.2]] as [number, number][] };
    useApp.setState({ sketches: { intro: [stroke], outro: [stroke] } });
    invoke.mockResolvedValue(edited(withSlides("intro", "#2")));
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(2).getByTitle("Delete")));
    expect(useApp.getState().sketches).toEqual({ intro: [stroke] });
  });

  it("keeps the sketch when deleting fails", async () => {
    const stroke = { tool: "pen" as const, color: "#ef4444", points: [[0.1, 0.2]] as [number, number][] };
    useApp.setState({ sketches: { outro: [stroke] } });
    invoke.mockRejectedValue("Slide not found: outro");
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(2).getByTitle("Delete")));
    expect(useApp.getState().sketches).toEqual({ outro: [stroke] });
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
    [
      "Add blank slide",
      () => {
        fireEvent.click(screen.getByRole("button", { name: "New slide" }));
        return screen.getByTitle("Add blank slide");
      },
    ],
    ["Duplicate", () => item(0).getByTitle("Duplicate")],
    ["Delete", () => item(0).getByTitle("Delete")],
  ])("reports a failed %s", async (_, button) => {
    invoke.mockRejectedValue("Slide not found: intro");
    render(<SlideRail />);
    const target = button();
    await act(async () => fireEvent.click(target));
    await waitFor(() => expect(lastError(useApp.getState())).toBe("Slide not found: intro"));
    expect(useApp.getState().deck).toEqual(DECK);
  });
});

describe("hidden slides in the rail", () => {
  beforeEach(() => {
    useApp.setState({ deck: deckFor(HIDDEN_HTML) });
  });

  it("mutes hidden slides and marks them with a closed eye beside the picture, not on it", () => {
    render(<SlideRail />);
    const [intro, , outro] = items() as [HTMLElement, HTMLElement, HTMLElement];
    expect(thumbnail(outro).className).toMatch(/opacity-35/);
    expect(thumbnail(outro).className).toMatch(/grayscale/);
    const mark = within(outro).getByTestId("hidden-mark");
    expect(mark.querySelector("[aria-label='Hidden slide']")).not.toBeNull();
    expect(mark.title).toBe("Hidden: skipped when presenting");
    // Under the number, out of the thumbnail's button.
    expect(outro.querySelector("button[data-thumbnail]")?.contains(mark)).toBe(false);
    expect(within(outro).getByText("3").className).not.toMatch(/line-through/);
    expect(within(outro).getByText("3").className).toMatch(/opacity-60/);

    expect(thumbnail(intro).className).not.toMatch(/opacity-35/);
    expect(markShown(within(intro).getByTestId("hidden-mark"))).toBe(false);
  });

  it("animates a slide's muting and its closed eye", () => {
    render(<SlideRail />);
    const [intro, , outro] = items() as [HTMLElement, HTMLElement, HTMLElement];
    for (const li of [intro, outro]) {
      expect(thumbnail(li).className).toMatch(/\btransition\b/);
      expect(li.querySelector("span")?.className).toMatch(/\btransition\b/);
      expect(within(li).getByTestId("hidden-mark").className).toMatch(/\btransition\b/);
    }
    expect(within(outro).getByTestId("hidden-mark").className).not.toMatch(/opacity-0/);
    expect(within(intro).getByTestId("hidden-mark").className).toMatch(/opacity-0/);
  });

  it("still renders hidden slides in place, keeping their number", () => {
    render(<SlideRail />);
    expect(items()).toHaveLength(3);
    // The count says how many of them a show skips.
    expect(screen.getByText("Slides · 3 (1 hidden)")).toBeTruthy();
    expect(items().map((li) => li.querySelector("span")?.textContent)).toEqual(["1", "2", "3"]);
    expect(thumbnail(items()[2]!)).toBeTruthy();
  });

  it("hides a shown slide", async () => {
    const next = deckFor(HIDDEN_HTML.replace(`id="intro"`, `id="intro" data-hidden`), "2");
    invoke.mockResolvedValue(edited(next));
    render(<SlideRail />);
    await act(async () => fireEvent.click(within(items()[0]!).getByTitle("Hide slide")));
    expect(invoke).toHaveBeenCalledWith("set_slides_hidden", {
      id: "/decks/talk/deck.html",
      slides: ["intro"],
      hidden: true,
    });
    expect(useApp.getState().deck).toEqual(next);
    expect(markShown(within(items()[0]!).getByTestId("hidden-mark"))).toBe(true);
  });

  it("shows a hidden slide again", async () => {
    invoke.mockResolvedValue(edited(deckFor(DECK_HTML, "2")));
    render(<SlideRail />);
    await act(async () => fireEvent.click(within(items()[2]!).getByTitle("Show slide")));
    expect(invoke).toHaveBeenCalledWith("set_slides_hidden", {
      id: "/decks/talk/deck.html",
      slides: ["outro"],
      hidden: false,
    });
    // Still there, so that it can fade out.
    const mark = within(items()[2]!).getByTestId("hidden-mark");
    expect(markShown(mark)).toBe(false);
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(thumbnail(items()[2]!).className).not.toMatch(/opacity-35/);
  });

  it("reports a failed toggle", async () => {
    invoke.mockRejectedValue("disk full");
    render(<SlideRail />);
    await act(async () => fireEvent.click(within(items()[0]!).getByTitle("Hide slide")));
    expect(lastError(useApp.getState())).toBe("disk full");
    expect(useApp.getState().deck?.slides[0]?.hidden).toBe(false);
  });
});

const LOCKED_HTML = DECK_HTML.replace(`id="outro"`, `id="outro" data-locked`);

describe("locked slides in the rail", () => {
  beforeEach(() => {
    useApp.setState({ deck: deckFor(LOCKED_HTML) });
  });

  it("marks locked slides and offers to unlock them", () => {
    render(<SlideRail />);
    expect(markShown(item(2).getByTestId("locked-mark"))).toBe(true);
    expect(item(2).getByTitle("Unlock slide")).toBeTruthy();
    expect(markShown(item(0).getByTestId("locked-mark"))).toBe(false);
    expect(item(0).getByTitle("Lock slide")).toBeTruthy();
  });

  it("cannot delete a locked slide, saying why, but can still duplicate and hide it", () => {
    render(<SlideRail />);
    const trash = item(2).getByRole("button", { name: "Delete" });
    expect(trash.getAttribute("aria-disabled")).toBe("true");
    expect(trash.title).toBe("Locked: unlock to delete");
    expect(item(2).getByTitle("Duplicate")).toBeTruthy();
    expect(item(2).getByTitle("Hide slide")).toBeTruthy();
    expect(item(0).getByTitle("Delete")).toBeTruthy();
  });

  it("locks a slide", async () => {
    const next = deckFor(LOCKED_HTML.replace(`id="intro"`, `id="intro" data-locked`), "2");
    invoke.mockResolvedValue(next);
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(0).getByTitle("Lock slide")));
    expect(invoke).toHaveBeenCalledWith("set_slides_locked", {
      id: "/decks/talk/deck.html",
      slides: ["intro"],
      locked: true,
    });
    expect(useApp.getState().deck).toEqual(next);
    expect(markShown(item(0).getByTestId("locked-mark"))).toBe(true);
    expect(item(0).queryByTitle("Delete")).toBeNull();
  });

  it("unlocks a slide", async () => {
    invoke.mockResolvedValue(deckFor(DECK_HTML, "2"));
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(2).getByTitle("Unlock slide")));
    expect(invoke).toHaveBeenCalledWith("set_slides_locked", {
      id: "/decks/talk/deck.html",
      slides: ["outro"],
      locked: false,
    });
    // Still there, so that it can fade out.
    expect(markShown(item(2).getByTestId("locked-mark"))).toBe(false);
    expect(item(2).getByTestId("locked-mark").getAttribute("aria-hidden")).toBe("true");
    expect(item(2).getByTestId("locked-mark").className).toMatch(/\btransition\b/);
    expect(item(2).getByTitle("Delete")).toBeTruthy();
  });

  it("reports a failed lock", async () => {
    invoke.mockRejectedValue("disk full");
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(0).getByTitle("Lock slide")));
    expect(lastError(useApp.getState())).toBe("disk full");
  });
});

const SECTIONED_HTML = DECK_HTML.replace(
  `<section class="slide">`,
  `<div class="deck-section" data-title="Middle"></div>\n<section class="slide">`,
);
const headers = () => [...document.querySelectorAll<HTMLElement>("[data-testid=section-header]")];
/** The sections' titles, as their headers show them. */
const titles = () => headers().map((li) => li.querySelector(".uppercase")?.textContent);

describe("picking several slides", () => {
  const deck = (locked: string[] = []): Deck => ({
    ...withSlides("a", "b", "c", "d"),
    slides: withSlides("a", "b", "c", "d").slides.map((s) => ({ ...s, locked: locked.includes(s.id) })),
  });
  const button = (index: number) => items()[index]!.querySelector("button")!;
  const picked = () => useApp.getState().railSelected;
  const bulk = () => within(screen.getByRole("toolbar", { name: "Selected slides" }));

  beforeEach(() => useApp.setState({ deck: deck(), selected: "a", railSelected: [] }));
  afterEach(() => useApp.getState().clearSearch());

  it("⌘-click adds and removes slides, and the stage follows the last one added", () => {
    render(<SlideRail />);
    fireEvent.click(button(2), { metaKey: true });
    expect(picked()).toEqual(["a", "c"]);
    expect(useApp.getState().selected).toBe("c");
    expect(button(0).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button(2), { metaKey: true });
    expect(picked()).toEqual([]);
    expect(useApp.getState().selected).toBe("a");
  });

  it("⇧-click picks the range from the selected slide, either way", () => {
    useApp.setState({ selected: "b" });
    render(<SlideRail />);
    fireEvent.click(button(3), { shiftKey: true });
    expect(picked()).toEqual(["b", "c", "d"]);
    fireEvent.click(button(0), { shiftKey: true });
    expect(picked()).toEqual(["a", "b"]);
    expect(useApp.getState().selected).toBe("b");
    expect(bulk().getByRole("status").textContent).toBe("2 selected");
  });

  it("a plain click goes back to one slide", () => {
    render(<SlideRail />);
    fireEvent.click(button(2), { shiftKey: true });
    fireEvent.click(button(1));
    expect(picked()).toEqual([]);
    expect(useApp.getState().selected).toBe("b");
    expect(screen.queryByRole("toolbar", { name: "Selected slides" })).toBeNull();
  });

  it("⇧-click while searching picks every slide on the way, as all of them are listed", () => {
    render(<SlideRail />);
    act(() => {
      useApp.getState().setSearch({ query: "x" });
      useApp.getState().setSearchMatches([
        { slide: "a", index: 0, locked: false, notes: false, before: "", text: "x", after: "" },
        { slide: "c", index: 2, locked: false, notes: false, before: "", text: "x", after: "" },
      ]);
    });
    fireEvent.click(button(3), { shiftKey: true });
    expect(picked()).toEqual(["a", "b", "c", "d"]);
  });

  it("deletes the picked slides at once, skipping locked ones, and selects a neighbor", async () => {
    useApp.setState({ deck: deck(["b"]), railSelected: ["a", "b", "c"], selected: "c" });
    invoke.mockResolvedValue(edited(withSlides("b", "d")));
    render(<SlideRail />);
    const trash = bulk().getByRole("button", { name: "Delete slides" });
    expect(trash.title).toMatch(/^Delete slides \(not the 1 locked\)/);
    await act(async () => fireEvent.click(trash));
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "delete_slides")).toEqual([
      ["delete_slides", { id: DECK.id, slides: ["a", "c"] }],
    ]);
    expect(useApp.getState().selected).toBe("d");
    expect(picked()).toEqual([]);
  });

  it("offers no deleting or hiding when every picked slide is locked", () => {
    useApp.setState({ deck: deck(["a", "b"]), railSelected: ["a", "b"] });
    render(<SlideRail />);
    const trash = bulk().getByRole("button", { name: "Delete slides" }) as HTMLButtonElement;
    expect(trash.disabled).toBe(true);
    expect(trash.title).toBe("These slides are locked: unlock them to delete");
    expect((bulk().getByRole("button", { name: "Hide slides" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the picked slides, or shows them when all are hidden", async () => {
    useApp.setState({ railSelected: ["a", "b"] });
    invoke.mockResolvedValue(edited(deck()));
    render(<SlideRail />);
    await act(async () => fireEvent.click(bulk().getByTitle("Hide slides")));
    expect(invoke).toHaveBeenCalledWith("set_slides_hidden", { id: DECK.id, slides: ["a", "b"], hidden: true });

    act(() =>
      useApp.setState({
        deck: { ...deck(), slides: deck().slides.map((s) => ({ ...s, hidden: s.id < "c" })) },
        railSelected: ["a", "b"],
      }),
    );
    await act(async () => fireEvent.click(bulk().getByTitle("Show slides")));
    expect(invoke).toHaveBeenCalledWith("set_slides_hidden", { id: DECK.id, slides: ["a", "b"], hidden: false });
  });

  it("duplicates the picked slides and picks the copies", async () => {
    useApp.setState({ railSelected: ["c", "a"] });
    invoke.mockResolvedValue(edited(withSlides("a", "a-copy", "b", "c", "c-copy", "d"), ["a-copy", "c-copy"]));
    render(<SlideRail />);
    await act(async () => fireEvent.click(bulk().getByRole("button", { name: "Duplicate slides" })));
    expect(invoke).toHaveBeenCalledWith("duplicate_slides", { id: DECK.id, slides: ["a", "c"] });
    expect(picked()).toEqual(["a-copy", "c-copy"]);
    expect(useApp.getState().selected).toBe("c-copy");
  });

  it("moves the picked slides a row, and shows it before the backend answers", async () => {
    useApp.setState({ railSelected: ["b", "c"] });
    let answer: (value: unknown) => void = () => {};
    invoke.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<SlideRail />);
    act(() => void useApp.getState().moveSlides(-1));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reorder_slides", { id: DECK.id, slides: ["b", "c", "a", "d"] }),
    );
    expect(items().map((li) => li.querySelector("button[data-thumbnail]")?.getAttribute("aria-label"))).toEqual([
      "Slide 1, B",
      "Slide 2, C",
      "Slide 3, A",
      "Slide 4, D",
    ]);
    await act(async () => answer(edited(withSlides("b", "c", "a", "d"))));
    expect(picked()).toEqual(["b", "c"]);
  });

  it("puts the selection bar in the header's place, so the list under it does not move", () => {
    render(<SlideRail />);
    const header = screen.getByRole("button", { name: "New slide" }).closest(".h-10");
    fireEvent.click(button(1), { shiftKey: true });
    expect(screen.queryByRole("button", { name: "New slide" })).toBeNull();
    expect(bulk().getByRole("status").closest(".h-10")).toBe(header);
  });
});

describe("moving a section", () => {
  const section = (index: number, title: string, before: number) => ({ index, title, before }) as Section;
  const deck: Deck = {
    ...withSlides("a", "b", "c", "d", "e"),
    sections: [section(0, "One", 1), section(1, "Two", 3)],
  };
  const header = (title: string) => headers().find((li) => li.textContent?.includes(title))!;
  const slideRows = () => items().filter((li) => "railSlide" in li.dataset && !li.classList.contains("h-0"));
  const animate = vi.fn();
  const pickUp = (li: HTMLElement) =>
    act(() => {
      fireEvent.pointerDown(li, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(document, { isPrimary: true, clientX: 10, clientY: 40 });
    });
  const letGo = async () =>
    act(async () => {
      fireEvent.pointerUp(document, { isPrimary: true, clientX: 10, clientY: 40 });
    });

  beforeEach(() => {
    useApp.setState({ deck, selected: "a", railSelected: [] });
    animate.mockClear();
    HTMLElement.prototype.animate = animate;
    // jsdom has no layout: put the two section rows one above the other.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const title = this.textContent ?? "";
      const top = title.startsWith("One") ? 40 : title.startsWith("Two") ? 80 : 0;
      return { top, bottom: top + 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: top } as DOMRect;
    });
  });
  // A drag swallows clicks until dnd-kit drops its guard, 50ms after the drag ends. This timer
  // starts later with the same delay, so it fires after dnd-kit's.
  afterEach(async () => {
    await letGo();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    vi.restoreAllMocks();
  });

  it("folds every section to its heading while one is dragged, keeping the thumbnails mounted", () => {
    render(<SlideRail />);
    expect(slideRows()).toHaveLength(5);
    pickUp(header("Two"));
    expect(slideRows()).toHaveLength(0);
    expect(items().filter((li) => li.querySelector("iframe, button > div"))).toHaveLength(5);
    expect(items().some((li) => li.classList.contains("hidden"))).toBe(false);
    expect(headers().map((li) => li.textContent)).toEqual(["One2 slides", "Two2 slides"]);
    expect(screen.getByTestId("loose-slides").textContent).toBe("1 slide");
    expect(screen.getByTestId("section-overlay").textContent).toBe("Two2 slides");
  });

  it("animates the slides shut, and open again from their place when dropped", async () => {
    render(<SlideRail />);
    pickUp(header("Two"));
    const shrinking = animate.mock.calls.filter(([frames]) => frames[0].height !== undefined);
    expect(shrinking).toHaveLength(5);
    expect(shrinking[0]![0].at(-1)).toMatchObject({ height: "0px", opacity: 0 });
    animate.mockClear();
    await letGo();
    expect(animate).toHaveBeenCalledTimes(5);
    expect(animate.mock.calls[0]![0][0]).toMatchObject({ height: "0px", opacity: 0 });
    expect(animate.mock.calls[0]![0][1]).toMatchObject({ opacity: 1 });
  });

  it("has the rows measured again as they fold, as they are sorted by where they are", async () => {
    render(<SlideRail />);
    const measured = () =>
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mock.contexts.filter((el) => el === header("One")).length;
    pickUp(header("Two"));
    const before = measured();
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(measured()).toBeGreaterThan(before);
  });

  it("leaves a collapsed section's slides hidden while a section is dragged, and after", async () => {
    useApp.setState({ collapsedSections: ["b"] });
    render(<SlideRail />);
    const hidden = () => items().filter((li) => li.classList.contains("hidden"));
    expect(hidden()).toHaveLength(2);
    pickUp(header("Two"));
    expect(hidden()).toHaveLength(2);
    expect(headers().map((li) => li.textContent)).toEqual(["One2 slides", "Two2 slides"]);
    await letGo();
    expect(hidden()).toHaveLength(2);
    expect(useApp.getState().collapsedSections).toEqual(["b"]);
  });

  it("folds by the height of a slide that shows, not one in a collapsed section", () => {
    useApp.setState({
      deck: { ...deck, sections: [section(0, "One", 0), section(1, "Two", 3)] },
      collapsedSections: ["a"],
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("hidden") ? 0 : 108;
    });
    render(<SlideRail />);
    pickUp(header("Two"));
    const shrinking = animate.mock.calls.filter(([frames]) => frames[0].height !== undefined);
    expect(shrinking[0]![0][0]).toMatchObject({ height: "108px" });
  });

  it("does not fold anything while a slide is dragged", () => {
    render(<SlideRail />);
    pickUp(items()[0]!);
    expect(slideRows()).toHaveLength(5);
    expect(screen.queryByTestId("loose-slides")).toBeNull();
  });

  it("names no loose slides when the deck opens with a section", () => {
    useApp.setState({ deck: { ...deck, sections: [section(0, "One", 0)] } });
    render(<SlideRail />);
    pickUp(header("One"));
    expect(screen.queryByTestId("loose-slides")).toBeNull();
    expect(header("One").textContent).toBe("One5 slides");
  });

  it("opens the sections again without saving when dropped in place", async () => {
    render(<SlideRail />);
    act(() => {
      fireEvent.pointerDown(header("Two"), { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(document, { isPrimary: true, clientX: 10, clientY: 16 });
    });
    await letGo();
    expect(slideRows()).toHaveLength(5);
    expect(screen.queryByTestId("loose-slides")).toBeNull();
    expect(titles()).toEqual(["One", "Two"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens the sections again when the drag is cancelled", () => {
    render(<SlideRail />);
    pickUp(header("Two"));
    act(() => {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    });
    expect(slideRows()).toHaveLength(5);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("takes the section's slides along when it lands on another section", async () => {
    invoke.mockResolvedValue(edited({ ...deck, sections: [section(0, "Two", 1), section(1, "One", 3)] }));
    render(<SlideRail />);
    pickUp(header("Two"));
    await act(async () => {
      fireEvent.pointerMove(document, { isPrimary: true, clientX: 10, clientY: -30 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await letGo();
    expect(invoke).toHaveBeenCalledWith("reorder_slides", {
      id: deck.id,
      slides: ["a", "section:1", "d", "e", "section:0", "b", "c"],
    });
    expect(titles()).toEqual(["Two", "One"]);
  });
});

describe("collapsing a section", () => {
  const section = (index: number, title: string, before: number) => ({ index, title, before }) as Section;
  const deck: Deck = {
    ...withSlides("a", "b", "c", "d", "e"),
    sections: [section(0, "One", 1), section(1, "Two", 3), section(2, "Empty", 5)],
  };
  const shownSlides = () =>
    items()
      .filter((li) => "railSlide" in li.dataset && !li.classList.contains("hidden"))
      .map(number);
  const header = (title: string) => within(headers().find((li) => li.textContent?.includes(title))!);

  beforeEach(() => useApp.setState({ deck, selected: "a", railSelected: [] }));
  afterEach(() => useApp.getState().clearSearch());

  it("folds a section's slides under its header, saying how many, and opens it again", () => {
    render(<SlideRail />);
    expect(shownSlides()).toEqual(["1", "2", "3", "4", "5"]);
    const toggle = header("One").getByTitle("Collapse section");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(useApp.getState().collapsedSections).toEqual(["b"]);
    expect(shownSlides()).toEqual(["1", "4", "5"]);
    expect(header("One").getByTestId("folded-count").textContent).toBe("2 slides");
    // The thumbnails stay mounted, so opening the section does not reload them.
    expect(items().filter((li) => "railSlide" in li.dataset)).toHaveLength(5);
    fireEvent.click(header("One").getByTitle("Expand section"));
    expect(shownSlides()).toEqual(["1", "2", "3", "4", "5"]);
    expect(header("One").queryByTestId("folded-count")).toBeNull();
  });

  it("offers no toggle on a section without slides", () => {
    render(<SlideRail />);
    expect(header("Empty").queryByTitle("Collapse section")).toBeNull();
  });

  it("toggling does not select or start dragging the header", () => {
    render(<SlideRail />);
    fireEvent.click(header("Two").getByTitle("Collapse section"));
    expect(useApp.getState().selected).toBe("a");
    expect(shownSlides()).toEqual(["1", "2", "3"]);
  });

  it("opens a folded section when its slide is selected from elsewhere", () => {
    useApp.setState({ collapsedSections: ["b", "d"] });
    render(<SlideRail />);
    expect(shownSlides()).toEqual(["1"]);
    act(() => useApp.getState().selectRelative(1));
    expect(useApp.getState().collapsedSections).toEqual(["d"]);
    expect(shownSlides()).toEqual(["1", "2", "3"]);
  });

  it("keeps the section folded when it holds the slide already selected", () => {
    useApp.setState({ selected: "b" });
    render(<SlideRail />);
    fireEvent.click(header("One").getByTitle("Collapse section"));
    expect(shownSlides()).toEqual(["1", "4", "5"]);
  });

  it("opens the folds while a search is on, so its matches show wherever they are", () => {
    useApp.setState({ collapsedSections: ["b"] });
    render(<SlideRail />);
    act(() => {
      useApp.getState().setSearch({ query: "x" });
      useApp
        .getState()
        .setSearchMatches([{ slide: "c", index: 0, locked: false, notes: false, before: "", text: "x", after: "" }]);
    });
    expect(shownSlides()).toEqual(["1", "2", "3", "4", "5"]);
    act(() => useApp.getState().clearSearch());
    expect(shownSlides()).toEqual(["1", "4", "5"]);
  });

  it("says how many slides an open section holds, and how many a folded one", () => {
    render(<SlideRail />);
    expect(header("One").getByTestId("section-count").textContent).toBe("2");
    fireEvent.click(header("One").getByTitle("Collapse section"));
    expect(header("One").queryByTestId("section-count")).toBeNull();
    expect(header("One").getByTestId("folded-count").textContent).toBe("2 slides");
  });

  it("toggles a fold, or sets it either way when told which", () => {
    useApp.setState({ collapsedSections: ["b"] });
    act(() => useApp.getState().toggleSection("d"));
    expect(useApp.getState().collapsedSections).toEqual(["b", "d"]);
    act(() => useApp.getState().toggleSection("d", true));
    expect(useApp.getState().collapsedSections).toEqual(["b", "d"]);
    act(() => useApp.getState().toggleSection("b", false));
    expect(useApp.getState().collapsedSections).toEqual(["d"]);
  });
});

describe("double-clicking a thumbnail", () => {
  const button = (index: number) => items()[index]!.querySelector("button")!;
  beforeEach(() => useApp.setState({ deck: withSlides("a", "b"), selected: "a", editing: false }));
  afterEach(() => useApp.getState().setMode("view"));

  it("edits that slide", () => {
    render(<SlideRail />);
    fireEvent.doubleClick(button(1));
    expect(useApp.getState()).toMatchObject({ selected: "b", editing: true });
  });

  it("enters edit mode on a locked slide too, where it can be unlocked", () => {
    const deck = withSlides("a", "b");
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s) => ({ ...s, locked: s.id === "b" })) } });
    render(<SlideRail />);
    fireEvent.doubleClick(button(1));
    expect(useApp.getState()).toMatchObject({ selected: "b", editing: true });
  });

  it("does not open the slide when a quick action on it is double-clicked", () => {
    render(<SlideRail />);
    fireEvent.doubleClick(item(1).getByRole("button", { name: "Duplicate" }));
    expect(useApp.getState().editing).toBe(false);
  });
});

describe("in View mode, which organises the slides as Edit does", () => {
  const sectioned = (): Deck => ({
    ...withSlides("a", "b", "c"),
    sections: [{ index: 0, title: "One", before: 1 } as Section],
  });
  beforeEach(() => useApp.setState({ deck: sectioned(), selected: "a", editing: false }));

  it("offers the quick actions and the section's own, as in Edit", () => {
    render(<SlideRail />);
    expect(item(0).getByRole("button", { name: "Lock slide" })).toBeTruthy();
    expect(item(0).getByRole("button", { name: "Delete" }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.doubleClick(screen.getByText("One"));
    expect(screen.getByLabelText("Section title")).toBeTruthy();
  });

  it("starts a section and opens the layouts without leaving View", () => {
    render(<SlideRail />);
    const section = screen.getByRole("button", { name: "Start a section at this slide" }) as HTMLButtonElement;
    expect(section.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "New slide" }));
    expect(useApp.getState().editing).toBe(false);
    expect(screen.getByTitle("Add blank slide")).toBeTruthy();
  });

  it("lets slides and sections be dragged, and says how to edit one in its tooltip", () => {
    render(<SlideRail />);
    const draggable = () =>
      items().map((li) => li.getAttribute("data-draggable") ?? String(li.getAttribute("aria-disabled") !== "true"));
    expect(draggable()).toEqual(["true", "true", "true", "true"]);
    expect(screen.getByRole("button", { name: "Slide 1, A" }).title).toBe("Slide 1 · A · double-click to edit");
    act(() => useApp.getState().setMode("edit"));
    expect(screen.getByRole("button", { name: "Slide 1, A" }).title).toBe("Slide 1 · A");
  });

  it("keeps the picked slides' tools on", () => {
    render(<SlideRail />);
    act(() => useApp.getState().extendRailSelection("b", "toggle"));
    const bulk = within(screen.getByRole("toolbar", { name: "Selected slides" }));
    for (const name of ["Hide slides", "Duplicate slides", "Delete slides", "Clear selection"]) {
      expect((bulk.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("tells an empty deck where to add its first slide", () => {
    useApp.setState({ deck: withSlides(), selected: null });
    render(<SlideRail />);
    expect(screen.getByText(/add a slide with the \+ above/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "All slides" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("sections in the rail", () => {
  beforeEach(() => {
    useApp.setState({ deck: deckFor(SECTIONED_HTML) });
  });

  it("shows a header row before the slide that starts the section, without numbering it", () => {
    render(<SlideRail />);
    expect(
      items().map((li) =>
        li.dataset.testid === "section-header" ? li.querySelector(".uppercase")?.textContent : number(li),
      ),
    ).toEqual(["1", "Middle", "2", "3"]);
    expect(screen.getByText("Slides · 3")).toBeTruthy();
  });

  it("shows a placeholder for an untitled section", () => {
    useApp.setState({ deck: { ...deckFor(SECTIONED_HTML), sections: [{ index: 0, title: "", before: 1 }] } });
    render(<SlideRail />);
    expect(screen.getByText("Untitled section")).toBeTruthy();
  });

  it("starts a section at the selected slide and lets you name it", async () => {
    useApp.setState({ deck: DECK, selected: "outro" });
    invoke.mockResolvedValue(
      deckFor(
        DECK_HTML.replace(
          `<section class="slide" id="outro">`,
          `<div class="deck-section" data-title="New section"></div>\n<section class="slide" id="outro">`,
        ),
      ),
    );
    render(<SlideRail />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start a section at this slide" })));
    expect(invoke).toHaveBeenCalledWith("add_section", {
      id: "/decks/talk/deck.html",
      before: "outro",
      title: "New section",
    });
    expect(headers()).toHaveLength(1);
    const input = screen.getByLabelText("Section title") as HTMLInputElement;
    expect(input.value).toBe("New section");
  });

  it("cannot start a second section at a slide that already starts one", () => {
    useApp.setState({ selected: "#2" });
    render(<SlideRail />);
    const button = screen.getByRole("button", { name: "Start a section at this slide" }) as HTMLButtonElement;
    expect(button.title).toBe("This slide already starts a section");
    expect(button.disabled).toBe(true);
  });

  it("cannot add a section without a selected slide", () => {
    useApp.setState({ deck: { ...DECK, slides: [] }, selected: null });
    render(<SlideRail />);
    const button = screen.getByRole("button", { name: "Start a section at this slide" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Select a slide to start a section");
  });

  it("renames a section by double-clicking its title", async () => {
    const renamed = deckFor(SECTIONED_HTML.replace("Middle", "Core"), "2");
    invoke.mockResolvedValue(renamed);
    render(<SlideRail />);
    fireEvent.doubleClick(screen.getByText("Middle"));
    const input = screen.getByLabelText("Section title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Core  " } });
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    await act(async () => fireEvent.blur(input));
    expect(invoke).toHaveBeenCalledWith("rename_section", { id: "/decks/talk/deck.html", index: 0, title: "Core" });
    expect(useApp.getState().deck).toEqual(renamed);
    expect(screen.queryByLabelText("Section title")).toBeNull();
  });

  it("renames through the hover action and cancels with Escape", async () => {
    render(<SlideRail />);
    fireEvent.click(within(headers()[0]!).getByTitle("Rename section"));
    const input = screen.getByLabelText("Section title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Changed" } });
    await act(async () => fireEvent.keyDown(input, { key: "Escape" }));
    await act(async () => fireEvent.blur(input));
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Section title")).toBeNull();
    expect(screen.getByText("Middle")).toBeTruthy();
  });

  it("does not save an empty or unchanged title", async () => {
    render(<SlideRail />);
    for (const value of ["", "   ", "Middle"]) {
      fireEvent.doubleClick(screen.getByText("Middle"));
      const input = screen.getByLabelText("Section title");
      fireEvent.change(input, { target: { value } });
      await act(async () => fireEvent.blur(input));
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("removes a section but keeps its slides", async () => {
    invoke.mockResolvedValue(deckFor(DECK_HTML, "2"));
    render(<SlideRail />);
    fireEvent.click(within(headers()[0]!).getByRole("button", { name: "More actions" }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Remove section (keeps its slides)" })));
    expect(invoke).toHaveBeenCalledWith("delete_section", { id: "/decks/talk/deck.html", index: 0 });
    expect(headers()).toHaveLength(0);
    expect(items()).toHaveLength(3);
  });

  it.each([
    ["Rename section", "rename_section"],
    ["Remove section (keeps its slides)", "delete_section"],
  ])("reports a failed %s", async (title, command) => {
    invoke.mockRejectedValue("Section not found: 0");
    render(<SlideRail />);
    if (command === "rename_section") {
      fireEvent.click(within(headers()[0]!).getByTitle(title));
      const input = screen.getByLabelText("Section title");
      fireEvent.change(input, { target: { value: "X" } });
      await act(async () => fireEvent.blur(input));
    } else {
      fireEvent.click(within(headers()[0]!).getByRole("button", { name: "More actions" }));
      await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: title })));
    }
    await waitFor(() => expect(lastError(useApp.getState())).toBe("Section not found: 0"));
  });

  it("reports a failed add", async () => {
    invoke.mockRejectedValue("Slide not found: intro");
    render(<SlideRail />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start a section at this slide" })));
    await waitFor(() => expect(lastError(useApp.getState())).toBe("Slide not found: intro"));
    expect(screen.queryByLabelText("Section title")).toBeNull();
  });
  describe("dragging a slide", () => {
    // The stage shows the slide in an iframe. A pointer over an iframe sends its events to the
    // iframe's document, so the rail never saw the move or the release and the drag stuck.
    const startDrag = (li: HTMLElement) => {
      // A slide is dragged by its thumbnail, the row's one button.
      fireEvent.pointerDown(li.querySelector("button[data-thumbnail]")!, {
        isPrimary: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      fireEvent.pointerMove(document, { isPrimary: true, clientX: 10, clientY: 40 });
    };
    // A drag swallows clicks until dnd-kit drops its guard, 50ms after the drag ends; one the rail
    // was unmounted under is ended here, or the guard would stay for the tests after.
    afterEach(async () => {
      fireEvent.pointerUp(document, { isPrimary: true, clientX: 10, clientY: 40 });
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 60)));
    });
    const stageFrame = () => {
      const frame = document.createElement("iframe");
      frame.style.pointerEvents = "auto";
      document.body.appendChild(frame);
      return frame;
    };

    it("keeps iframes from swallowing the pointer while a slide is dragged", () => {
      render(<SlideRail />);
      const frame = stageFrame();
      expect(getComputedStyle(frame).pointerEvents).toBe("auto");

      act(() => startDrag(items()[0]!));
      expect(getComputedStyle(frame).pointerEvents).toBe("none");

      act(() => {
        fireEvent.pointerUp(document, { isPrimary: true, clientX: 10, clientY: 40 });
      });
      expect(getComputedStyle(frame).pointerEvents).toBe("auto");
      frame.remove();
    });

    it("gives iframes the pointer back when a drag is cancelled", () => {
      render(<SlideRail />);
      const frame = stageFrame();
      act(() => startDrag(items()[0]!));
      expect(getComputedStyle(frame).pointerEvents).toBe("none");

      act(() => {
        fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
      });
      expect(getComputedStyle(frame).pointerEvents).toBe("auto");
      frame.remove();
    });

    it("gives iframes the pointer back when the rail unmounts mid-drag", () => {
      const { unmount } = render(<SlideRail />);
      const frame = stageFrame();
      act(() => startDrag(items()[0]!));
      expect(getComputedStyle(frame).pointerEvents).toBe("none");

      unmount();
      expect(getComputedStyle(frame).pointerEvents).toBe("auto");
      frame.remove();
    });
  });
});

describe("a slide's row, for the keyboard and a screen reader", () => {
  const thumb = (name: string | RegExp) =>
    screen.getByRole("button", {
      name: typeof name === "string" ? new RegExp(`^${name}\\b`) : name,
    }) as HTMLButtonElement;

  it("is one button named by its number and what is special about the slide, current when shown", () => {
    const deck = deckFor(DECK_HTML.replace(`id="outro"`, `id="outro" data-hidden data-locked`));
    useApp.setState({ deck, selected: "intro", comments: { outro: [{ id: "c", text: "Hm", x: 0, y: 0 }] } });
    render(<SlideRail />);
    expect(thumb("Slide 1").getAttribute("aria-current")).toBe("true");
    expect(thumb("Slide 2").getAttribute("aria-current")).toBeNull();
    expect(thumb("Slide 3, Outro, hidden, locked, 1 comment")).toBeTruthy();
    expect(thumb("Slide 3").title).toBe("Slide 3 · Outro");
    // A name that says no more than the number is left out.
    expect(thumb("Slide 2").title).toBe("Slide 2");
    // The row itself is no button around its button, and takes no tab stop of its own.
    for (const li of items()) {
      expect(li.getAttribute("role")).toBeNull();
      expect(li.getAttribute("tabindex")).toBeNull();
      expect(li.querySelectorAll("button[data-thumbnail]")).toHaveLength(1);
    }
    expect(thumb("Slide 1").className).toContain("focus-visible:outline-2");
    useApp.setState({ comments: {} });
  });

  it("shows the quick actions under the pointer and with the keyboard's focus in the row, one row at a time", () => {
    render(<SlideRail />);
    const actions = items()[0]!.querySelector<HTMLElement>("[data-slide-actions]")!;
    expect(actions.className).toContain("group-hover/slide:flex");
    expect(actions.className).toContain("group-has-[:focus-visible]/slide:flex");
    // Not for a focus the mouse left behind, which would show them on two rows at once.
    expect(actions.className).not.toContain("focus-within");
    expect(document.querySelector("ol")!.className).toContain(
      "[&:has(li:hover)_li:not(:hover)_[data-slide-actions]]:hidden!",
    );
    expect(item(0).getByRole("button", { name: "Duplicate" })).toBeTruthy();
  });

  it("folds the quick actions into one button that opens the slide's menu on a small thumbnail", () => {
    render(<SlideRail />);
    const more = item(0).getByRole("button", { name: "More actions" });
    expect(more.parentElement!.className).toContain("@[150px]:hidden");
    expect(item(0).getByRole("button", { name: "Duplicate" }).parentElement!.className).toContain("@[150px]:flex");
    fireEvent.click(more);
    expect(screen.getByRole("menu", { name: "Slide" })).toBeTruthy();
    expect(useApp.getState().selected).toBe("intro");
  });

  it("marks speaker notes, narration and the deck check's problems under the number, out of the picture", () => {
    const deck = withSlides("a", "b", "c");
    useApp.setState({
      deck: {
        ...deck,
        slides: deck.slides.map((s, i) => (i === 1 ? { ...s, notes: "Say hi", narration: "Hello" } : s)),
      },
      lint: [
        { rule: "x", severity: "warning", message: "m", line: 3, slide: "c" },
        { rule: "y", severity: "error", message: "m", line: 4, slide: "c" },
      ],
    });
    render(<SlideRail />);
    expect(item(1).getByTestId("notes-mark").title).toBe("Has speaker notes");
    expect(item(1).getByTestId("narration-mark").title).toBe("Has narration");
    expect(item(0).queryByTestId("notes-mark")).toBeNull();
    const problem = item(2).getByTestId("problem-mark");
    expect(problem.title).toMatch(/^2 problems found by the deck check/);
    expect(problem.className).toContain("text-destructive");
    for (const li of items()) {
      for (const mark of li.querySelectorAll("[data-testid$=-mark], [data-testid$=-count]")) {
        expect(li.querySelector("button[data-thumbnail]")!.parentElement!.contains(mark)).toBe(false);
      }
    }
    expect(thumb("Slide 2").getAttribute("aria-label")).toBe("Slide 2, B, has speaker notes, has narration");
  });

  it("moves the focus along when the keys go to another slide from a thumbnail", () => {
    render(<SlideRail />);
    thumb("Slide 1").focus();
    act(() => useApp.getState().selectRelative(1));
    expect(document.activeElement).toBe(thumb("Slide 2"));
    // With the focus elsewhere, it stays there.
    (document.activeElement as HTMLElement).blur();
    act(() => useApp.getState().selectRelative(1));
    expect(document.activeElement).toBe(document.body);
  });

  it("picks a slide up with Space to move it with the arrows, leaving Enter to select it", () => {
    render(<SlideRail />);
    const first = thumb("Slide 1");
    first.focus();
    const enter = fireEvent.keyDown(first, { key: "Enter", code: "Enter" });
    expect(enter).toBe(true);
    const space = fireEvent.keyDown(first, { key: " ", code: "Space" });
    // dnd-kit took the key: the row is being moved.
    expect(space).toBe(false);
    act(() => void fireEvent.keyDown(document, { key: "Escape", code: "Escape" }));
  });

  it("counts a slide's comments and, while a search is on, its matches, on the thumbnail", () => {
    useApp.setState({ comments: { intro: [1, 2].map((n) => ({ id: `c${n}`, text: "Hm", x: 0, y: 0 })) } });
    render(<SlideRail />);
    expect(item(0).getByTestId("comment-count").textContent).toBe("2");
    expect(item(0).getByTestId("comment-count").title).toBe("2 comments");
    expect(item(1).queryByTestId("comment-count")).toBeNull();
    expect(item(0).queryByTestId("match-count")).toBeNull();
    const found = (slide: string) => ({
      slide,
      index: 0,
      locked: false,
      notes: false,
      before: "",
      text: "x",
      after: "",
    });
    act(() => {
      useApp.getState().setSearch({ query: "x" });
      useApp.getState().setSearchMatches([found("intro"), found("intro"), found("intro")]);
    });
    expect(item(0).getByTestId("match-count").textContent).toBe("3");
    act(() => useApp.getState().clearSearch());
    useApp.setState({ comments: {} });
  });
});

describe("the menu of a right-click", () => {
  beforeEach(() => {
    useApp.setState({ railSelected: [] });
    useApp.getState().clearSearch();
  });
  const thumb = (n: number) => screen.getByRole("button", { name: new RegExp(`^Slide ${n}\\b`) });
  const menu = () => within(screen.getByRole("menu"));
  const choice = (name: string | RegExp) => menu().getByRole("menuitem", { name }) as HTMLButtonElement;
  const off = (name: string | RegExp) => choice(name).getAttribute("aria-disabled") === "true";
  const edit = (deck: unknown, created: string[] = []) => edited(deck, created);

  it("picks the slide it was asked for on, and lists what can be done with it, with the keys", () => {
    render(<SlideRail />);
    fireEvent.contextMenu(thumb(3), { clientX: 30, clientY: 40 });
    expect(useApp.getState().selected).toBe("outro");
    expect(screen.getByRole("menu", { name: "Slide" })).toBeTruthy();
    expect(
      menu()
        .getAllByRole("menuitem")
        .map((b) => b.textContent),
    ).toEqual([
      "Present from this slideCtrl+Enter",
      "New slide…Ctrl+Shift+N",
      "DuplicateCtrl+D",
      "CopyCtrl+C",
      "CutCtrl+X",
      "Paste afterCtrl+V",
      "DeleteBackspace",
      "Hide",
      "Lock",
      "Move upCtrl+↑",
      "Move downCtrl+↓",
      "Start section here",
    ]);
    // A press beside it, or Escape, puts it away.
    fireEvent.pointerDown(screen.getByTestId("context-menu-cover"));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(thumb(3));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("is about every picked slide when the one asked on is among them", async () => {
    render(<SlideRail />);
    act(() => useApp.getState().extendRailSelection("outro", "toggle"));
    fireEvent.contextMenu(thumb(1));
    expect(useApp.getState().railSelected).toEqual(["intro", "outro"]);
    // Locking answers with the deck, the rail's other changes with the deck and what they did.
    invoke.mockImplementation(async (command) => (command === "set_slides_locked" ? DECK : edit(DECK)));
    await act(async () => fireEvent.click(choice(/^Hide/)));
    // A change waits for the ones before it, so it may take a moment.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("set_slides_hidden", {
        id: DECK.id,
        slides: ["intro", "outro"],
        hidden: true,
      }),
    );
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.contextMenu(thumb(1));
    await act(async () => fireEvent.click(choice(/^Lock/)));
    expect(invoke).toHaveBeenCalledWith("set_slides_locked", { id: DECK.id, slides: ["intro", "outro"], locked: true });

    fireEvent.contextMenu(thumb(3));
    await act(async () => fireEvent.click(choice(/^Copy/)));
    expect(invoke).toHaveBeenCalledWith("copy_slides", { id: DECK.id, slides: ["intro", "outro"] });

    // Asked on a slide that is not picked, it is about that one alone.
    fireEvent.contextMenu(thumb(2));
    expect(useApp.getState()).toMatchObject({ selected: "#2", railSelected: [] });
    await act(async () => fireEvent.click(choice(/^Duplicate/)));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("duplicate_slides", { id: DECK.id, slides: ["#2"] }));
  });

  it.each([
    [/^Cut/, "copy_slides", { id: DECK.id, slides: ["#2"] }],
    [/^Paste after/, "paste_slides", { id: DECK.id, after: "#2" }],
    [/^Delete/, "delete_slides", { id: DECK.id, slides: ["#2"] }],
    [/^Move down/, "reorder_slides", { id: DECK.id, slides: ["intro", "outro", "#2"] }],
  ])("does %s", async (name, command, args) => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "add_slide" ? { deck: DECK, slide: "intro" } : cmd === "paste_slides" ? null : edit(DECK),
    );
    render(<SlideRail />);
    fireEvent.contextMenu(thumb(2));
    await act(async () => fireEvent.click(choice(name)));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(command, args));
  });

  it("starts a section at the slide, and goes on to naming it", async () => {
    const next = { ...DECK, sections: [{ index: 0, title: "New section", before: 2 } as Section] };
    invoke.mockResolvedValue(next);
    render(<SlideRail />);
    fireEvent.contextMenu(thumb(3));
    await act(async () => fireEvent.click(choice("Start section here")));
    expect(invoke).toHaveBeenCalledWith("add_section", { id: DECK.id, before: "outro", title: "New section" });
    expect(screen.getByLabelText("Section title")).toBeTruthy();
  });

  it("opens the layouts from New slide…, as the + and its keys do", async () => {
    render(<SlideRail />);
    fireEvent.contextMenu(thumb(2));
    fireEvent.click(choice(/^New slide/));
    expect(useApp.getState().addingSlide).toBe(true);
    expect(screen.getByRole("dialog", { name: "New slide" })).toBeTruthy();
    // Blank comes first, and has the focus, so Enter adds one.
    expect(within(screen.getByRole("dialog")).getAllByRole("button")[0]!.getAttribute("aria-label")).toBe(
      "Blank slide",
    );
    await waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Blank slide"));
  });

  it("says so when there is nothing to paste", async () => {
    invoke.mockResolvedValue(null);
    render(<SlideRail />);
    fireEvent.contextMenu(thumb(2));
    await act(async () => fireEvent.click(choice(/^Paste after/)));
    expect(useApp.getState().toasts.at(-1)).toMatchObject({
      kind: "info",
      text: expect.stringMatching(/^There are no slides to paste\. Copy some first/),
    });
  });

  it("offers editing the slide and presenting from it, and the same organising choices in View as in Edit", async () => {
    useApp.setState({ editing: false });
    render(<SlideRail />);
    fireEvent.contextMenu(thumb(2));
    expect(menu().getAllByRole("menuitem")[0]!.textContent).toBe("Edit slide");
    for (const name of [
      /^New slide/,
      /^Duplicate/,
      /^Cut/,
      /^Paste/,
      /^Delete/,
      /^Hide/,
      /^Lock/,
      /^Move up/,
      /^Start/,
    ]) {
      expect(off(name)).toBe(false);
    }
    fireEvent.click(choice("Edit slide"));
    expect(useApp.getState()).toMatchObject({ selected: "#2", editing: true });
    // In Edit the slide on the stage is the one being edited already.
    fireEvent.contextMenu(thumb(2));
    expect(menu().queryByRole("menuitem", { name: "Edit slide" })).toBeNull();
  });

  it("says why a locked slide is not deleted, and lets the slides move during a search", () => {
    const deck = deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`));
    useApp.setState({ deck });
    render(<SlideRail />);
    fireEvent.contextMenu(thumb(1));
    expect(choice(/^Delete/).title).toBe("This slide is locked: unlock to delete");
    expect(choice(/^Cut/).title).toBe("This slide is locked");
    expect(off(/^Unlock/)).toBe(false);
    fireEvent.pointerDown(screen.getByTestId("context-menu-cover"));
    act(() => {
      useApp.getState().setSearch({ query: "x" });
      useApp
        .getState()
        .setSearchMatches([{ slide: "intro", index: 0, locked: true, notes: false, before: "", text: "x", after: "" }]);
    });
    fireEvent.contextMenu(thumb(1));
    expect(off(/^Move down/)).toBe(false);
    act(() => useApp.getState().clearSearch());
  });

  describe("on a section's header", () => {
    const SECTIONED = DECK_HTML.replace(
      `<section class="slide" id="intro">`,
      `<div class="deck-section" data-title="Opening"></div>\n<section class="slide" id="intro">`,
    ).replace(
      `<section class="slide" id="outro">`,
      `<div class="deck-section" data-title="Closing"></div>\n<section class="slide" id="outro">`,
    );
    const header = (n: number) => screen.getAllByTestId("section-header")[n]!;
    beforeEach(() => useApp.setState({ deck: deckFor(SECTIONED), selected: "intro" }));

    it("renames, folds one or all, picks its slides, and removes it with a way back", async () => {
      render(<SlideRail />);
      fireEvent.contextMenu(header(0), { clientX: 5, clientY: 5 });
      expect(screen.getByRole("menu", { name: "Section" })).toBeTruthy();
      expect(
        menu()
          .getAllByRole("menuitem")
          .map((b) => b.textContent),
      ).toEqual([
        "Rename",
        "New slide in this section…",
        "Move section up",
        "Move section down",
        "Collapse",
        "Collapse all",
        "Expand all",
        "Select its slides",
        "Remove section (keeps its slides)",
        "Delete section and its 2 slides",
      ]);
      expect(off("Move section up")).toBe(true);
      expect(choice("Move section up").title).toBe("This is the first section");
      expect(off("Expand all")).toBe(true);
      fireEvent.click(choice("Collapse"));
      expect(useApp.getState().collapsedSections).toEqual(["intro"]);

      fireEvent.contextMenu(header(0));
      expect(choice("Expand")).toBeTruthy();
      fireEvent.click(choice("Collapse all"));
      expect(useApp.getState().collapsedSections).toEqual(["intro", "outro"]);
      fireEvent.contextMenu(header(1));
      fireEvent.click(choice("Expand all"));
      expect(useApp.getState().collapsedSections).toEqual([]);

      fireEvent.contextMenu(header(0));
      fireEvent.click(choice("Select its slides"));
      expect(useApp.getState()).toMatchObject({ selected: "intro", railSelected: ["intro", "#2"] });

      fireEvent.contextMenu(header(1));
      fireEvent.click(choice("Rename"));
      expect((screen.getByLabelText("Section title") as HTMLInputElement).value).toBe("Closing");
      fireEvent.keyDown(screen.getByLabelText("Section title"), { key: "Escape" });

      invoke.mockResolvedValue(deckFor(DECK_HTML));
      fireEvent.contextMenu(header(0));
      await act(async () => fireEvent.click(choice("Remove section (keeps its slides)")));
      expect(invoke).toHaveBeenCalledWith("delete_section", { id: DECK.id, index: 0 });
      const toast = useApp.getState().toasts.at(-1)!;
      expect(toast.text).toBe("Removed the section “Opening”; its slides stay");
      expect(toast.action?.label).toBe("Undo");
    });

    it("offers everything in View too", () => {
      useApp.setState({ editing: false });
      render(<SlideRail />);
      fireEvent.contextMenu(header(0));
      expect(off("Rename")).toBe(false);
      expect(off("Remove section (keeps its slides)")).toBe(false);
    });

    it("moves a section down past the next, with its slides", async () => {
      invoke.mockResolvedValue(edited(deckFor(SECTIONED)));
      render(<SlideRail />);
      fireEvent.contextMenu(header(0));
      await act(async () => fireEvent.click(choice("Move section down")));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("reorder_slides", {
          id: DECK.id,
          slides: ["section:1", "outro", "section:0", "intro", "#2"],
        }),
      );
    });

    it("deletes a section with its slides as one change, with a way back", async () => {
      invoke.mockResolvedValue(edited(withSlides("outro")));
      render(<SlideRail />);
      fireEvent.contextMenu(header(0));
      await act(async () => fireEvent.click(choice("Delete section and its 2 slides")));
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith("delete_section_slides", {
          id: DECK.id,
          index: 0,
          slides: ["intro", "#2"],
        }),
      );
      const toast = useApp.getState().toasts.at(-1)!;
      expect(toast.text).toBe("Deleted the section “Opening” and its 2 slides");
      expect(toast.action?.label).toBe("Undo");
    });

    it("does not delete a section holding a locked slide, saying why", () => {
      useApp.setState({ deck: deckFor(SECTIONED.replace(`id="intro"`, `id="intro" data-locked`)) });
      render(<SlideRail />);
      fireEvent.contextMenu(header(0));
      expect(off("Delete section and its 2 slides")).toBe(true);
      expect(choice("Delete section and its 2 slides").title).toBe(
        "It holds a locked slide: unlock it to delete the section",
      );
    });

    it("lays its buttons over the end of the row, taking no room from the title", () => {
      render(<SlideRail />);
      const buttons = within(header(0)).getByRole("button", { name: "Rename section" }).parentElement!;
      expect(buttons.className).toContain("absolute");
      fireEvent.click(within(header(0)).getByRole("button", { name: "More actions" }));
      expect(screen.getByRole("menu", { name: "Section" })).toBeTruthy();
    });

    it("keeps the old name, and says so, when a rename leaves it empty", async () => {
      render(<SlideRail />);
      fireEvent.click(within(header(0)).getByTitle("Rename section"));
      const input = screen.getByLabelText("Section title");
      fireEvent.change(input, { target: { value: "   " } });
      await act(async () => fireEvent.blur(input));
      expect(invoke).not.toHaveBeenCalledWith("rename_section", expect.anything());
      expect(within(header(0)).getByText("Opening")).toBeTruthy();
      expect(useApp.getState().toasts.at(-1)).toMatchObject({
        kind: "info",
        text: "A section needs a name: it is still “Opening”.",
      });
    });
  });
});

describe("what the rail says after a change", () => {
  beforeEach(() => useApp.setState({ railSelected: [] }));
  it("says how many slides went, with a way to take it back", async () => {
    invoke.mockResolvedValue(edited(withSlides("#2", "outro")));
    render(<SlideRail />);
    await act(async () => fireEvent.click(item(0).getByTitle("Delete")));
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast).toMatchObject({ kind: "success", text: "Deleted 1 slide" });
    expect(toast.action?.label).toBe("Undo");
  });

  it("acts on every picked slide from the quick actions of one of them, saying how many", async () => {
    render(<SlideRail />);
    act(() => useApp.getState().extendRailSelection("outro", "toggle"));
    const trash = item(0).getByRole("button", { name: "Delete 2 slides" });
    // A slide that is not picked acts alone.
    expect(item(1).getByRole("button", { name: "Delete" })).toBeTruthy();
    invoke.mockResolvedValue(edited(withSlides("#2")));
    await act(async () => fireEvent.click(trash));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("delete_slides", { id: DECK.id, slides: ["intro", "outro"] }),
    );
  });

  it("badges the slide being dragged with how many go along, and dims the others", async () => {
    // jsdom has no layout: give the rows a size, so the badge has a slide to ride on.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ top: 0, bottom: 60, left: 0, right: 100, width: 100, height: 60, x: 0, y: 0 }) as DOMRect,
    );
    render(<SlideRail />);
    act(() => useApp.getState().extendRailSelection("outro", "toggle"));
    const grab = items()[0]!.querySelector("button[data-thumbnail]")!;
    act(() => {
      fireEvent.pointerDown(grab, { isPrimary: true, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(document, { isPrimary: true, clientX: 10, clientY: 40 });
    });
    expect(screen.getByTestId("drag-count").textContent).toBe("2 slides");
    expect(items()[2]!.className).toContain("opacity-40");
    expect(items()[1]!.className).not.toContain("opacity-40");
    await act(async () => void fireEvent.pointerUp(document, { isPrimary: true, clientX: 10, clientY: 40 }));
    expect(screen.queryByTestId("drag-count")).toBeNull();
    expect(items()[2]!.className).not.toContain("opacity-40");
    // dnd-kit swallows clicks for 50ms after a drag.
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    vi.restoreAllMocks();
  });
});
