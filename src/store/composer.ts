import type { EditElement } from "../lib/editTools";
import type { AppStore, Slice } from "./types";

/** What a prepared message brings besides its text. */
export interface FillOptions {
  /** A slide screenshot shown with the text and sent along with the message. */
  screenshot?: string | null;
  /** The element of the slide the message is about. */
  element?: EditElement;
  /** Files and images that go along, as the message they come from had them. */
  attachments?: string[];
  /** The other slides the message refers to, by id. */
  slides?: string[];
  /** Whether the message is about the slide on show; left as the composer has it when absent. */
  includeSlide?: boolean;
  /** The sent message being edited: sending the composer's message takes its place (see `ChatSlice.editMessage`). */
  edit?: string;
}

/** A message being written, with what goes along with it, as the composer hands it over to be kept. */
export interface ComposerDraft {
  text: string;
  attachments: string[];
  /** The attachments among them that this composer saved and no message was sent with yet (see `useAttachments`). */
  unsent: Record<string, { target: string; asset: string }>;
  screenshot: string | null;
  element: EditElement | null;
  includeSlide: boolean;
  /** The slides added with "@", by id. */
  slides: string[];
}

/**
 * The drafts of the chats not on show, by what each chat is about (`chatKey`). Kept for as long
 * as the app runs: what one was writing in a deck's chat is there again on coming back to it.
 */
const drafts = new Map<string, ComposerDraft>();

/** Whether `draft` holds anything worth keeping. */
const isBlank = (draft: ComposerDraft) =>
  !draft.text.trim() &&
  draft.attachments.length === 0 &&
  !draft.screenshot &&
  !draft.element &&
  draft.slides.length === 0;

/** Keeps `draft` as what is being written in the chat about `chat`; a blank one keeps nothing. */
export function keepDraft(chat: string, draft: ComposerDraft) {
  if (isBlank(draft)) drafts.delete(chat);
  else drafts.set(chat, draft);
}

/** What was being written in the chat about `chat` when it was last on show; null when nothing was. */
export function keptDraft(chat: string | null): ComposerDraft | null {
  return (chat && drafts.get(chat)) || null;
}

/** Forgets every draft kept (tests start from none). */
export function forgetDrafts() {
  drafts.clear();
}

/** What waits for the chat composer: prepared text and images to attach. */
export interface ComposerSlice {
  /**
   * Text to put in the chat composer, with a counter so the same text can be sent twice; null
   * once the composer took it (see `clearComposerFill`).
   * What comes with it (see `FillOptions`) joins what the composer holds. The text goes after a
   * draft already there; without text, the draft stays as it is.
   */
  composerFill: ({ text: string; rev: number } & Omit<FillOptions, "screenshot"> & { screenshot?: string }) | null;
  /** Images waiting to be attached in the chat composer (screenshots of areas commented on). */
  composerImages: string[];
  /** Goes up each time the composer is asked to take the keyboard focus. */
  composerFocus: number;

  /** Hands the composer `text`: it goes after a draft already there, which is never lost to it. */
  fillComposer: (text: string, options?: FillOptions) => void;
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

  fillComposer: (text, { screenshot, element, attachments, slides, includeSlide, edit } = {}) =>
    set((s) => ({
      composerFill: {
        text,
        rev: (s.composerFill?.rev ?? 0) + 1,
        ...(screenshot && { screenshot }),
        ...(element && { element }),
        ...(attachments?.length && { attachments }),
        ...(slides?.length && { slides }),
        ...(includeSlide !== undefined && { includeSlide }),
        ...(edit && { edit }),
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
