import { useEffect, useRef } from "react";

import { isTypingTarget, keepsKey } from "../../lib/keys";
import { dismissTopLayer } from "../../lib/layers";
import { editingSlide, useApp } from "../../store";
import { runHistoryKey } from "./editKeys";

/** Whether the last press in the app was on the slide rail, so that ⌘C there means the slide. */
let pressedRail = false;

/**
 * Whether a key pressed in the app is meant for the slide rail: its focus is there, or the last
 * press was (WebKit leaves focus where it was when a button is clicked).
 */
export function keyForRail(target: EventTarget | null) {
  return Boolean((target as HTMLElement | null)?.closest?.("[data-slide-rail]")) || pressedRail;
}

/**
 * Arrow keys / PageUp / PageDown move between slides unless the user is typing, and ⌘C copies
 * the whole slide while the slide editor is not at work (in View, or on a locked slide); ⌘C with
 * the slide rail pressed last copies the slide while it is, too. What changes the deck is Edit
 * mode's: ⌘V pasting a slide, and with the rail pressed last, ⌘↑ / ⌘↓ and Delete. Also handles
 * keys the slide preview forwards as `slop:key` messages, so navigation keeps working after
 * clicking into the slide. The preview cancels presses on it (to pan, select and drag), which
 * leaves focus where it was, e.g. in the chat composer: it asks for focus with `slop:focus`.
 * Escape forwarded from the slide first closes what is open in the app (see ../../lib/layers.ts).
 */
export function useSlideKeyboard() {
  useEffect(() => {
    const navigate = (key: string) => {
      if (useApp.getState().presenting) return false;
      if (["ArrowDown", "ArrowRight", "PageDown"].includes(key)) useApp.getState().selectRelative(1);
      else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(key)) useApp.getState().selectRelative(-1);
      else return false;
      return true;
    };
    // With the slide editor not at work, ⌘C copies the selected slide, and in Edit mode ⌘V pastes
    // one after it, also from another window (the editor copies and pastes elements, see
    // useSlideEditing).
    const clipboard = (key: string, shift: boolean, fromApp: boolean, rail = false) => {
      const { presenting, copySlide, pasteSlide } = useApp.getState();
      const editing = editingSlide(useApp.getState());
      if (presenting || shift) return false;
      // Copying selected text comes first.
      if (fromApp && window.getSelection()?.toString()) return false;
      const lower = key.toLowerCase();
      // At work, the slide editor has the keys (see useSlideEditing; its paste takes slides
      // too), unless ⌘C is pressed on the rail, where the slide is what is selected.
      if (editing && !(rail && lower === "c")) return false;
      if (lower === "c") void copySlide();
      // Pasting a slide changes the deck, which only Edit mode does.
      else if (lower === "v" && useApp.getState().editing) void pasteSlide();
      else return false;
      return true;
    };
    // The deck's history, the rail's moves (⌘↑ / ⌘↓, also out of a section), and Delete and
    // Escape for the slides picked in it. With the slide editor at work the keys are its own,
    // but for those pressed `onRail`; and the moves and Delete change the deck, so they are
    // Edit mode's.
    const rail = (key: string, mod: boolean, shift: boolean, onRail = false) => {
      const app = useApp.getState();
      if (app.presenting) return false;
      const editor = editingSlide(app);
      if (editor && !onRail) return false;
      // The editor's own keys undo and redo while it is at work.
      if (!editor && mod && runHistoryKey(key, shift)) return true;
      if (app.editing && mod && key === "ArrowUp") void app.moveSlides(-1);
      else if (app.editing && mod && key === "ArrowDown") void app.moveSlides(1);
      else if (app.editing && !mod && app.railSelected.length > 0 && (key === "Delete" || key === "Backspace"))
        void app.deleteSlides(app.railSelected);
      else if (!mod && app.railSelected.length > 0 && key === "Escape") app.clearRailSelection();
      else return false;
      return true;
    };
    const onKey = (event: KeyboardEvent) => {
      // Typing keeps its keys, and so does a widget its plain ones (the arrows of a tab list, say).
      if (keepsKey(event)) return;
      const target = event.target as HTMLElement | null;
      const mod = event.metaKey || event.ctrlKey;
      const onRail = keyForRail(target);
      if (mod && !event.altKey && clipboard(event.key, event.shiftKey, true, onRail)) event.preventDefault();
      else if (!event.altKey && rail(event.key, mod, event.shiftKey, onRail)) event.preventDefault();
      else if (navigate(event.key)) event.preventDefault();
    };
    const onPress = (event: PointerEvent) => {
      pressedRail = Boolean((event.target as HTMLElement | null)?.closest?.("[data-slide-rail]"));
    };
    const onMessage = (event: MessageEvent) => {
      const type = event.data?.type;
      if (type !== "slop:key" && type !== "slop:focus" && type !== "slop:press") return;
      const slide = Array.from(document.querySelectorAll("iframe")).find(
        (frame) => frame.contentWindow === event.source,
      );
      if (!slide) return;
      if (type === "slop:focus") slide.focus();
      // A press in the slide is a press off the rail, though it never reaches this window.
      else if (type === "slop:press") pressedRail = false;
      else {
        const key = String(event.data.key);
        // Escape closes what is open in the app (a menu, a toast) before it means anything else.
        if (key === "Escape" && dismissTopLayer(event)) return;
        const [mod, shift] = [Boolean(event.data.mod), Boolean(event.data.shift)];
        if (!(mod && clipboard(key, shift, false)) && !rail(key, mod, shift)) navigate(key);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    window.addEventListener("pointerdown", onPress, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pointerdown", onPress, true);
      pressedRail = false;
    };
  }, []);
}

/** Escape puts a sketch tool away, unless the user is typing. */
export function useSketchKeyboard(active: boolean, putAway: () => void) {
  const putAwayRef = useRef(putAway);
  putAwayRef.current = putAway;
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isTypingTarget(event.target)) return;
      if (useApp.getState().presenting) return;
      putAwayRef.current();
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
