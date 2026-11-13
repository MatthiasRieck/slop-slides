import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openLayer } from "../../lib/layers";
import { useApp } from "../../store";
import { keyForRail, useSketchKeyboard, useSlideKeyboard } from "./useSlideKeyboard";

function Keys(props: { putAway?: () => void }) {
  useSlideKeyboard();
  useSketchKeyboard(props.putAway !== undefined, props.putAway ?? (() => {}));
  return (
    <>
      <iframe title="slide" />
      <div data-slide-rail="">
        <button type="button">Rail</button>
      </div>
      <button type="button">Plain</button>
      <input aria-label="Field" />
      <div role="tablist">
        <button type="button" role="tab">
          Tab
        </button>
      </div>
      <div role="menu">
        <button type="button" role="menuitem">
          Item
        </button>
      </div>
    </>
  );
}

describe("the stage's keys, by where they are pressed", () => {
  const real = useApp.getState();
  const selectRelative = vi.fn();
  const undo = vi.fn(async () => {});

  const setUp = (putAway?: () => void) => {
    useApp.setState({ selectRelative, undo, presenting: false, editing: false });
    return render(<Keys putAway={putAway} />);
  };

  afterEach(() => {
    useApp.setState({ selectRelative: real.selectRelative, undo: real.undo });
    selectRelative.mockClear();
    undo.mockClear();
  });

  it("moves between slides with the arrows pressed on a plain button", () => {
    const { getByText } = setUp();
    fireEvent.keyDown(getByText("Plain"), { key: "ArrowRight" });
    expect(selectRelative).toHaveBeenCalledWith(1);
  });

  it.each(["Tab", "Item"])("leaves the arrows to the widget holding %s", (name) => {
    const { getByText } = setUp();
    fireEvent.keyDown(getByText(name), { key: "ArrowRight" });
    fireEvent.keyDown(getByText(name), { key: "ArrowDown" });
    expect(selectRelative).not.toHaveBeenCalled();
  });

  it("undoes from a widget, which has no use for the shortcut, but not from a field", () => {
    const { getByText, getByLabelText } = setUp();
    fireEvent.keyDown(getByLabelText("Field"), { key: "z", ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
    fireEvent.keyDown(getByText("Tab"), { key: "z", ctrlKey: true });
    expect(undo).toHaveBeenCalledOnce();
  });

  it("puts a sketch tool away on Escape, unless pressed in a field or a widget", () => {
    const putAway = vi.fn();
    const { getByText, getByLabelText } = setUp(putAway);
    fireEvent.keyDown(getByLabelText("Field"), { key: "Escape" });
    fireEvent.keyDown(getByText("Item"), { key: "Escape" });
    expect(putAway).not.toHaveBeenCalled();
    fireEvent.keyDown(getByText("Plain"), { key: "Escape" });
    expect(putAway).toHaveBeenCalledOnce();
  });

  describe("forwarded by the slide preview", () => {
    const fromSlide = (container: HTMLElement, data: unknown) =>
      act(
        () =>
          void window.dispatchEvent(
            new MessageEvent("message", { data, source: container.querySelector("iframe")!.contentWindow }),
          ),
      );

    it("closes what is open in the app on Escape before it clears the picked slides", () => {
      const clearRailSelection = vi.fn();
      const { container } = setUp();
      useApp.setState({ railSelected: ["intro", "outro"], clearRailSelection });
      const close = vi.fn();
      const remove = openLayer(close);
      fromSlide(container, { type: "slop:key", key: "Escape" });
      expect(close).toHaveBeenCalledOnce();
      expect(clearRailSelection).not.toHaveBeenCalled();
      remove();
      fromSlide(container, { type: "slop:key", key: "Escape" });
      expect(clearRailSelection).toHaveBeenCalledOnce();
      useApp.setState({ railSelected: [], clearRailSelection: real.clearRailSelection });
    });

    it("takes a press in the slide for a press off the slide list", () => {
      const { container, getByText } = setUp();
      fireEvent.pointerDown(getByText("Rail"));
      expect(keyForRail(getByText("Plain"))).toBe(true);
      // Not every message is a press, and not every window the slide's.
      act(() => void window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:press" }, source: null })));
      expect(keyForRail(getByText("Plain"))).toBe(true);
      fromSlide(container, { type: "slop:press" });
      expect(keyForRail(getByText("Plain"))).toBe(false);
    });
  });
});
