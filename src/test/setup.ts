import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// jsdom does no layout; CodeMirror measures text through these.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
const zeroRect = () => new DOMRect(0, 0, 0, 0);
Range.prototype.getClientRects = emptyRects;
Range.prototype.getBoundingClientRect = zeroRect;
Element.prototype.scrollIntoView ??= () => {};

window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom has no 2D canvas (and logs an error when asked for one); ink drafts skip drawing without it.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
