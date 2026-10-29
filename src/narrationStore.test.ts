import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(event, handler);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { initNarrationEvents, NARRATION_CANCELLED, useNarration } from "./narrationStore";
import { useApp } from "./store";
import { DECK_HTML, deckFor } from "./test/fixtures";

const deck = deckFor(DECK_HTML);

beforeEach(() => {
  invoke.mockReset();
  useNarration.setState({ speech: null, audio: {}, audioDeck: null, render: null, download: null });
  useApp.setState({ deck: null, error: null });
});

describe("narration store", () => {
  it("keeps the open deck's audio up to date as the deck changes", async () => {
    await initNarrationEvents();
    invoke.mockResolvedValue([{ slide: "intro", state: "ready", seconds: 3 }]);
    await act(async () => useApp.setState({ deck }));
    expect(invoke).toHaveBeenCalledWith("narration_audio", { id: deck.id });
    expect(useNarration.getState().audioDeck).toBe(deck.id);
    expect(useNarration.getState().audio.intro?.seconds).toBe(3);
  });

  it("follows renders as they go, from any window", async () => {
    await initNarrationEvents();
    useApp.setState({ deck });
    invoke.mockResolvedValue([]);
    const render = listeners.get("narration-render");
    act(() => render?.({ payload: { deck: deck.id, slide: "intro", done: 0, total: 2 } }));
    expect(useNarration.getState().render?.slide).toBe("intro");
    act(() => render?.({ payload: { deck: deck.id, slide: null, done: 2, total: 2 } }));
    expect(useNarration.getState().render).toBeNull();
  });

  it("reports a failed render but not a cancelled one", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "render_narration") throw "Slide intro: the speech engine stopped unexpectedly";
      return [];
    });
    expect(await useNarration.getState().renderAudio(deck.id, ["intro"])).toBe(false);
    expect(useApp.getState().error).toBe("Slide intro: the speech engine stopped unexpectedly");
    expect(useNarration.getState().render).toBeNull();

    useApp.setState({ error: null });
    invoke.mockImplementation(async (command: string) => {
      if (command === "render_narration") throw NARRATION_CANCELLED;
      return [];
    });
    expect(await useNarration.getState().renderAudio(deck.id, null)).toBe(false);
    expect(useApp.getState().error).toBeNull();
  });

  it("shows download progress only while it downloads", async () => {
    await initNarrationEvents();
    const progress = listeners.get("speech-download");
    progress?.({ payload: { received: 5, total: 10 } });
    expect(useNarration.getState().download).toBeNull();
    let finish!: () => void;
    invoke.mockImplementation((command: string) =>
      command === "download_speech_model" ? new Promise<void>((r) => (finish = r)) : Promise.resolve(null),
    );
    const done = useNarration.getState().downloadModel();
    progress?.({ payload: { received: 5, total: 10 } });
    expect(useNarration.getState().download).toEqual({ received: 5, total: 10 });
    finish();
    await done;
    expect(useNarration.getState().download).toBeNull();
    expect(invoke).toHaveBeenCalledWith("speech_status");
  });
});
