import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "../test/tauri";
import { playNarration } from "./narrationAudio";

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
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:narration");
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
