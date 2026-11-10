import type { EditElement } from "../lib/editTools";
import type { AppStore, Slice } from "./types";

/** What waits for the chat composer: prepared text and images to attach. */
export interface ComposerSlice {
  /**
   * Text to put in the chat composer, with a counter so the same text can be sent twice.
   * `screenshot` is a slide screenshot shown with the text and sent along with the message, and
   * `element` an element of the slide the message is about. Without text, the draft stays.
   */
  composerFill: { text: string; rev: number; screenshot?: string; element?: EditElement } | null;
  /** Images waiting to be attached in the chat composer (screenshots of areas commented on). */
  composerImages: string[];

  fillComposer: (text: string, options?: { screenshot?: string | null; element?: EditElement }) => void;
  /** Attaches `path` in the chat composer, now or once it is shown, keeping its draft. */
  attachToComposer: (path: string) => void;
  /** The images waiting for the composer, which it then holds. */
  takeComposerImages: () => string[];
}

export const createComposerSlice: Slice<ComposerSlice> = (set, get) => ({
  composerFill: null,
  composerImages: [],

  fillComposer: (text, { screenshot, element } = {}) =>
    set((s) => ({
      composerFill: {
        text,
        rev: (s.composerFill?.rev ?? 0) + 1,
        ...(screenshot && { screenshot }),
        ...(element && { element }),
      },
    })),

  attachToComposer: (path) =>
    set((s) => (s.composerImages.includes(path) ? s : { composerImages: [...s.composerImages, path] })),

  takeComposerImages: () => {
    const images = get().composerImages;
    if (images.length > 0) set({ composerImages: [] });
    return images;
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
