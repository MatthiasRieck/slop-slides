import { afterEach, vi } from "vitest";
import { installRenderHook } from "./renderCounts";
import * as tauri from "./tauri";

// Before React DOM loads, which looks for it once: tests may count renders (see ./renderCounts.ts).
installRenderHook();

// Every test runs against the shared Tauri stand-ins in ./tauri.
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: tauri.Channel }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen, emit: tauri.emit }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: tauri.getCurrentWindow,
  UserAttentionType: { Critical: 1, Informational: 2 },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: tauri.ask, save: tauri.save, open: tauri.open }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: tauri.revealItemInDir, openUrl: tauri.openUrl }));

afterEach(() => {
  for (const mock of tauri.tauriMocks) mock.mockClear();
});

// The app's yes-or-no questions (`confirmAction` in ../store/confirm.ts) are asked in a dialog of
// its own. A test answers one as it answered the native dialog before it: by what the `ask`
// stand-in resolves to, called with the message and the dialog's title and labels. While `ask`
// gives no answer (its default), the question stays open for the test to press a button of
// components/ConfirmDialog.tsx. No question outlives its test.
// A store module loaded afresh (`freshModule` in ../store/testing.ts) brings its own questions,
// which it answers the same way through `answerQuestionsWithAsk`.
tauri.answerQuestionsWithAsk((await import("../store/confirm")).useConfirmQuestion);
afterEach(tauri.dropOpenQuestions);

// Files that need no DOM run in the `node` environment (`// @vitest-environment node`); the rest
// get jsdom and what it lacks.
if (typeof document !== "undefined") await setUpDom();

async function setUpDom() {
  const { cleanup } = await import("@testing-library/react");
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

  // No layout, so nothing scrolls: everything is in view unless a test places it (see ./intersection.ts).
  const { installIntersectionObserver, resetPlaces } = await import("./intersection");
  installIntersectionObserver();
  afterEach(resetPlaces);

  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
