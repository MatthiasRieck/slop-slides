import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Deck } from "../lib/api";
import { useApp } from "../store";
import { MUSIC_VOLUME_SAVE_DELAY, MusicControls } from "./MusicControls";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));

const deck = (music: Deck["music"]) => ({ id: "/talk/deck.html", music }) as Deck;
const MUSIC = { file: "assets/song.mp3", volume: 30 };

describe("MusicControls", () => {
  const setMusic = vi.fn(async () => {});
  const removeMusic = vi.fn(async () => {});
  const setMusicVolume = vi.fn(async () => {});
  const setError = vi.fn();
  const players: { src: string; loop: boolean; volume: number; play: () => Promise<void>; pause: () => void }[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    players.length = 0;
    useApp.setState({ setMusic, removeMusic, setMusicVolume, setError });
    vi.stubGlobal(
      "Audio",
      class {
        loop = false;
        volume = 1;
        play = vi.fn(async () => {});
        pause = vi.fn();
        constructor(public src: string) {
          players.push(this);
        }
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("adds music picked from the supported file types", async () => {
    open.mockResolvedValue("/music/song.flac");
    render(<MusicControls deck={deck(null)} />);
    expect(screen.getByText("No background music")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add music…" })));
    expect(open.mock.calls[0]?.[0].filters[0].extensions).toEqual(["mp3", "m4a", "wav", "flac", "ogg"]);
    expect(setMusic).toHaveBeenCalledWith("/music/song.flac");
  });

  it("does nothing when the picker is cancelled", async () => {
    open.mockResolvedValue(null);
    render(<MusicControls deck={deck(null)} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add music…" })));
    expect(setMusic).not.toHaveBeenCalled();
  });

  it("shows a file that cannot be added", async () => {
    open.mockResolvedValue("/music/song.mp3");
    setMusic.mockRejectedValueOnce(new Error("disk full"));
    render(<MusicControls deck={deck(null)} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add music…" })));
    expect(setError).toHaveBeenCalledWith("Could not add the music: disk full");
  });

  it("shows the music and removes it", async () => {
    render(<MusicControls deck={deck(MUSIC)} />);
    expect(screen.getByText("song.mp3")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add music…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove music" }));
    expect(removeMusic).toHaveBeenCalled();
  });

  it("saves the volume once the slider rests", () => {
    vi.useFakeTimers();
    render(<MusicControls deck={deck(MUSIC)} />);
    const slider = screen.getByRole("slider", { name: "Music volume" });
    fireEvent.change(slider, { target: { value: "50" } });
    fireEvent.change(slider, { target: { value: "60" } });
    expect(screen.getByText("60%")).toBeTruthy();
    expect(setMusicVolume).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(MUSIC_VOLUME_SAVE_DELAY);
    });
    expect(setMusicVolume).toHaveBeenCalledTimes(1);
    expect(setMusicVolume).toHaveBeenCalledWith(60);
  });

  it("plays the music at the set volume, following the slider, until stopped", async () => {
    const view = render(<MusicControls deck={deck(MUSIC)} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    const player = players[0]!;
    expect(player.src).toContain("/talk/assets/song.mp3");
    expect(player.loop).toBe(true);
    expect(player.volume).toBe(0.3);
    expect(player.play).toHaveBeenCalled();

    fireEvent.change(screen.getByRole("slider", { name: "Music volume" }), { target: { value: "80" } });
    expect(player.volume).toBe(0.8);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    view.unmount();
  });

  it("stops playing when it goes away", async () => {
    const view = render(<MusicControls deck={deck(MUSIC)} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    view.unmount();
    expect(players[0]?.pause).toHaveBeenCalled();
  });

  it("reports music that cannot play", async () => {
    render(<MusicControls deck={deck(MUSIC)} />);
    vi.stubGlobal(
      "Audio",
      class {
        play = vi.fn(async () => {
          throw new Error("unsupported");
        });
        pause = vi.fn();
      },
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play" })));
    expect(setError).toHaveBeenCalledWith("Could not play the music: unsupported");
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
  });

  it("takes a volume changed elsewhere", () => {
    const view = render(<MusicControls deck={deck(MUSIC)} />);
    view.rerender(<MusicControls deck={deck({ ...MUSIC, volume: 70 })} />);
    expect(screen.getByText("70%")).toBeTruthy();
  });
});
