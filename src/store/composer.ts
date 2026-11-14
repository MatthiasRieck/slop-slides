import type { EditElement } from "../lib/editTools";
import type { AppStore, Slice } from "./types";

/** What waits for the chat composer: prepared text and images to attach. */
export interface ComposerSlice {
  /**
   * Text to put in the chat composer, with a counter so the same text can be sent twice; null
   * once the composer took it (see `clearComposerFill`).
   * `screenshot` is a slide screenshot shown with the text and sent along with the message, and
   * `element` an element of the slide the message is about. The text goes after a draft already
   * there; without text, the draft stays as it is.
   */
  composerFill: { text: string; rev: number; screenshot?: string; element?: EditElement } | null;
  /** Images waiting to be attached in the chat composer (screenshots of areas commented on). */
  composerImages: string[];
  /** Goes up each time the composer is asked to take the keyboard focus. */
  composerFocus: number;

  /** Hands the composer `text`: it goes after a draft already there, which is never lost to it. */
  fillComposer: (text: string, options?: { screenshot?: string | null; element?: EditElement }) => void;
  /** The composer took what was handed to it: nothing waits for it any more. */
  clearComposerFill: () => void;
  /** Attaches `path` in the chat composer, now or once it is shown, keeping its draft. */
  attachToComposer: (path: string) => void;
  /** The images waiting for the composer, which it then holds. */
  takeComposerImages: () => string[];
  /** Shows the chat, if it is hidden, and puts the keyboard focus in its composer. */
  focusComposer: () => void;
}

export const createComposerSlice: Slice<ComposerSlice> = (set, get) => ({
  composerFill: null,
  composerImages: [],
  composerFocus: 0,

  fillComposer: (text, { screenshot, element } = {}) =>
    set((s) => ({
      composerFill: {
        text,
        rev: (s.composerFill?.rev ?? 0) + 1,
        ...(screenshot && { screenshot }),
        ...(element && { element }),
      },
    })),

  clearComposerFill: () => {
    if (get().composerFill) set({ composerFill: null });
  },

  attachToComposer: (path) =>
    set((s) => (s.composerImages.includes(path) ? s : { composerImages: [...s.composerImages, path] })),

  takeComposerImages: () => {
    const images = get().composerImages;
    if (images.length > 0) set({ composerImages: [] });
    return images;
  },

  focusComposer: () => {
    const { sidebarOpen, sidebarTab, setSidebarTab } = get();
    if (!sidebarOpen || sidebarTab !== "chat") setSidebarTab("chat");
    set((s) => ({ composerFocus: s.composerFocus + 1 }));
  },
});

/** Hands the composer a prepared message, showing the chat if it is hidden. */
export function promptAgent(
  app: AppStore,
  text: string,
  options?: { screenshot?: string | null; element?: EditElement },
) {
  const { sidebarOpen, sidebarTab, setSidebarTab, fillComposer } = app.getState();
  if (!sidebarOpen || sidebarTab !== "chat") setSidebarTab("chat");
  fillComposer(text, options);
}
