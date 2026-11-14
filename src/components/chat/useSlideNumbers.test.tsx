// A row of the chat that names slides asks the store on every update: it works its answer out
// again only when the deck's slide numbers are others.
import { act, render } from "@testing-library/react";
import { useCallback } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../../store";
import { DECK_HTML, deckFor } from "../../test/fixtures";
import { type SlideNumbers, useSlideNumbers } from "./useSlideNumbers";

const derive = vi.fn((numbers: SlideNumbers) => (numbers ? (numbers.get("intro") ?? 0) : -1));

function Row() {
  const number = useSlideNumbers(useCallback((numbers: SlideNumbers) => derive(numbers), []));
  return <span data-testid="number">{number}</span>;
}

beforeEach(() => {
  derive.mockClear();
  useApp.setState({ deck: deckFor(DECK_HTML), running: false, messages: [] });
});

describe("useSlideNumbers", () => {
  it("works nothing out again for updates of the store that leave the slides as they are", () => {
    render(<Row />);
    const before = derive.mock.calls.length;
    for (let i = 0; i < 100; i++) act(() => useApp.setState({ running: i % 2 === 0, messages: [] }));
    // A save gives the deck anew; the same list of slides keeps its numbers.
    const deck = useApp.getState().deck!;
    act(() => useApp.setState({ deck: { ...deck, shellHash: "saved" } }));
    expect(derive.mock.calls.length).toBe(before);
  });

  it("follows the slides as they move, and the deck as it goes", () => {
    const { getByTestId } = render(<Row />);
    expect(getByTestId("number").textContent).toBe("1");
    const deck = useApp.getState().deck!;
    act(() => useApp.setState({ deck: { ...deck, slides: [...deck.slides].reverse() } }));
    expect(getByTestId("number").textContent).toBe(String(deck.slides.length));
    act(() => useApp.setState({ deck: null }));
    expect(getByTestId("number").textContent).toBe("-1");
  });
});
