import { afterEach, describe, expect, it, vi } from "vitest";

import { followFramePresses, isFrame, pressOn } from "./framePress";

afterEach(() => {
  document.body.innerHTML = "";
});

function frame() {
  const around = document.createElement("div");
  const element = document.createElement("iframe");
  around.append(element);
  document.body.append(around);
  return { around, element };
}

const report = (source: MessageEventSource | null, type = "slop:press") =>
  window.dispatchEvent(new MessageEvent("message", { data: { type }, source }));

describe("a press in a slide preview", () => {
  it("is a press on its frame for what watches presses on their way down, start and end", () => {
    const { element } = frame();
    const seen: string[] = [];
    const watch = (event: Event) => {
      if (event.target === element) seen.push(`${event.type}:${(event as MouseEvent).detail}`);
    };
    document.addEventListener("pointerdown", watch, true);
    document.addEventListener("click", watch, true);
    pressOn(element);
    expect(seen).toEqual(["pointerdown:0", "click:0"]);
    document.removeEventListener("pointerdown", watch, true);
    document.removeEventListener("click", watch, true);
  });

  it("is no press for what is around the frame", () => {
    const { around, element } = frame();
    const press = vi.fn();
    around.addEventListener("pointerdown", press);
    around.addEventListener("click", press);
    window.addEventListener("click", press);
    pressOn(element);
    expect(press).not.toHaveBeenCalled();
    window.removeEventListener("click", press);
  });

  it("follows the presses the previews report, and only those, until stopped", () => {
    const { element } = frame();
    const press = vi.fn();
    element.addEventListener("pointerdown", press);
    const stop = followFramePresses();
    report(element.contentWindow);
    expect(press).toHaveBeenCalledOnce();
    // Not another message of the preview's, nor a press reported by something that is no frame here.
    report(element.contentWindow, "slop:key");
    report(window);
    report(null);
    expect(press).toHaveBeenCalledOnce();
    stop();
    report(element.contentWindow);
    expect(press).toHaveBeenCalledOnce();
  });
});

describe("isFrame", () => {
  it("tells a message of one of this window's frames from any other", () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    expect(isFrame(frame.contentWindow)).toBe(true);
    expect(isFrame(window)).toBe(false);
    expect(isFrame(null)).toBe(false);
    const gone = frame.contentWindow;
    frame.remove();
    expect(isFrame(gone)).toBe(false);
  });
});
