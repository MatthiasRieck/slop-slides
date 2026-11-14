import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import {
  Group,
  Panel,
  type PanelImperativeHandle,
  type PanelSize,
  Separator,
  usePanelRef,
} from "react-resizable-panels";
import { usePalette } from "./commands/palette";
import { AppSettings } from "./components/AppSettings";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { useChatShortcut } from "./components/chat/useChatShortcut";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PptxImport } from "./components/export/PptxImport";
import { FileViewer } from "./components/FileViewer";
import { Home } from "./components/Home";
import {
  ChangesRail,
  ChangesView,
  CommandPalette,
  DeckSettings,
  NarrationTimeline,
  Presenter,
  preloadLazyPartsWhenIdle,
  RewindDialog,
} from "./components/lazy";
import { usePresentKeys } from "./components/presenter/present";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { StageOrOverview } from "./components/SlideOverview";
import { SlideRail } from "./components/SlideRail";
import { TOAST_AREA, Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { UnsavedChanges } from "./components/UnsavedChanges";
import { useCommandMenu } from "./hooks/useCommandMenu";
import { useShellKeys } from "./hooks/useShellKeys";
import { useCloseGuard, useWindowTitle } from "./hooks/useWindowShell";
import { api } from "./lib/api";
import { loadSize, trySaveSize } from "./lib/storage";
import { cn, isMac } from "./lib/utils";
import { deckMode, lintKey, showError, useApp } from "./store";

/**
 * The window: the start screen until a folder is open, then the workbench. Neither shows before
 * the window knows whether a folder waits for it (see `booted`), so the start screen does not
 * flash by on the way to that folder. What is not on the first screen loads once the browser is
 * idle (see ./components/lazy.tsx).
 */
export function App() {
  const hasWorkspace = useApp((s) => s.workspace !== null);
  const booted = useApp((s) => s.booted);
  const presenting = useApp((s) => s.presenting);
  const askingRewind = useApp((s) => s.rewindAsk !== null);
  const deckSettingsOpen = useApp((s) => s.deckSettingsOpen);
  const paletteOpen = usePalette((s) => s.open);
  useNewWindowKey();
  usePresentKeys();
  useCommandMenu();
  useCloseGuard();
  useWindowTitle();
  useEffect(() => preloadLazyPartsWhenIdle(), []);

  return (
    <>
      {/* A render error anywhere leaves a way on, not an empty window; the parts of the workbench catch their own first. */}
      <ErrorBoundary name="the window" scope="window">
        {hasWorkspace ? <Workbench /> : booted && <Home />}
        {presenting && <Presenter />}
        <PptxImport />
        {askingRewind && <RewindDialog />}
        {deckSettingsOpen && <DeckSettings />}
        <UnsavedChanges />
        <ConfirmDialog />
      </ErrorBoundary>
      <AppSettings />
      {/* The keyboard shortcuts, on the start screen too: `?` or a button opens them. */}
      <ShortcutHelp />
      {paletteOpen && <CommandPalette />}
      <Toasts />
    </>
  );
}

/** Ctrl+N opens another window; on macOS, ⌘N is File › New Window in the menu bar. */
export function useNewWindowKey() {
  useEffect(() => {
    if (isMac) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      api.newWindow().catch((error) => showError(error, { doing: "Could not open a new window" }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The widest the right sidebar goes: two thirds of the window. */
export const SIDEBAR_MAX_SIZE = "67%";

/** How wide the slide list and the sidebar are, in pixels: as they start, and the least and most the list goes. */
export const RAIL_WIDTH = { initial: 220, min: 150, max: 360 };
export const SIDEBAR_WIDTH = { initial: 380, min: 260 };

/** Where the widths the user gave the two panels are remembered, for the next launch. */
export const RAIL_WIDTH_KEY = "slopslide.railWidth";
export const SIDEBAR_WIDTH_KEY = "slopslide.sidebarWidth";

/** How long a panel's width has to rest before it is remembered: a drag reports every pixel. */
export const WIDTH_SAVE_MS = 300;

/**
 * An open workspace: the top bar over the open file (a deck in the slide editor, with its slide
 * rail, or another page as it is), and on the right the sidebar with the chat, the files, the
 * slide's narration and notes, the deck's HTML and the settings, from the top of the window to
 * the bottom, so the top bar ends where it starts.
 * Maximized, the sidebar covers the whole window, the rest staying as it is underneath.
 */
function Workbench() {
  useChatShortcut();
  const hasDeck = useApp((s) => s.deck !== null);
  const mode = useApp(deckMode);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const sidebarMaximized = useApp((s) => s.sidebarMaximized);
  const railOpen = useApp((s) => s.railOpen);
  const timelineOpen = useApp((s) => s.timelineOpen);
  const rail = usePanelRef();
  const sidebar = usePanelRef();
  useShellKeys();
  // Re-lint whenever the deck file changes on disk (agent, HTML view, slide operations).
  const deckVersion = useApp((s) => lintKey(s.deck));
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-lint whenever the deck's content changes
  useEffect(() => {
    useApp.getState().lintChanged();
  }, [deckVersion]);
  return (
    <Group orientation="horizontal" className="h-full">
      <Panel id="main" minSize={480}>
        <div className="flex h-full flex-col">
          <ErrorBoundary name="the top bar">
            <TopBar />
          </ErrorBoundary>
          <Group orientation="horizontal" className="min-h-0 flex-1">
            {hasDeck && (
              <>
                <SidePanel
                  id="rail"
                  panelRef={rail}
                  open={railOpen}
                  onOpenChange={useApp.getState().setRailOpen}
                  widthKey={RAIL_WIDTH_KEY}
                  defaultSize={RAIL_WIDTH.initial}
                  minSize={RAIL_WIDTH.min}
                  maxSize={RAIL_WIDTH.max}
                >
                  <ErrorBoundary name="the slide list">
                    {/* The slide list stays mounted so its thumbnails do not load all over again. */}
                    <div className={cn("h-full", mode === "git" && "hidden")}>
                      <SlideRail />
                    </div>
                    {mode === "git" && <ChangesRail />}
                  </ErrorBoundary>
                </SidePanel>
                <ResizeHandle panel={rail} width={RAIL_WIDTH.initial} />
              </>
            )}
            <Panel id="stage" minSize={360}>
              <ErrorBoundary name="the slide">
                {hasDeck ? (
                  <div className="flex h-full flex-col">
                    {/* The toasts sit at the bottom of this, over the slide and clear of the sidebar. */}
                    <div {...{ [TOAST_AREA]: "" }} className="min-h-0 flex-1">
                      {mode === "git" ? <ChangesView /> : <StageOrOverview />}
                    </div>
                    {/* The deck's timeline under the slide, while it is open, whatever the sidebar shows. */}
                    {timelineOpen && (mode === "view" || mode === "edit") && <NarrationTimeline />}
                  </div>
                ) : (
                  <div {...{ [TOAST_AREA]: "" }} className="h-full">
                    <FileViewer />
                  </div>
                )}
              </ErrorBoundary>
            </Panel>
          </Group>
        </div>
      </Panel>
      <ResizeHandle panel={sidebar} width={SIDEBAR_WIDTH.initial} />
      <SidePanel
        id="sidebar"
        panelRef={sidebar}
        open={sidebarOpen}
        onOpenChange={useApp.getState().setSidebarOpen}
        widthKey={SIDEBAR_WIDTH_KEY}
        defaultSize={SIDEBAR_WIDTH.initial}
        minSize={SIDEBAR_WIDTH.min}
        // Up to two thirds of the window, however wide it is, the slides keeping the rest.
        maxSize={SIDEBAR_MAX_SIZE}
      >
        {/* Fixed, it leaves the panel (and the layout) where it was, so restoring it is instant. */}
        <div data-testid="sidebar-body" className={sidebarMaximized ? "fixed inset-0 z-cover bg-background" : "h-full"}>
          <ErrorBoundary name="the sidebar">
            <Sidebar />
          </ErrorBoundary>
        </div>
      </SidePanel>
    </Group>
  );
}

/**
 * A panel beside the stage that collapses rather than unmounting when closed, so opening it
 * again is instant: the slide rail's thumbnails and the chat do not load all over again.
 * Dragging it shut (or open) updates `open` through `onOpenChange`. The width the user gives it
 * is remembered under `widthKey`, and is the width it has at the next launch.
 */
function SidePanel(props: {
  id: string;
  panelRef: RefObject<PanelImperativeHandle | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  widthKey: string;
  defaultSize: number;
  minSize: number;
  /** Pixels, or a string the panels library reads (such as "67%" of the window). */
  maxSize: number | string;
  children: ReactNode;
}) {
  const { id, panelRef: ref, open, onOpenChange, widthKey, defaultSize, minSize, maxSize, children } = props;
  // On mount `defaultSize` already matches `open`; after that, follow it.
  const mounted = useRef(false);
  /** The width it had when last open, to reopen at: at first the one remembered, if it still fits the window. */
  const lastWidth = useRef<number | null>(null);
  lastWidth.current ??= loadSize(widthKey, defaultSize, minSize, widestFor(maxSize));
  const saving = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(saving.current), []);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const panel = ref.current;
    try {
      if (!panel || panel.isCollapsed() !== open) return;
      if (open) panel.resize(lastWidth.current ?? defaultSize);
      else panel.collapse();
    } catch {
      // The group has not registered the panel yet (React re-running effects); its size follows `defaultSize`.
    }
  }, [open, ref, defaultSize]);
  const onResize = (size: PanelSize, _id: unknown, previous: PanelSize | undefined) => {
    if (size.inPixels > 0) lastWidth.current = size.inPixels;
    // The first report comes before layout; only a resize after it is the user's doing.
    if (!previous) return;
    if (size.inPixels > 0) {
      // Once the dragging rests, not at every pixel of it.
      clearTimeout(saving.current);
      saving.current = setTimeout(() => trySaveSize(widthKey, size.inPixels), WIDTH_SAVE_MS);
    }
    const shown = size.inPixels > 0;
    if (shown !== open) onOpenChange(shown);
  };
  return (
    <Panel
      id={id}
      panelRef={ref}
      collapsible
      collapsedSize={0}
      defaultSize={open ? lastWidth.current : 0}
      minSize={minSize}
      maxSize={maxSize}
      onResize={onResize}
      // Closed: out of the tab order and hidden from assistive tech, but still mounted.
      inert={!open}
      aria-hidden={!open}
    >
      {children}
    </Panel>
  );
}

/** The most pixels a panel's `maxSize` allows in this window: a number as it is, a percentage of the window's width. */
function widestFor(maxSize: number | string): number {
  if (typeof maxSize === "number") return maxSize;
  const percent = Number.parseFloat(maxSize);
  return Number.isFinite(percent) ? (window.innerWidth * percent) / 100 : window.innerWidth;
}

/**
 * The line between two panels, dragged to resize them. Double-clicked, it gives `panel` (the
 * panel beside it that has a width of its own) its `width` back.
 */
function ResizeHandle({ panel, width }: { panel: RefObject<PanelImperativeHandle | null>; width: number }) {
  const reset = () => {
    try {
      if (panel.current && !panel.current.isCollapsed()) panel.current.resize(width);
    } catch {
      // The panel is not laid out yet: there is nothing to reset.
    }
  };
  return (
    <Separator
      onDoubleClick={reset}
      className="relative w-px bg-border outline-none transition-colors after:absolute after:inset-y-0 after:-left-1 after:-right-1 data-[separator=active]:bg-primary data-[separator=hover]:bg-primary/50"
    />
  );
}
