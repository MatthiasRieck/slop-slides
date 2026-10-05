import { describe, expect, it } from "vitest";

import runtime from "../../src-tauri/assets/runtime.js?raw";

/** Loads a deck into the document and runs the player at `url`. */
function play(url: string, sections: string) {
  history.replaceState(null, "", url);
  document.body.innerHTML = `<main class="deck">${sections}</main>`;
  new Function(runtime)();
}

const active = () => [...document.querySelectorAll(".slide.active")].map((el) => el.id);
const press = (key: string) => window.dispatchEvent(new KeyboardEvent("keydown", { key }));

const DECK = [
  `<section class="slide" id="a"></section>`,
  `<section class="slide" id="b" data-hidden></section>`,
  `<section class="slide" id="c"></section>`,
  `<section class="slide" id="d" data-hidden></section>`,
].join("");

describe("player runtime: hidden slides", () => {
  it("skips hidden slides when navigating", () => {
    play("/deck.html#a", DECK);
    expect(active()).toEqual(["a"]);
    press("ArrowRight");
    expect(active()).toEqual(["c"]);
    press("ArrowRight");
    expect(active()).toEqual(["c"]);
    press("ArrowLeft");
    expect(active()).toEqual(["a"]);
    press("End");
    expect(active()).toEqual(["c"]);
  });

  it("starting on a hidden slide lands on the next shown one", () => {
    play("/deck.html#b", DECK);
    expect(active()).toEqual(["c"]);
  });

  it("starting on a trailing hidden slide lands on the last shown one", () => {
    play("/deck.html#d", DECK);
    expect(active()).toEqual(["c"]);
  });

  it("numbers slides by shown position", () => {
    play("/deck.html#2", DECK);
    expect(active()).toEqual(["c"]);
  });

  it("still renders a hidden slide when the editor embeds it", () => {
    play("/deck.html?embed&slide=b", DECK);
    expect(active()).toEqual(["b"]);
  });
});
