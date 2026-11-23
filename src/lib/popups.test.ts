import { describe, expect, it, vi } from "vitest";

import { closeBesideAnchor } from "./popups";

describe("closeBesideAnchor", () => {
  const anchor = document.createElement("button");
  const inside = anchor.appendChild(document.createElement("span"));
  const beside = document.createElement("div");
  const press = (target: Element) => {
    const event = new MouseEvent("pointerdown");
    Object.defineProperty(event, "target", { value: target });
    return event;
  };

  it("closes on Escape and on a press beside the panel", () => {
    const close = vi.fn();
    const onOpenChange = closeBesideAnchor({ current: anchor }, close);
    onOpenChange(false, { reason: "escape-key", event: new KeyboardEvent("keydown") });
    onOpenChange(false, { reason: "outside-press", event: press(beside) });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("leaves a press on its anchor to the anchor, which toggles the panel itself", () => {
    const close = vi.fn();
    const onOpenChange = closeBesideAnchor({ current: anchor }, close);
    onOpenChange(false, { reason: "outside-press", event: press(anchor) });
    onOpenChange(false, { reason: "outside-press", event: press(inside) });
    expect(close).not.toHaveBeenCalled();
  });

  it("does nothing when the panel is said to open, and closes with no anchor in the page", () => {
    const close = vi.fn();
    closeBesideAnchor({ current: anchor }, close)(true, { reason: "trigger-press", event: press(anchor) });
    expect(close).not.toHaveBeenCalled();
    closeBesideAnchor({ current: null }, close)(false, { reason: "outside-press", event: press(anchor) });
    expect(close).toHaveBeenCalledOnce();
  });
});
