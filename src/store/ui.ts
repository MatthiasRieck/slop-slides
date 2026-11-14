import type { Placement, ShowStart } from "../lib/screens";
import { loadFlag, loadJson, loadText, saveFlag, saveJson, saveText } from "../lib/storage";
import type { Slice } from "./types";

/**
 * What the right sidebar can show, each in a tab of its own, in the order of the tabs (see
 * components/Sidebar.tsx). They are a fixed set of panels, not documents: the chat and the files
 * are always there, the deck's panels while a deck is open, a drawing's while it is being edited.
 */
export const SIDEBAR_TABS = ["chat", "files", "narration", "code", "svg"] as const;
export type SidebarTab = (typeof SIDEBAR_TABS)[number];
const isSidebarTab = (value: unknown): value is SidebarTab => SIDEBAR_TABS.includes(value as SidebarTab);
/** The tabs about the open deck, which are not offered without one. */
const DECK_TABS: readonly SidebarTab[] = ["narration", "code"];
/**
 * The tabs that are there only while what they hold is open (the drawing being edited):
 * `setSidebarTab` opens one, and `closeSidebarTab` takes it away again.
 */
const ON_DEMAND_TABS: readonly SidebarTab[] = ["svg"];
const isOnDemand = (tab: SidebarTab) => ON_DEMAND_TABS.includes(tab);
/** The tab the sidebar shows when the one asked for is not there. */
const FALLBACK_TAB: SidebarTab = "chat";

/** The sidebar's tabs, in order, with or without a deck open and with the on-demand tabs `opened`. */
export function sidebarTabsFor(hasDeck: boolean, opened: readonly SidebarTab[]): SidebarTab[] {
  return SIDEBAR_TABS.filter((tab) => (isOnDemand(tab) ? opened.includes(tab) : hasDeck || !DECK_TABS.includes(tab)));
}

const SIDEBAR_OPEN_KEY = "slopslide.sidebarOpen";
const SIDEBAR_TAB_KEY = "slopslide.sidebarTab";
const RAIL_OPEN_KEY = "slopslide.railOpen";
const FINAL_STATE_KEY = "slopslide.finalState";
const TIMELINE_OPEN_KEY = "slopslide.timelineOpen";
const NOTES_OPEN_KEY = "slopslide.notesOpen";
const NOTES_HEIGHT_KEY = "slopslide.notesHeight";

/** How tall the speaker notes under the slide can be made, in pixels, and how tall they start. */
export const NOTES_HEIGHT = { min: 64, max: 360, initial: 112 };
const clampNotesHeight = (height: number) => Math.round(Math.min(NOTES_HEIGHT.max, Math.max(NOTES_HEIGHT.min, height)));

/** How a toast reads: something went wrong, something to know, or something that worked. */
export type ToastKind = "error" | "info" | "success";

/** What a toast offers to do about what it says, as a button in it. */
export interface ToastAction {
  label: string;
  run: () => void;
}

/** A message shown over the window for a while (see `Toasts` in ../components/Toasts.tsx). */
export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  action?: ToastAction;
  /** The whole of what went wrong when `text` is only its gist (a service's raw answer, say), shown on request. */
  details?: string;
  /** Whether it is about the running slide show, and so shows during it; the others wait for its end. */
  duringShow?: boolean;
}

/** How many toasts show at once; a new one beyond that drops the oldest. */
export const MAX_TOASTS = 3;

let nextToastId = 1;

/** How the window is laid out around the slides, the show, and the toasts shown. */
export interface UiSlice {
  /**
   * The window knows what it starts with: a folder opened with the app (from Finder) is open, or
   * none was waiting. Until then it shows neither the start screen nor a folder (see ./events.ts).
   */
  booted: boolean;
  /** The right sidebar is shown; the user can collapse it to give the stage more room. */
  sidebarOpen: boolean;
  /** The sidebar's tabs, in the order they show (see `sidebarTabsFor`). */
  sidebarTabs: SidebarTab[];
  /** The sidebar tab shown: the one asked for, or the chat while that one is not there. */
  sidebarTab: SidebarTab;
  /**
   * The tab the user last went to, which shows whenever it is there: a deck's tab comes back
   * with the next deck. It is remembered across launches, unless it is an on-demand tab.
   */
  sidebarWanted: SidebarTab;
  /** The tab that shows again once the on-demand tab on show closes. */
  sidebarReturn: SidebarTab;
  /** The sidebar covers the whole window, over the slides, for room to work in (such as the SVG editor's). */
  sidebarMaximized: boolean;
  /** The slide rail is shown; the user can collapse it to give the stage more room. */
  railOpen: boolean;
  /** The stage shows each slide's final state, its animations done, as the slide list does, rather than playing them. */
  finalState: boolean;
  /** The deck's timeline is shown under the slide, in View and in Edit; folded away, the slide has the room. */
  timelineOpen: boolean;
  /** The speaker notes under the slide are open to read and write; folded, they are one line. */
  notesOpen: boolean;
  /** How tall the open speaker notes are, in pixels (see `NOTES_HEIGHT`). */
  notesHeight: number;
  presenting: boolean;
  /** Where the show goes: picked screens, or windows; null: full screen where it is. */
  screens: Placement | null;
  /** Where the show starts: on the selected slide, or on the deck's first. */
  presentFrom: ShowStart;
  /** What the app has to tell the user, oldest first; at most `MAX_TOASTS`. */
  toasts: Toast[];
  /** The shortcut help is open (see ../components/ShortcutHelp.tsx). */
  shortcutHelpOpen: boolean;
  /** The app's settings dialog is open (see ../components/AppSettings.tsx). */
  appSettingsOpen: boolean;
  /** The deck's settings dialog is open (see ../components/DeckSettings.tsx). */
  deckSettingsOpen: boolean;

  setSidebarOpen: (open: boolean) => void;
  /**
   * Shows the sidebar on `tab`, opening it first when it is an on-demand tab. A deck's tab asked
   * for without a deck shows once there is one; the chat shows until then.
   */
  setSidebarTab: (tab: SidebarTab) => void;
  /**
   * Takes the on-demand tab `tab` away; when it was showing, the tab shown before it shows
   * again. The other tabs are always there: closing one of them does nothing.
   */
  closeSidebarTab: (tab: SidebarTab) => void;
  setSidebarMaximized: (maximized: boolean) => void;
  setRailOpen: (open: boolean) => void;
  setFinalState: (finalState: boolean) => void;
  setTimelineOpen: (open: boolean) => void;
  setNotesOpen: (open: boolean) => void;
  /** Makes the open speaker notes `height` pixels tall, within `NOTES_HEIGHT`, and remembers it. */
  setNotesHeight: (height: number) => void;
  setPresenting: (presenting: boolean, screens?: Placement | null, from?: ShowStart) => void;
  /**
   * Shows a toast, after the others, and gives its id. Said again, a message moves to the end
   * rather than showing twice. The helpers in ./errors.ts are what the app calls.
   */
  showToast: (
    kind: ToastKind,
    text: string,
    action?: ToastAction,
    more?: Pick<Toast, "details" | "duringShow">,
  ) => number;
  dismissToast: (id: number) => void;
  setShortcutHelpOpen: (open: boolean) => void;
  /** Opens the app's settings, a dialog over the window, with or without a folder open. Not during a show. */
  openAppSettings: () => void;
  closeAppSettings: () => void;
  /** Opens the open deck's settings, a dialog over the window: the slide and its mode stay. Not during a show. */
  openDeckSettings: () => void;
  closeDeckSettings: () => void;
}

/**
 * The tab the user last went to; the chat when nothing is saved, or what is saved is no tab any
 * more (speaker notes and the app's settings were tabs once) or was only open for the moment.
 */
function loadSidebarTab(): SidebarTab {
  const saved = loadText(SIDEBAR_TAB_KEY);
  return isSidebarTab(saved) && !isOnDemand(saved) ? saved : FALLBACK_TAB;
}

export const createUiSlice: Slice<UiSlice> = (set, get, app) => {
  /** Shows the tabs there are now, with the on-demand ones `opened`, on `wanted` if it is among them. */
  const showTabs = (wanted: SidebarTab, opened: readonly SidebarTab[]) => {
    const sidebarTabs = sidebarTabsFor(get().deck !== null, opened);
    set({ sidebarTabs, sidebarWanted: wanted, sidebarTab: sidebarTabs.includes(wanted) ? wanted : FALLBACK_TAB });
  };
  const openedTabs = () => get().sidebarTabs.filter(isOnDemand);
  // The deck's tabs come and go with the deck.
  app.subscribe((state, before) => {
    if ((state.deck === null) !== (before.deck === null)) showTabs(state.sidebarWanted, openedTabs());
  });
  const wanted = loadSidebarTab();
  const tabs = sidebarTabsFor(false, []);

  return {
    booted: false,
    sidebarOpen: loadFlag(SIDEBAR_OPEN_KEY, true),
    sidebarTabs: tabs,
    sidebarTab: tabs.includes(wanted) ? wanted : FALLBACK_TAB,
    sidebarWanted: wanted,
    sidebarReturn: FALLBACK_TAB,
    sidebarMaximized: false,
    railOpen: loadFlag(RAIL_OPEN_KEY, true),
    finalState: loadFlag(FINAL_STATE_KEY, false),
    timelineOpen: loadFlag(TIMELINE_OPEN_KEY, false),
    notesOpen: loadFlag(NOTES_OPEN_KEY, false),
    notesHeight: loadJson(NOTES_HEIGHT_KEY, NOTES_HEIGHT.initial, (saved) =>
      typeof saved === "number" && Number.isFinite(saved) ? clampNotesHeight(saved) : NOTES_HEIGHT.initial,
    ),
    presenting: false,
    screens: null,
    presentFrom: "current",
    toasts: [],
    shortcutHelpOpen: false,
    appSettingsOpen: false,
    deckSettingsOpen: false,

    setSidebarOpen: (sidebarOpen) => {
      saveFlag(SIDEBAR_OPEN_KEY, sidebarOpen);
      // A closed sidebar does not cover the window either.
      set(sidebarOpen ? { sidebarOpen } : { sidebarOpen, sidebarMaximized: false });
    },

    setSidebarTab: (tab) => {
      const { sidebarWanted: before } = get();
      if (isOnDemand(tab)) {
        if (!isOnDemand(before)) set({ sidebarReturn: before });
        showTabs(tab, [...new Set([...openedTabs(), tab])]);
      } else {
        saveText(SIDEBAR_TAB_KEY, tab);
        showTabs(tab, openedTabs());
      }
      if (!get().sidebarOpen) get().setSidebarOpen(true);
    },

    closeSidebarTab: (tab) => {
      const { sidebarWanted, sidebarReturn, sidebarTabs } = get();
      if (!isOnDemand(tab) || !sidebarTabs.includes(tab)) return;
      showTabs(
        sidebarWanted === tab ? sidebarReturn : sidebarWanted,
        openedTabs().filter((open) => open !== tab),
      );
    },

    setSidebarMaximized: (sidebarMaximized) => {
      if (sidebarMaximized && !get().sidebarOpen) get().setSidebarOpen(true);
      set({ sidebarMaximized });
    },

    setRailOpen: (railOpen) => {
      saveFlag(RAIL_OPEN_KEY, railOpen);
      set({ railOpen });
    },

    setFinalState: (finalState) => {
      saveFlag(FINAL_STATE_KEY, finalState);
      set({ finalState });
    },

    setTimelineOpen: (timelineOpen) => {
      saveFlag(TIMELINE_OPEN_KEY, timelineOpen);
      set({ timelineOpen });
    },

    setNotesOpen: (notesOpen) => {
      saveFlag(NOTES_OPEN_KEY, notesOpen);
      set({ notesOpen });
    },

    setNotesHeight: (height) => {
      const notesHeight = clampNotesHeight(height);
      if (notesHeight === get().notesHeight) return;
      saveJson(NOTES_HEIGHT_KEY, notesHeight);
      set({ notesHeight });
    },

    setPresenting: (presenting, screens = null, from = "current") => set({ presenting, screens, presentFrom: from }),

    showToast: (kind, text, action, more) => {
      const toast: Toast = { id: nextToastId++, kind, text, ...(action && { action }), ...more };
      set((s) => ({
        toasts: [...s.toasts.filter((t) => t.kind !== kind || t.text !== text), toast].slice(-MAX_TOASTS),
      }));
      return toast.id;
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    setShortcutHelpOpen: (shortcutHelpOpen) => set({ shortcutHelpOpen }),

    openAppSettings: () => {
      if (!get().presenting) set({ appSettingsOpen: true });
    },

    closeAppSettings: () => set({ appSettingsOpen: false }),

    openDeckSettings: () => {
      if (get().deck && !get().presenting) set({ deckSettingsOpen: true });
    },

    closeDeckSettings: () => set({ deckSettingsOpen: false }),
  };
};
