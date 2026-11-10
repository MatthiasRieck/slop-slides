import { useEffect, useRef } from "react";

import { useApp } from "../../store";
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
 * Arrow keys / PageUp / PageDown move between slides unless the user is typing, and ⌘C / ⌘V
 * copy and paste whole slides outside edit mode; ⌘C with the slide rail pressed last copies the
 * slide in edit mode too. Also handles
 * keys the slide preview forwards as `slop:key` messages, so navigation keeps working after
 * clicking into the slide. The preview cancels presses on it (to pan, select and drag), which
 * leaves focus where it was, e.g. in the chat composer: it asks for focus with `slop:focus`.
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
    // Out of edit mode, ⌘C / ⌘V copy the selected slide and paste one after it, also from
    // another window (edit mode copies and pastes elements, see useSlideEditing).
    const clipboard = (key: string, shift: boolean, fromApp: boolean, rail = false) => {
      const { editing, presenting, copySlide, pasteSlide } = useApp.getState();
      if (presenting || shift) return false;
      // Copying selected text comes first.
      if (fromApp && window.getSelection()?.toString()) return false;
      const lower = key.toLowerCase();
      // In edit mode the slide editor has the keys (see useSlideEditing; its paste takes slides
      // too), unless ⌘C is pressed on the rail, where the slide is what is selected.
      if (editing && !(rail && lower === "c")) return false;
      if (lower === "c") void copySlide();
      else if (lower === "v") void pasteSlide();
      else return false;
      return true;
    };
    // Out of edit mode, whose keys these are on the slide: the deck's history, the rail's moves
    // (⌘↑ / ⌘↓, also out of a section), and Delete and Escape for the slides picked in it.
    const rail = (key: string, mod: boolean, shift: boolean) => {
      const app = useApp.getState();
      if (app.editing || app.presenting) return false;
      if (mod && runHistoryKey(key, shift)) return true;
      if (mod && key === "ArrowUp") void app.moveSlides(-1);
      else if (mod && key === "ArrowDown") void app.moveSlides(1);
      else if (!mod && app.railSelected.length > 0 && (key === "Delete" || key === "Backspace"))
        void app.deleteSlides(app.railSelected);
      else if (!mod && app.railSelected.length > 0 && key === "Escape") app.clearRailSelection();
      else return false;
      return true;
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]")) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && clipboard(event.key, event.shiftKey, true, keyForRail(target)))
        event.preventDefault();
      else if (!event.altKey && rail(event.key, mod, event.shiftKey)) event.preventDefault();
      else if (navigate(event.key)) event.preventDefault();
    };
    const onPress = (event: PointerEvent) => {
      pressedRail = Boolean((event.target as HTMLElement | null)?.closest?.("[data-slide-rail]"));
    };
    const onMessage = (event: MessageEvent) => {
      const type = event.data?.type;
      if (type !== "slop:key" && type !== "slop:focus") return;
      const slide = Array.from(document.querySelectorAll("iframe")).find(
        (frame) => frame.contentWindow === event.source,
      );
      if (!slide) return;
      if (type === "slop:focus") slide.focus();
      else {
        const key = String(event.data.key);
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
      const target = event.target as HTMLElement | null;
      if (event.key !== "Escape" || target?.closest("input, textarea, [contenteditable]")) return;
      if (useApp.getState().presenting) return;
      putAwayRef.current();
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
