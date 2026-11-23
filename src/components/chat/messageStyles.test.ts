// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MESSAGE_ITEM, ON_HOVER } from "./messageStyles";

describe("a message's styles", () => {
  const scroller = readFileSync(new URL("../ui/message-scroller.tsx", import.meta.url), "utf8");
  const item = /function MessageScrollerItem[\s\S]*?\n}\n/.exec(scroller)?.[0] ?? "";

  it("skips the layout of messages out of view, taking them to be as tall as when last seen", () => {
    expect(item).toContain("[content-visibility:auto]");
    // `auto` first: the height it had when last laid out, and the guess only before that.
    expect(item).toMatch(/\[contain-intrinsic-size:auto_[\d.]+rem\]/);
  });

  it("leaves room inside its box for a focus ring at its edge, taking none in the conversation", () => {
    const [, padding] = /(?:^| )p-(\d+)(?: |$)/.exec(MESSAGE_ITEM) ?? [];
    const [, margin] = /(?:^| )-m-(\d+)(?: |$)/.exec(MESSAGE_ITEM) ?? [];
    // The ring is 3px wide (see the ui components); a step of the spacing scale is 4px.
    expect(Number(padding) * 4).toBeGreaterThanOrEqual(3);
    expect(margin).toBe(padding);
  });

  it("shows what is kept for hovering when its message is hovered, or the keyboard is on it", () => {
    const classes = ON_HOVER.split(" ");
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("group-hover/message:opacity-100");
    expect(classes).toContain("focus-visible:opacity-100");
  });
});
