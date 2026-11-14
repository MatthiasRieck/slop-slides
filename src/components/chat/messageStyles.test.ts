// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { MESSAGE } from "./messageStyles";

describe("a message's styles", () => {
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  const rule = /\.chat-message\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  it("carries the class that lets the browser skip messages out of view", () => {
    expect(MESSAGE.split(" ")).toContain("chat-message");
  });

  it("skips the layout of messages out of view, taking them to be as tall as when last seen", () => {
    expect(rule).toMatch(/content-visibility:\s*auto;/);
    // `auto` first: the height it had when last laid out, and the guess only before that.
    expect(rule).toMatch(/contain-intrinsic-size:\s*auto\s+[\d.]+rem;/);
  });

  it("leaves room inside its box for a focus ring at its edge, taking none in the conversation", () => {
    const [, padding] = /padding:\s*(\d+)px;/.exec(rule) ?? [];
    const [, margin] = /margin:\s*-(\d+)px;/.exec(rule) ?? [];
    // The ring is 2px wide, 1px off what it is around (see `:focus-visible`).
    expect(Number(padding)).toBeGreaterThanOrEqual(3);
    expect(margin).toBe(padding);
  });
});
