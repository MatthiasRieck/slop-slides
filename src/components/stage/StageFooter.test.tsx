import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The zoom's menu keys are its own: each call is a render of the zoom (or of the overflow chip, which stays put here).
vi.mock("../../hooks/useMenuKeys", async (original) => {
  const actual = await original<typeof import("../../hooks/useMenuKeys")>();
  return { ...actual, useMenuKeys: vi.fn(actual.useMenuKeys) };
});

import { useMenuKeys } from "../../hooks/useMenuKeys";
import { useApp } from "../../store";
import { DECK_HTML, deckFor } from "../../test/fixtures";
import { StageFooter } from "./StageFooter";
import { useStageView } from "./stageView";

const deck = deckFor(DECK_HTML);
const zoomRenders = () => vi.mocked(useMenuKeys).mock.calls.length;

function renderFooter(onZoomTo = vi.fn()) {
  return render(
    <StageFooter
      index={0}
      count={deck.slides.length}
      slide={deck.slides[0]}
      onResetView={vi.fn()}
      onZoomBy={vi.fn()}
      onZoomTo={onZoomTo}
    />,
  );
}

beforeEach(() => {
  useApp.setState({ deck, selected: deck.slides[0]!.id });
  useStageView.setState({ view: null, fitScale: 0.5 });
});

describe("StageFooter's zoom", () => {
  it("does not render as the stage resizes while the whole slide shows", () => {
    renderFooter();
    expect(screen.getByRole("button", { name: "Zoom: Fit" })).toBeTruthy();
    const before = zoomRenders();
    // A panel's separator dragged: the size the slide fits at changes with every pixel.
    for (let i = 1; i <= 30; i++) act(() => useStageView.setState({ fitScale: 0.5 + i / 1000 }));
    expect(zoomRenders()).toBe(before);
  });

  it("shows the level once zoomed, renders as it changes by a percent, and zooms to a level picked", () => {
    const onZoomTo = vi.fn();
    renderFooter(onZoomTo);
    const slide = deck.slides[0]!.id;
    act(() => useStageView.setState({ view: { slide, x: 0, y: 0, k: 2 } }));
    expect(screen.getByRole("button", { name: "Zoom: 100%" })).toBeTruthy();
    const before = zoomRenders();
    act(() => useStageView.setState({ fitScale: 0.501 }));
    expect(zoomRenders()).toBe(before);
    act(() => useStageView.setState({ fitScale: 0.6 }));
    expect(screen.getByRole("button", { name: "Zoom: 120%" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zoom: 120%" }));
    expect(screen.getByRole("menuitemradio", { name: "Fit" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "200%" }));
    expect(onZoomTo).toHaveBeenCalledWith(2 / 0.6);
  });
});
