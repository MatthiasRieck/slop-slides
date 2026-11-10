// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { getSlideClock, onSlideClock, postSlideClock, setSlideClock } from "./slideClock";

afterEach(() => setSlideClock(null));

const frame = () => {
  const postMessage = vi.fn();
  return { frame: { contentWindow: { postMessage } } as unknown as HTMLIFrameElement, postMessage };
};

describe("slide clock", () => {
  it("tells its listeners of each change, until they stop listening", () => {
    const heard = vi.fn();
    const stop = onSlideClock(heard);
    const clock = { slide: "intro", at: 1 };
    setSlideClock(clock);
    expect(getSlideClock()).toBe(clock);
    setSlideClock(clock);
    expect(heard).toHaveBeenCalledOnce();
    stop();
    setSlideClock(null);
    expect(heard).toHaveBeenCalledOnce();
    expect(getSlideClock()).toBeNull();
  });

  it("posts the clock to the page of its slide only", () => {
    const { frame: page, postMessage } = frame();
    postSlideClock(page, "intro");
    expect(postMessage).not.toHaveBeenCalled();
    setSlideClock({ slide: "intro", at: 2.5 });
    postSlideClock(page, "outro");
    expect(postMessage).not.toHaveBeenCalled();
    postSlideClock(page, "intro");
    // A whole deck's page (the presenter's) takes the clock for whichever slide it is on.
    postSlideClock(page, null);
    expect(postMessage.mock.calls).toEqual([
      [{ type: "slop:clock", slide: "intro", at: 2.5 }, "*"],
      [{ type: "slop:clock", slide: "intro", at: 2.5 }, "*"],
    ]);
    postSlideClock(null, "intro");
  });

  it("says when the clock is held at a moment, and lets go of it when asked to", () => {
    const { frame: page, postMessage } = frame();
    setSlideClock({ slide: "intro", at: 1.2, paused: true });
    postSlideClock(page, "intro", true);
    setSlideClock(null);
    // Only who asks for it hears that the clock is gone.
    postSlideClock(page, "intro");
    postSlideClock(page, "intro", true);
    expect(postMessage.mock.calls).toEqual([
      [{ type: "slop:clock", slide: "intro", at: 1.2, paused: true }, "*"],
      [{ type: "slop:clock", slide: "intro", at: null }, "*"],
    ]);
  });
});
