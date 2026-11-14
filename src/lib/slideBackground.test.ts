// @vitest-environment node
import { describe, expect, it } from "vitest";

import { withSlideBackground } from "./slideBackground";

describe("withSlideBackground", () => {
  it("gives a slide its own background color over the deck's gradient or image", () => {
    expect(withSlideBackground('<section class="slide" id="a"><h1>Hi</h1></section>', "#ff0000")).toBe(
      '<section class="slide" id="a" style="background-color: #ff0000; background-image: none"><h1>Hi</h1></section>',
    );
  });

  it("replaces a background it had, keeping the rest of its style", () => {
    const markup = '<section id="a" style="color: red; background-color: #000; background-image: url(\'x;y.png\')">';
    expect(withSlideBackground(markup, "#00ff00")).toBe(
      '<section id="a" style="color: red; background-color: #00ff00; background-image: none">',
    );
  });

  it("takes its own background off with null, so the deck's shows", () => {
    expect(withSlideBackground('<section id="a" style="background-color: #000; background-image: none">x', null)).toBe(
      '<section id="a">x',
    );
    expect(withSlideBackground('<section id="a" style="padding: 0; background-color: #000">x', null)).toBe(
      '<section id="a" style="padding: 0">x',
    );
  });

  it("leaves markup that does not start with a tag as it is", () => {
    expect(withSlideBackground("just text", "#ffffff")).toBe("just text");
  });
});
