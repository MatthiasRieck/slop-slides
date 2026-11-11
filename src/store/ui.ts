import type { Placement } from "../lib/screens";
import { loadFlag, loadJson, loadText, saveFlag, saveJson, saveText } from "../lib/storage";
import type { Slice } from "./types";

/** What the right sidebar can show, each in a tab of its own, in menu order (see components/Sidebar.tsx). */
export const SIDEBAR_TABS = ["chat", "files", "narration", "notes", "code", "svg", "settings"] as const;
export type SidebarTab = (typeof SIDEBAR_TABS)[number];
const isSidebarTab = (value: unknown): value is SidebarTab => SIDEBAR_TABS.includes(value as SidebarTab);
/** The tabs a first start opens. */
const DEFAULT_SIDEBAR_TABS: SidebarTab[] = ["chat", "files"];

const SIDEBAR_OPEN_KEY = "slopslide.sidebarOpen";
const SIDEBAR_TAB_KEY = "slopslide.sidebarTab";
const SIDEBAR_TABS_KEY = "slopslide.sidebarTabs";
const RAIL_OPEN_KEY = "slopslide.railOpen";
const FINAL_STATE_KEY = "slopslide.finalState";
const TIMELINE_OPEN_KEY = "slopslide.timelineOpen";

/** How the window is laid out around the slides, the show, and the error shown. */
export interface UiSlice {
  /** The right sidebar is shown; the user can collapse it to give the stage more room. */
  sidebarOpen: boolean;
  /** The sidebar's open tabs, in the order they show; each kind at most once. */
  sidebarTabs: SidebarTab[];
  /** The sidebar tab shown; null once every tab is closed. */
  sidebarTab: SidebarTab | null;
  /** The sidebar covers the whole window, over the slides, for room to work in (such as the SVG editor's). */
  sidebarMaximized: boolean;
  /** The slide rail is shown; the user can collapse it to give the stage more room. */
  railOpen: boolean;
  /** The stage shows each slide's final state, its animations done, as the slide list does, rather than playing them. */
  finalState: boolean;
  /** The deck's timeline is shown under the slide, in View and in Edit; folded away, the slide has the room. */
  timelineOpen: boolean;
  presenting: boolean;
  /** Where the show goes: picked screens, or windows; null: full screen where it is. */
  screens: Placement | null;
  error: string | null;

  setSidebarOpen: (open: boolean) => void;
  /** Shows the sidebar on `tab`, opening that tab (after the others) if it is closed. */
  setSidebarTab: (tab: SidebarTab) => void;
  /** Closes the sidebar tab `tab`; when it was showing, the tab beside it shows instead. Closing the last one collapses the sidebar. */
  closeSidebarTab: (tab: SidebarTab) => void;
  setSidebarMaximized: (maximized: boolean) => void;
  setRailOpen: (open: boolean) => void;
  setFinalState: (finalState: boolean) => void;
  setTimelineOpen: (open: boolean) => void;
  setPresenting: (presenting: boolean, screens?: Placement | null) => void;
  setError: (error: string | null) => void;
}

/** The sidebar's tabs as last left; anything saved that is not a tab is dropped. */
function loadSidebarTabs(): { sidebarTabs: SidebarTab[]; sidebarTab: SidebarTab | null } {
  const sidebarTabs = loadJson(SIDEBAR_TABS_KEY, DEFAULT_SIDEBAR_TABS, (saved) =>
    Array.isArray(saved) ? [...new Set(saved.filter(isSidebarTab))] : DEFAULT_SIDEBAR_TABS,
  );
  const active = loadText(SIDEBAR_TAB_KEY);
  const sidebarTab = isSidebarTab(active) && sidebarTabs.includes(active) ? active : (sidebarTabs[0] ?? null);
  return { sidebarTabs, sidebarTab };
}

function saveSidebarTabs(tabs: SidebarTab[], active: SidebarTab | null) {
  saveJson(SIDEBAR_TABS_KEY, tabs);
  saveText(SIDEBAR_TAB_KEY, active);
}

export const createUiSlice: Slice<UiSlice> = (set, get) => ({
  sidebarOpen: loadFlag(SIDEBAR_OPEN_KEY, true),
  ...loadSidebarTabs(),
  sidebarMaximized: false,
  railOpen: loadFlag(RAIL_OPEN_KEY, true),
  finalState: loadFlag(FINAL_STATE_KEY, false),
  timelineOpen: loadFlag(TIMELINE_OPEN_KEY, false),
  presenting: false,
  screens: null,
  error: null,

  setSidebarOpen: (sidebarOpen) => {
    // Opening it with every tab closed brings back the chat, rather than an empty panel.
    if (sidebarOpen && get().sidebarTab === null) return get().setSidebarTab("chat");
    saveFlag(SIDEBAR_OPEN_KEY, sidebarOpen);
    // A closed sidebar does not cover the window either.
    set(sidebarOpen ? { sidebarOpen } : { sidebarOpen, sidebarMaximized: false });
  },

  setSidebarTab: (sidebarTab) => {
    const open = get().sidebarTabs;
    const sidebarTabs = open.includes(sidebarTab) ? open : [...open, sidebarTab];
    saveSidebarTabs(sidebarTabs, sidebarTab);
    set({ sidebarTabs, sidebarTab });
    if (!get().sidebarOpen) get().setSidebarOpen(true);
  },

  closeSidebarTab: (tab) => {
    const { sidebarTabs: open, sidebarTab: active } = get();
    const at = open.indexOf(tab);
    if (at < 0) return;
    const sidebarTabs = open.filter((t) => t !== tab);
    const sidebarTab = active === tab ? (sidebarTabs[Math.min(at, sidebarTabs.length - 1)] ?? null) : active;
    saveSidebarTabs(sidebarTabs, sidebarTab);
    set({ sidebarTabs, sidebarTab });
    // With nothing left to show, the sidebar folds away, leaving the room to the slides.
    if (sidebarTabs.length === 0) get().setSidebarOpen(false);
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

  setPresenting: (presenting, screens = null) => set({ presenting, screens }),

  setError: (error) => set({ error }),
});
