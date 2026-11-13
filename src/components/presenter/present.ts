import { useEffect } from "react";
import { create } from "zustand";

import { api, type Screen } from "../../lib/api";
import { isTextField } from "../../lib/keys";
import { hasOpenLayer } from "../../lib/layers";
import { type Placement, type ScreenChoice, type ShowStart, saveChoice } from "../../lib/screens";
import { useApp } from "../../store";

/** The longest the screen picker waits for the screens to be captured before opening anyway. */
export const PICKER_MAX_WAIT_MS = 150;

/** The keys that start a show: from the selected slide, and (with Shift) from the first. */
export const PRESENT_KEYS: Record<ShowStart, string> = { current: "mod+enter", start: "mod+shift+enter" };

/**
 * Starting a show: with one screen it starts at once, with several it first asks where the slides
 * and the presenter view go (see ../ScreenPicker.tsx, which shows while `screens` is set).
 */
interface PresentState {
  /** The attached screens while the picker is open. */
  screens: Screen[] | null;
  /** Their screenshots, by screen; null while they are being taken. */
  previews: (string | null)[] | null;
  /** Where the show being asked about starts. */
  from: ShowStart;
  /** Presents from `from`, asking which screens to use when there are several. */
  present: (from?: ShowStart) => Promise<void>;
  /** Presents in windows: the slides in this window, the presenter view in one of its own. */
  presentInWindows: (from?: ShowStart) => void;
  /** Starts the show the picker asked about on the screens picked, which are remembered for these screens. */
  start: (choice: ScreenChoice) => void;
  close: () => void;
}

/** Whether there is a show to start: a deck with a slide, and none running. */
function canPresent(): boolean {
  const { deck, presenting } = useApp.getState();
  return !presenting && !!deck && deck.slides.length > 0;
}

const begin = (placement: Placement | null, from: ShowStart) => useApp.getState().setPresenting(true, placement, from);

export const usePresent = create<PresentState>((set, get) => ({
  screens: null,
  previews: null,
  from: "current",

  present: async (from = "current") => {
    if (!canPresent() || get().screens) return;
    const attached = await api.listScreens().catch(() => []);
    if (attached.length <= 1) return begin(null, from);
    // The picker opens as soon as the screens are captured, so that it isn't in the screenshots,
    // and they come in while it is open. It doesn't wait long for that: capturing can get stuck
    // on the system asking for permission. Only once, or it would come back after a cancel.
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      clearTimeout(timer);
      set({ screens: attached, from });
    };
    const timer = setTimeout(open, PICKER_MAX_WAIT_MS);
    set({ previews: null });
    const taken = await api.screenPreviews(open).catch(() => []);
    open();
    set({ previews: taken });
  },

  presentInWindows: (from = "current") => {
    if (!canPresent()) return;
    set({ screens: null });
    begin("windows", from);
  },

  start: (choice) => {
    const { screens, from } = get();
    if (screens) saveChoice(screens, choice);
    set({ screens: null });
    begin(choice, from);
  },

  close: () => set({ screens: null }),
}));

/** Which show the keys ask for, if any: ⌘↵ from the selected slide, ⇧⌘↵ from the first. */
function asksToPresent(key: string, mod: boolean, shift: boolean, alt: boolean): ShowStart | null {
  if (key !== "Enter" || !mod || alt) return null;
  return shift ? "start" : "current";
}

const isFrame = (source: MessageEventSource | null) =>
  Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === source);

/**
 * The keys that start a show, anywhere in the app: ⌘↵ from the selected slide and ⇧⌘↵ from the
 * first one, also pressed in a slide preview (which forwards its keys as `slop:key`). Not in a
 * text field, where ⌘↵ sends, commits or finishes what is typed, nor under a menu or dialog.
 */
export function usePresentKeys() {
  useEffect(() => {
    const present = (from: ShowStart | null) => {
      if (!from || hasOpenLayer() || !canPresent()) return false;
      void usePresent.getState().present(from);
      return true;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextField(event.target)) return;
      const mod = event.metaKey || event.ctrlKey;
      if (present(asksToPresent(event.key, mod, event.shiftKey, event.altKey))) event.preventDefault();
    };
    const onMessage = (event: MessageEvent) => {
      const { type, key, mod, shift, alt } = event.data ?? {};
      if (type !== "slop:key" || !isFrame(event.source)) return;
      present(asksToPresent(String(key), Boolean(mod), Boolean(shift), Boolean(alt)));
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);
}
