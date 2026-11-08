import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DECK_HTML, deckFor } from "../test/fixtures";
import { SlidePanel, SlidePanelHeader } from "./SlidePanel";

const deck = deckFor(DECK_HTML);
const slide = deck.slides[1]!;

describe("SlidePanel", () => {
  it("asks for a deck when none is open", () => {
    const body = vi.fn(() => null);
    render(
      <SlidePanel label="Speaker notes" noun="notes" deck={null} slide={undefined}>
        {body}
      </SlidePanel>,
    );
    expect(screen.getByText("Open a deck to write notes for its slides.")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
    expect(body).not.toHaveBeenCalled();
  });

  it("asks for a slide when the deck has none selected", () => {
    render(
      <SlidePanel label="Narration tools" noun="narration" deck={deck} slide={undefined}>
        {() => null}
      </SlidePanel>,
    );
    expect(screen.getByText("Add a slide to write its narration.")).toBeTruthy();
  });

  it("fills the sidebar tab, named, with what it holds for the slide", () => {
    render(
      <SlidePanel label="Speaker notes" noun="notes" deck={deck} slide={slide}>
        {(d, s) => (
          <p>
            {d.slides.length} · {s.id}
          </p>
        )}
      </SlidePanel>,
    );
    const panel = screen.getByRole("region", { name: "Speaker notes" });
    expect(panel.className).toBe("flex h-full min-h-0 flex-col overflow-y-auto");
    expect(panel.textContent).toBe(`${deck.slides.length} · ${slide.id}`);
  });
});

describe("SlidePanelHeader", () => {
  const header = (props: Partial<Parameters<typeof SlidePanelHeader>[0]> = {}) =>
    render(<SlidePanelHeader slide={slide} index={1} total={3} preview={false} onPreview={() => {}} {...props} />);

  it("says which slide it is, with what the panel adds", () => {
    header({ children: <span>12 words</span> });
    expect(screen.getByText(/Slide 2 of 3/).textContent).toBe(`Slide 2 of 3 · ${slide.id}`);
    expect(screen.getByText("12 words")).toBeTruthy();
    expect(screen.queryByText("Locked")).toBeNull();
  });

  it("says when the slide is locked", () => {
    header({ slide: { ...slide, locked: true } });
    expect(screen.getByText("Locked")).toBeTruthy();
  });

  it("switches the preview", () => {
    const onPreview = vi.fn();
    const { rerender } = header({ onPreview });
    fireEvent.click(screen.getByRole("button", { name: "Preview", pressed: false }));
    expect(onPreview).toHaveBeenLastCalledWith(true);
    rerender(<SlidePanelHeader slide={slide} index={1} total={3} preview onPreview={onPreview} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit", pressed: true }));
    expect(onPreview).toHaveBeenLastCalledWith(false);
  });
});
