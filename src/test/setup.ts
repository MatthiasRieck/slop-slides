import { afterEach, vi } from "vitest";
import * as tauri from "./tauri";

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

  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
