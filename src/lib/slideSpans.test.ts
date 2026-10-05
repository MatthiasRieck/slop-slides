import { describe, expect, it } from "vitest";

import fixtures from "../../fixtures/slide-spans.json";
import { findSlideSpans } from "./slideSpans";

describe("findSlideSpans", () => {
  // The same cases run against the backend's finder in src-tauri/src/html.rs.
  describe("shared fixtures (parity with the Rust slide finder)", () => {
    it.each(fixtures)("$name", ({ html, slides }) => {
      const actual = findSlideSpans(html).map((s) => ({ id: s.id, source: html.slice(s.from, s.to) }));
      expect(actual).toEqual(slides);
    });
  });

  it("returns ranges that start at `<section` and end after `</section>`", () => {
    const html = `<main>  <section class="slide" id="a">x</section>  </main>`;
    const [span] = findSlideSpans(html);
    expect(span).toEqual({ id: "a", from: 8, to: 8 + `<section class="slide" id="a">x</section>`.length });
  });

  it("measures offsets in UTF-16 code units, matching CodeMirror positions", () => {
    const html = `<p>👋👋</p><section class="slide" id="e">é</section>`;
    const [span] = findSlideSpans(html);
    expect(span!.from).toBe(html.indexOf("<section"));
    expect(html.slice(span!.from, span!.to)).toBe(`<section class="slide" id="e">é</section>`);
  });

  it("numbers unnamed slides by their position among all slides", () => {
    const html = [
      `<section class="slide" id="one"></section>`,
      `<section class="slide"></section>`,
      `<section class="slide" id="three"></section>`,
      `<section class="slide"></section>`,
    ].join("\n");
    expect(findSlideSpans(html).map((s) => s.id)).toEqual(["one", "#2", "three", "#4"]);
  });

  it("stops at an unterminated comment", () => {
    const html = `<section class="slide" id="a">a</section><!-- <section class="slide" id="b">b</section>`;
    expect(findSlideSpans(html).map((s) => s.id)).toEqual(["a"]);
  });

  it("stops at an unterminated script", () => {
    const html = `<section class="slide" id="a">a</section><script> <section class="slide" id="b">b</section>`;
    expect(findSlideSpans(html).map((s) => s.id)).toEqual(["a"]);
  });

  it("ignores a tag whose quoted attribute never closes", () => {
    const html = `<section class="slide" id="a>oops</section>`;
    expect(findSlideSpans(html)).toEqual([]);
  });

  it("handles a document cut off mid-tag (the agent is mid-write)", () => {
    const html = `<section class="slide" id="a">a</section><section class="sli`;
    expect(findSlideSpans(html).map((s) => s.id)).toEqual(["a"]);
  });

  it("finds hundreds of slides in a large deck quickly", () => {
    const slide = (i: number) =>
      `<section class="slide" id="s${i}">\n  <div><p>${"text ".repeat(40)}</p></div>\n</section>\n`;
    const html = `<style>${".x{color:red}\n".repeat(2000)}</style>` + Array.from({ length: 500 }, (_, i) => slide(i)).join("");
    const started = performance.now();
    const spans = findSlideSpans(html);
    expect(spans).toHaveLength(500);
    expect(spans.at(-1)!.id).toBe("s499");
    // Runs on every keystroke in the HTML view.
    expect(performance.now() - started).toBeLessThan(200);
  });
});
