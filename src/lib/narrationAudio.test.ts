// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "../test/tauri";
import { playNarration } from "./narrationAudio";
import { forgetNarration } from "./narrationCache";

/** The audio elements made, as jsdom plays none. */
let made: FakeAudio[] = [];

class FakeAudio extends EventTarget {
  currentTime = 0;
  paused = true;
  constructor(public src: string) {
    super();
    made.push(this);
  }
  async play() {
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
}

beforeEach(() => {
  made = [];
  forgetNarration();
  invoke.mockReset();
  vi.stubGlobal("Audio", FakeAudio);
  URL.createObjectURL = vi.fn(() => "blob:narration");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => vi.unstubAllGlobals());

describe("playNarration", () => {
  it("plays the slide's audio from where it is asked to", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(8));
    const playing = await playNarration("deck", "intro", 1.5);
    expect(invoke).toHaveBeenCalledWith("narration_wav", { id: "deck", slide: "intro" });
    expect(made[0]?.currentTime).toBe(1.5);
    expect(made[0]?.paused).toBe(false);
    // Where it is, for a playhead to follow.
    expect(playing.time()).toBe(1.5);
    made[0]!.currentTime = 2.25;
    expect(playing.time()).toBe(2.25);
    playing.stop();
    await playing.ended;
    // The audio stays loaded for the next time it plays: nothing is read again.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await playNarration("deck", "intro");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(made[1]?.src).toBe("blob:narration");
  });

  it("frees the audio once it has changed and is no longer played", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(8));
    const playing = await playNarration("deck", "intro");
    forgetNarration("deck", "intro");
    await Promise.resolve();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    playing.stop();
    await playing.ended;
    await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:narration");
  });

  it("pauses where it is and plays on from there", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(8));
    const playing = await playNarration("deck", "intro");
    made[0]!.currentTime = 1.25;
    playing.pause();
    expect(made[0]?.paused).toBe(true);
    expect(playing.time()).toBe(1.25);
    // Paused is not ended: the audio is still there to play on.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await playing.resume();
    expect(made[0]?.paused).toBe(false);
    expect(made[0]?.currentTime).toBe(1.25);
    playing.stop();
  });

  it("asks where to start only once the audio has loaded", async () => {
    let load!: (bytes: ArrayBuffer) => void;
    invoke.mockReturnValue(new Promise((resolve) => (load = resolve)));
    let clock = 0;
    const playing = playNarration("deck", "song", () => clock);
    // Loading a long file takes a while; the show goes on meanwhile.
    clock = 2.25;
    load(new ArrayBuffer(8));
    await playing;
    expect(made[0]?.currentTime).toBe(2.25);
  });

  it("never starts before the audio does", async () => {
    invoke.mockResolvedValue(new ArrayBuffer(8));
    await playNarration("deck", "intro", () => -0.2);
    expect(made[0]?.currentTime).toBe(0);
  });
});
