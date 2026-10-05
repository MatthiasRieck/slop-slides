import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { SKETCH_TARGET_ATTR, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { Stage } from "./Stage";

beforeEach(() => {
  useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", presenting: false, sketches: {} });
});

const position = () => screen.getByText(/^\d+ \/ \d+$/).textContent;
const prev = () => screen.getByRole("button", { name: "Previous slide" });
const next = () => screen.getByRole("button", { name: "Next slide" });

describe("Stage", () => {
  it("shows the position of the selected slide", () => {
    render(<Stage />);
    expect(position()).toBe("1 / 3");
    act(() => useApp.getState().select("outro"));
    expect(position()).toBe("3 / 3");
  });

  it("disables the arrows at either end", () => {
    render(<Stage />);
    expect((prev() as HTMLButtonElement).disabled).toBe(true);
    expect((next() as HTMLButtonElement).disabled).toBe(false);
    act(() => useApp.getState().select("outro"));
    expect((prev() as HTMLButtonElement).disabled).toBe(false);
    expect((next() as HTMLButtonElement).disabled).toBe(true);
  });

  it("moves between slides with the arrow buttons", () => {
    render(<Stage />);
    fireEvent.click(next());
    expect(useApp.getState().selected).toBe("#2");
    fireEvent.click(prev());
    expect(useApp.getState().selected).toBe("intro");
  });

  it("invites a conversation when the deck is empty", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] }, selected: null });
    render(<Stage />);
    expect(screen.getByText("Start with a conversation")).toBeTruthy();
    expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull();
  });

  it("renders nothing without a deck", () => {
    useApp.setState({ deck: null });
    const { container } = render(<Stage />);
    expect(container.innerHTML).toBe("");
  });

  describe("keyboard", () => {
    it.each([
      ["ArrowDown", "#2"],
      ["ArrowRight", "#2"],
      ["PageDown", "#2"],
    ])("%s goes to the next slide", (key, expected) => {
      render(<Stage />);
      const event = new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true });
      act(() => void document.body.dispatchEvent(event));
      expect(useApp.getState().selected).toBe(expected);
      expect(event.defaultPrevented).toBe(true);
    });

    it.each([["ArrowUp"], ["ArrowLeft"], ["PageUp"]])("%s goes to the previous slide", (key) => {
      useApp.setState({ selected: "outro" });
      render(<Stage />);
      act(() => void fireEvent.keyDown(document.body, { key }));
      expect(useApp.getState().selected).toBe("#2");
    });

    it("leaves other keys alone", () => {
      render(<Stage />);
      const event = new KeyboardEvent("keydown", { key: "a", cancelable: true, bubbles: true });
      document.body.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(useApp.getState().selected).toBe("intro");
    });

    it("does not navigate while typing", () => {
      render(
        <>
          <Stage />
          <input data-testid="input" />
          <textarea data-testid="textarea" />
          <div data-testid="editable" contentEditable />
        </>,
      );
      for (const id of ["input", "textarea", "editable"]) {
        fireEvent.keyDown(screen.getByTestId(id), { key: "ArrowDown" });
      }
      expect(useApp.getState().selected).toBe("intro");
    });

    it("does not navigate while presenting", () => {
      useApp.setState({ presenting: true });
      render(<Stage />);
      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect(useApp.getState().selected).toBe("intro");
    });

    it("stops listening when unmounted", () => {
      const { unmount } = render(<Stage />);
      unmount();
      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect(useApp.getState().selected).toBe("intro");
    });
  });

  describe("keys forwarded by slide previews", () => {
    function forward(key: string, source: MessageEventSource | null) {
      act(() => void window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:key", key }, source })));
    }

    it("navigates on keys from a slide iframe", () => {
      render(<Stage />);
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      forward("ArrowRight", frame.contentWindow);
      expect(useApp.getState().selected).toBe("#2");
      frame.remove();
    });

    it("ignores messages from anywhere else", () => {
      render(<Stage />);
      forward("ArrowRight", window);
      forward("ArrowRight", null);
      act(() => void window.dispatchEvent(new MessageEvent("message", { data: { type: "other", key: "ArrowRight" } })));
      expect(useApp.getState().selected).toBe("intro");
    });
  });

  describe("sketching", () => {
    const layer = () => screen.getByTestId("annotation-layer");
    const tool = (name: string) => screen.getByRole("button", { name });
    const pressed = (name: string) => tool(name).getAttribute("aria-pressed") === "true";

    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 500));
    });
    afterEach(() => vi.restoreAllMocks());

    function draw(points: [number, number][]) {
      const [first, ...rest] = points;
      fireEvent.pointerDown(layer(), { button: 0, buttons: 1, clientX: first![0], clientY: first![1], pointerId: 1 });
      for (const [x, y] of rest) fireEvent.pointerMove(layer(), { buttons: 1, clientX: x, clientY: y, pointerId: 1 });
      fireEvent.pointerUp(layer(), { pointerId: 1 });
    }

    it("leaves the slide clickable until a tool is picked", () => {
      render(<Stage />);
      expect(layer().style.pointerEvents).toBe("none");
      fireEvent.click(tool("Draw on the slide"));
      expect(pressed("Draw on the slide")).toBe(true);
      expect(layer().style.pointerEvents).toBe("auto");
      fireEvent.click(tool("Draw on the slide"));
      expect(pressed("Draw on the slide")).toBe(false);
      expect(layer().style.pointerEvents).toBe("none");
    });

    it("marks the slide being screenshotted when sending", () => {
      const { container } = render(<Stage />);
      const target = container.querySelector(`[${SKETCH_TARGET_ATTR}]`)!;
      expect(target.contains(layer())).toBe(true);
      expect(target.querySelector("iframe, [style*='aspect-ratio']")).toBeTruthy();
    });

    it("keeps the drawing in the store, per slide", () => {
      render(<Stage />);
      fireEvent.click(tool("Draw on the slide"));
      draw([
        [100, 100],
        [500, 250],
      ]);
      expect(useApp.getState().sketches.intro).toEqual([
        {
          tool: "pen",
          color: "#ef4444",
          points: [
            [0.1, 0.2],
            [0.5, 0.5],
          ],
        },
      ]);
      act(() => useApp.getState().select("#2"));
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(0);
      act(() => useApp.getState().select("intro"));
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
    });

    it("highlights in the highlighter color", () => {
      render(<Stage />);
      fireEvent.click(tool("Highlight on the slide"));
      draw([
        [10, 10],
        [20, 20],
      ]);
      expect(useApp.getState().sketches.intro?.[0]).toMatchObject({ tool: "highlighter", color: "#facc15" });
    });

    it("offers colors while inking", () => {
      render(<Stage />);
      expect(screen.queryByRole("button", { name: /^Color/ })).toBeNull();
      fireEvent.click(tool("Draw on the slide"));
      fireEvent.click(tool("Color #3b82f6"));
      draw([[10, 10]]);
      expect(useApp.getState().sketches.intro?.[0]?.color).toBe("#3b82f6");
    });

    it("undoes and clears marks", () => {
      render(<Stage />);
      expect(screen.queryByRole("button", { name: "Undo mark" })).toBeNull();
      fireEvent.click(tool("Draw on the slide"));
      draw([[10, 10]]);
      draw([[20, 20]]);
      fireEvent.click(tool("Undo mark"));
      expect(useApp.getState().sketches.intro).toHaveLength(1);
      fireEvent.click(tool("Clear marks"));
      expect(useApp.getState().sketches.intro).toEqual([]);
      expect(screen.queryByRole("button", { name: "Clear marks" })).toBeNull();
    });

    it("Escape puts the tool away, but not while typing", () => {
      render(
        <>
          <Stage />
          <textarea data-testid="textarea" />
        </>,
      );
      fireEvent.click(tool("Draw on the slide"));
      fireEvent.keyDown(screen.getByTestId("textarea"), { key: "Escape" });
      expect(pressed("Draw on the slide")).toBe(true);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(pressed("Draw on the slide")).toBe(false);
    });

    it("shows a drawing made before the stage mounted", () => {
      useApp.setState({ sketches: { intro: [{ tool: "pen", color: "#ef4444", points: [[0.5, 0.5]] }] } });
      render(<Stage />);
      expect(layer().querySelectorAll("[data-stroke]")).toHaveLength(1);
    });
  });
});
