/**
 * A slide in the stage's edit-mode preview, for the slide editor's tests: the deck page with the
 * scripts the backend adds for editing (the player, the pasteboard, overflow detection and the
 * editor, in that order), and ways to point, type and message at it as the app does.
 */
import EDITOR from "../../src-tauri/assets/editor.js?raw";
import OVERFLOW from "../../src-tauri/assets/overflow.js?raw";
import PASTEBOARD from "../../src-tauri/assets/pasteboard.js?raw";
import RUNTIME from "../../src-tauri/assets/runtime.js?raw";
import { openDeck } from "./deckDom";

/** A message the editor posted to the app. */
export interface Message {
  type: string;
  [key: string]: unknown;
}

/** A `slop:edit-commit`: the slide's markup to save. */
export interface Commit extends Message {
  slide: string;
  markup: string;
  select: number[] | null;
}

export interface EditorPageOptions {
  markup: string;
  slide?: string;
  /** Inside the app's preview iframe; the editor does nothing outside one. */
  framed?: boolean;
}

export function editorPage({ markup, slide = "intro", framed = true }: EditorPageOptions) {
  const posted: Message[] = [];
  const parent = { postMessage: (data: Message) => posted.push(data) };
  const window = openDeck(markup, {
    url: `https://example.test/deck.html?embed&slide=${slide}&static&edit=0`,
    size: [1920, 1080],
    parent: framed ? parent : undefined,
    visual: true,
    scripts: [RUNTIME, PASTEBOARD, OVERFLOW, EDITOR],
  });
  const doc = window.document;
  const $ = (selector: string) => doc.querySelector<HTMLElement>(selector)!;
  const pointer = (type: string, target: Element, x: number, y: number, init: PointerEventInit = {}) =>
    target.dispatchEvent(
      new window.PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true, ...init }),
    );
  const page = {
    window,
    doc,
    $,
    posted: () => posted,
    /** The messages of `type` posted so far, as the shape that type has. */
    messages: <T = Message>(type: string) => posted.filter((m) => m.type === type) as unknown as T[],
    commits: () => posted.filter((m) => m.type === "slop:edit-commit") as Commit[],
    keys: () => posted.filter((m) => m.type === "slop:key"),
    pointer,
    down: (target: Element, x = 100, y = 100, init: PointerEventInit = {}) =>
      pointer("pointerdown", target, x, y, init),
    move: (target: Element, x: number, y: number, init: PointerEventInit = {}) =>
      pointer("pointermove", target, x, y, init),
    up: (target: Element, x = 100, y = 100) => pointer("pointerup", target, x, y),
    click(target: Element, init: PointerEventInit = {}) {
      page.down(target, 100, 100, init);
      page.up(target);
    },
    drag(target: Element, dx: number, dy: number, init: PointerEventInit = {}) {
      page.down(target, 100, 100, init);
      page.move(target, 100 + dx, 100 + dy, init);
      page.up(target, 100 + dx, 100 + dy);
    },
    key: (key: string, init: KeyboardEventInit = {}) => {
      const event = new window.KeyboardEvent("keydown", { key, cancelable: true, bubbles: true, ...init });
      (doc.activeElement ?? doc.body).dispatchEvent(event);
      return event;
    },
    /** A message from the app, which the editor only takes from its parent window. */
    fromParent: (data: unknown) => {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { value: parent });
      window.dispatchEvent(event);
    },
    selected: () => [...doc.querySelectorAll("[data-slop-selected]")],
  };
  return page;
}
