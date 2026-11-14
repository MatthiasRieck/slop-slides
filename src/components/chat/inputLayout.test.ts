import { describe, expect, it } from "vitest";

import { fitInput, showCaret } from "./inputLayout";

/** An input 50 pixels tall whose text is 10 pixels tall per letter, with how it was handled. */
function input(value: string) {
  const el = document.createElement("textarea");
  el.value = value;
  const seen = { swaps: 0, measured: 0 };
  const own = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
  Object.defineProperty(el, "value", {
    configurable: true,
    get: () => own.get!.call(el),
    set: (next: string) => {
      seen.swaps++;
      own.set!.call(el, next);
    },
  });
  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => {
      seen.measured++;
      return el.value.length * 10;
    },
  });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 50 });
  return { el, seen };
}

describe("fitInput", () => {
  it("keeps an empty input at its smallest, without measuring", () => {
    const { el, seen } = input("");
    fitInput(el, "");
    expect(el.style.height).toBe("64px");
    expect(seen.measured).toBe(0);
  });

  it("grows with the text, to a point", () => {
    const { el, seen } = input("123456789012");
    fitInput(el, el.value);
    expect(el.style.height).toBe("120px");
    expect(seen.measured).toBe(1);
    const long = input("x".repeat(40));
    fitInput(long.el, long.el.value);
    expect(long.el.style.height).toBe("240px");
  });
});

describe("showCaret", () => {
  it("scrolls to the end of the text without taking the text out to measure it", () => {
    const { el, seen } = input("abcdefghij klmno");
    showCaret(el, el.value.length);
    expect(el.scrollTop).toBe(110);
    expect(seen.swaps).toBe(0);
    expect(seen.measured).toBe(1);
  });

  it("measures the text up to a caret in the middle, and puts all of it back", () => {
    const { el, seen } = input("abcdefghij klmno");
    showCaret(el, 8);
    // 8 letters end 80 pixels down: its last line sits at the bottom of the box.
    expect(el.scrollTop).toBe(30);
    expect(el.value).toBe("abcdefghij klmno");
    expect(seen.swaps).toBe(2);
  });

  it("leaves the input where it is while the caret is in view, and scrolls up to one above", () => {
    const { el } = input("abcdefghij klmno");
    el.scrollTop = 40;
    showCaret(el, 6);
    expect(el.scrollTop).toBe(40);
    showCaret(el, 2);
    expect(el.scrollTop).toBe(0);
  });
});
