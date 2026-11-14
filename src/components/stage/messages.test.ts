import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { frameMessages } from "./messages";

describe("the stage's messages", () => {
  let area: HTMLDivElement;
  let frame: HTMLIFrameElement;
  let stop: () => void;
  let messages: ReturnType<typeof frameMessages>;

  const post = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
    window.dispatchEvent(new MessageEvent("message", { data, source }));

  beforeEach(() => {
    area = document.createElement("div");
    frame = document.createElement("iframe");
    area.append(frame);
    document.body.append(area);
    messages = frameMessages(() => area);
    stop = messages.listen();
  });
  afterEach(() => {
    stop();
    area.remove();
    vi.restoreAllMocks();
  });

  it("hands a message to the handlers of its type, in the order they asked, with its event", () => {
    const seen: string[] = [];
    messages.on({ "slop:view": (data) => seen.push(`first ${data.k}`) });
    messages.on({
      "slop:view": (data, event) => seen.push(`second ${data.k} ${event.source === frame.contentWindow}`),
      "slop:key": () => seen.push("key"),
    });
    post({ type: "slop:view", k: 2 });
    expect(seen).toEqual(["first 2", "second 2 true"]);
  });

  it("takes messages only from the previews in its area", () => {
    const taken = vi.fn();
    messages.on({ "slop:view": taken });
    const elsewhere = document.createElement("iframe");
    document.body.append(elsewhere);
    post({ type: "slop:view" }, elsewhere.contentWindow);
    post({ type: "slop:view" }, window);
    post({ type: "slop:view" }, null);
    post("slop:view");
    post(null);
    expect(taken).not.toHaveBeenCalled();
    post({ type: "slop:view" });
    expect(taken).toHaveBeenCalledTimes(1);
    elsewhere.remove();
  });

  it("looks for the preview that posted once per message at most, and not again while the same one posts", () => {
    messages.on({ "slop:edit-geometry": () => {}, "slop:view": () => {}, "slop:key": () => {} });
    const search = vi.spyOn(area, "querySelectorAll");
    const anywhere = vi.spyOn(document, "querySelectorAll");
    post({ type: "slop:edit-geometry" });
    expect(search).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 60; i++) post({ type: i % 2 ? "slop:view" : "slop:edit-geometry" });
    expect(search).toHaveBeenCalledTimes(1);
    expect(anywhere).not.toHaveBeenCalled();
  });

  it("does not look at who posted a type nobody takes", () => {
    messages.on({ "slop:view": () => {} });
    const search = vi.spyOn(area, "querySelectorAll");
    post({ type: "slop:other" });
    expect(search).not.toHaveBeenCalled();
  });

  it("finds the preview again once the one it knew is gone, as after a reload of the slide", () => {
    const taken = vi.fn();
    messages.on({ "slop:view": taken });
    post({ type: "slop:view" });
    const gone = frame.contentWindow;
    const next = document.createElement("iframe");
    frame.replaceWith(next);
    post({ type: "slop:view" }, gone);
    expect(taken).toHaveBeenCalledTimes(1);
    post({ type: "slop:view" }, next.contentWindow);
    expect(taken).toHaveBeenCalledTimes(2);
  });

  it("stops handing on what a handler no longer asks for, and everything once it stops listening", () => {
    const taken = vi.fn();
    const off = messages.on({ "slop:view": taken });
    off();
    post({ type: "slop:view" });
    messages.on({ "slop:view": taken });
    stop();
    post({ type: "slop:view" });
    expect(taken).not.toHaveBeenCalled();
  });
});
