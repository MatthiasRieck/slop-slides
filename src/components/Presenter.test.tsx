import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setFullscreen = vi.fn(async () => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setFullscreen }) }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { Presenter } from "./Presenter";

beforeEach(() => {
  setFullscreen.mockClear();
  useApp.setState({ deck: deckFor(DECK_HTML), selected: "outro", presenting: true, revealRev: 0 });
});

const frame = () => screen.getByTitle("Presentation") as HTMLIFrameElement;

function fromFrame(data: unknown, source: MessageEventSource | null = frame().contentWindow) {
  act(() => void window.dispatchEvent(new MessageEvent("message", { data, source })));
}

describe("Presenter", () => {
  it("plays the whole deck from the selected slide", () => {
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/talk/deck.html?v=shell-1#outro");
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("encodes positional slide ids in the hash", () => {
    useApp.setState({ selected: "#2" });
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/talk/deck.html?v=shell-1#%232");
  });

  it("starts at the beginning without a selection", () => {
    useApp.setState({ selected: null });
    render(<Presenter />);
    expect(frame().getAttribute("src")).toBe("/__deck/talk/deck.html?v=shell-1");
  });

  it("does not restart when the editor selection follows the show", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:slide", id: "intro" });
    expect(useApp.getState().selected).toBe("intro");
    expect(frame().getAttribute("src")).toContain("#outro");
  });

  it("goes full screen for the show and back afterwards", () => {
    const { unmount } = render(<Presenter />);
    expect(setFullscreen).toHaveBeenCalledWith(true);
    unmount();
    expect(setFullscreen).toHaveBeenLastCalledWith(false);
  });

  it("Escape ends the show, from the app or from inside the slide", () => {
    render(<Presenter />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useApp.getState().presenting).toBe(false);
    useApp.setState({ presenting: true });
    fromFrame({ type: "slop:key", key: "Escape" });
    expect(useApp.getState().presenting).toBe(false);
  });

  it("hands other keys to the player", () => {
    render(<Presenter />);
    const focus = vi.spyOn(frame(), "focus");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(focus).toHaveBeenCalled();
    expect(useApp.getState().presenting).toBe(true);
  });

  it("ignores messages that are not from the show", () => {
    render(<Presenter />);
    fromFrame({ type: "slop:key", key: "Escape" }, window);
    fromFrame({ type: "slop:slide", id: "intro" }, null);
    fromFrame({ type: "slop:slide", id: null });
    fromFrame("not an object");
    expect(useApp.getState().presenting).toBe(true);
    expect(useApp.getState().selected).toBe("outro");
  });

  it("stops listening after the show", () => {
    const { unmount } = render(<Presenter />);
    unmount();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useApp.getState().presenting).toBe(true);
  });

  it("renders nothing without a deck", () => {
    useApp.setState({ deck: null });
    render(<Presenter />);
    expect(screen.queryByTitle("Presentation")).toBeNull();
  });
});
