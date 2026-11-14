// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { invoke } from "../test/tauri";
import { borrowNarrationSound, forgetNarration, narrationPeaks, SOUNDS_KEPT } from "./narrationCache";

const asked = (command: string) => invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args.slide);

beforeEach(() => {
  forgetNarration();
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => (command === "narration_peaks" ? [0.5, 1] : new ArrayBuffer(8)));
  let made = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++made}`);
  URL.revokeObjectURL = vi.fn();
});

describe("a slide's waveform", () => {
  it("is read once, whoever asks", async () => {
    const [first, second] = await Promise.all([narrationPeaks("deck", "a"), narrationPeaks("deck", "a")]);
    expect(second).toBe(first);
    await narrationPeaks("deck", "a");
    await narrationPeaks("deck", "b");
    expect(asked("narration_peaks")).toEqual(["a", "b"]);
  });

  it("is read again once its audio changed, and only its own", async () => {
    await narrationPeaks("deck", "a");
    await narrationPeaks("deck", "b");
    await narrationPeaks("other", "a");
    forgetNarration("deck", "a");
    await Promise.all([narrationPeaks("deck", "a"), narrationPeaks("deck", "b"), narrationPeaks("other", "a")]);
    expect(asked("narration_peaks")).toEqual(["a", "b", "a", "a"]);
    // A deck's audio, all of it.
    forgetNarration("deck");
    await Promise.all([narrationPeaks("deck", "a"), narrationPeaks("deck", "b"), narrationPeaks("other", "a")]);
    expect(asked("narration_peaks")).toEqual(["a", "b", "a", "a", "a", "b"]);
  });

  it("is asked for again after it could not be read", async () => {
    invoke.mockRejectedValueOnce("gone");
    await expect(narrationPeaks("deck", "a")).rejects.toBe("gone");
    expect(await narrationPeaks("deck", "a")).toEqual([0.5, 1]);
  });
});

describe("a slide's sound", () => {
  it("is read once and played from the same file again", async () => {
    const first = await borrowNarrationSound("deck", "a");
    first.release();
    const second = await borrowNarrationSound("deck", "a");
    expect(second.url).toBe(first.url);
    expect(asked("narration_wav")).toEqual(["a"]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("is freed when its audio changed, but not while it plays", async () => {
    const playing = await borrowNarrationSound("deck", "a");
    forgetNarration("deck", "a");
    await Promise.resolve();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    // The next one to play it reads the new audio.
    const next = await borrowNarrationSound("deck", "a");
    expect(next.url).not.toBe(playing.url);
    playing.release();
    playing.release();
    await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(playing.url);
  });

  it("keeps only the last few, freeing the one played longest ago", async () => {
    const first = await borrowNarrationSound("deck", "s0");
    first.release();
    for (let i = 1; i < SOUNDS_KEPT; i++) (await borrowNarrationSound("deck", `s${i}`)).release();
    // Played again, the first is the latest.
    (await borrowNarrationSound("deck", "s0")).release();
    (await borrowNarrationSound("deck", "more")).release();
    await Promise.resolve();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(first.url);
    expect(asked("narration_wav")).toHaveLength(SOUNDS_KEPT + 1);
  });

  it("is asked for again after it could not be read", async () => {
    invoke.mockRejectedValueOnce("gone");
    await expect(borrowNarrationSound("deck", "a")).rejects.toBe("gone");
    expect((await borrowNarrationSound("deck", "a")).url).toBe("blob:1");
  });
});
