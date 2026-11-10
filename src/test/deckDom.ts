/**
 * A deck page in a jsdom window of its own, for the tests of the scripts the backend injects into
 * decks (src-tauri/assets/*.js). Each test file runs in the `node` environment and opens as many
 * pages as it needs; they are closed, and real timers restored, after every test.
 */
import { type DOMWindow, JSDOM } from "jsdom";
import { afterEach, vi } from "vitest";

export interface DeckPageOptions {
  /** The page's URL; the scripts read their mode from its query and hash. `about:blank` without. */
  url?: string;
  /** `innerWidth` × `innerHeight`; jsdom's default without. */
  size?: [number, number];
  /** Pretend to be inside an iframe: the window's `parent`, which receives its postMessages. */
  parent?: { postMessage: (data: never, origin: string) => void };
  /** The `.deck` stage's laid-out size (the runtime CSS gives it the slide size); 0×0 without. */
  stage?: [number, number];
  /** jsdom's `pretendToBeVisual`, which gives the page `requestAnimationFrame`. */
  visual?: boolean;
  /** Runs before the scripts, e.g. to fake layout or what jsdom does not have. */
  setup?: (window: DOMWindow) => void;
  /** The scripts' sources, run in order as the backend injects them. */
  scripts?: string[];
}

let pages: JSDOM[] = [];

afterEach(() => {
  for (const page of pages) page.window.close();
  pages = [];
  vi.useRealTimers();
});

/** Opens `html` as a deck page and runs `scripts` in it. */
export function openDeck(
  html: string,
  { url, size, parent, stage, visual = false, setup, scripts = [] }: DeckPageOptions = {},
): DOMWindow {
  const dom = new JSDOM(html, {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: visual,
    beforeParse(window) {
      if (size) {
        Object.defineProperty(window, "innerWidth", { value: size[0], configurable: true });
        Object.defineProperty(window, "innerHeight", { value: size[1], configurable: true });
      }
      if (parent) Object.defineProperty(window, "parent", { value: parent, configurable: true });
    },
  });
  pages.push(dom);
  const stageEl = dom.window.document.querySelector(".deck");
  if (stage && stageEl) {
    Object.defineProperty(stageEl, "offsetWidth", { value: stage[0], configurable: true });
    Object.defineProperty(stageEl, "offsetHeight", { value: stage[1], configurable: true });
  }
  setup?.(dom.window);
  for (const script of scripts) dom.window.eval(script);
  return dom.window;
}

/**
 * Opens `html` for one of the export helpers (`pdf`, `pptx`, `render`, `video`.js), which the
 * backend runs in a hidden window and which answer it by navigating; jsdom cannot, so they answer
 * through `__slop<Name>Signal` and the answers are recorded. `setTimeout` is faked, and `settle`
 * runs out the helper's waits for the page. `api` is the helper's `__slop<Name>`.
 */
export function openHelper<Api>(
  html: string,
  name: "Pdf" | "Pptx" | "Render" | "Video",
  { url = "https://example.test/talk/deck.html?static&print", setup, ...options }: DeckPageOptions = {},
) {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const answers: string[] = [];
  const window = openDeck(html, {
    ...options,
    url,
    setup(window) {
      Object.assign(window, { [`__slop${name}Signal`]: (answer: string) => answers.push(answer) });
      setup?.(window);
    },
  });
  const api = (window as unknown as Record<string, Api>)[`__slop${name}`]!;
  const settle = async () => {
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(5000);
  };
  return { window, doc: window.document, api, answers, settle };
}
