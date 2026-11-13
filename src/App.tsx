import { type ReactNode, useEffect, useRef } from "react";
import { Group, Panel, type PanelSize, Separator, usePanelRef } from "react-resizable-panels";

import { useChatShortcut } from "./components/chat/useChatShortcut";
import { FileViewer } from "./components/FileViewer";
import { Home } from "./components/Home";
import {
  ChangesRail,
  ChangesView,
  DeckSettings,
  NarrationTimeline,
  Presenter,
  preloadLazyPartsWhenIdle,
  RewindDialog,
  SlideImageExport,
} from "./components/lazy";
import { usePresentKeys } from "./components/presenter/present";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Sidebar } from "./components/Sidebar";
import { SlideRail } from "./components/SlideRail";
import { Stage } from "./components/Stage";
import { Toasts } from "./components/Toasts";
import { TopBar } from "./components/TopBar";
import { UnsavedChanges } from "./components/UnsavedChanges";
import { useShellKeys } from "./hooks/useShellKeys";
import { useCloseGuard, useWindowTitle } from "./hooks/useWindowShell";
import { api } from "./lib/api";
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
  const exportingImages = useApp((s) => s.imageExport !== null);
  const askingRewind = useApp((s) => s.rewindAsk !== null);
  useNewWindowKey();
  usePresentKeys();
  useCloseGuard();
  useWindowTitle();
  useEffect(() => preloadLazyPartsWhenIdle(), []);

  return (
    <>
      {hasWorkspace ? <Workbench /> : booted && <Home />}
      {presenting && <Presenter />}
      {exportingImages && <SlideImageExport />}
      {askingRewind && <RewindDialog />}
      <UnsavedChanges />
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
      api.newWindow().catch((error) => showError(error));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The widest the right sidebar goes: two thirds of the window. */
export const SIDEBAR_MAX_SIZE = "67%";

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
  useShellKeys();
  // Re-lint whenever the deck file changes on disk (agent, HTML view, slide operations).
  const deckVersion = useApp((s) => lintKey(s.deck));
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-lint whenever the deck's content changes
  useEffect(() => {
    useApp.getState().lintChanged();
  }, [deckVersion]);
  return (
    <>
      <Group orientation="horizontal" className="h-full">
        <Panel id="main" minSize={480}>
          <div className="flex h-full flex-col">
            <TopBar />
            <Group orientation="horizontal" className="min-h-0 flex-1">
              {hasDeck && (
                <>
                  <SidePanel
                    id="rail"
                    open={railOpen}
                    onOpenChange={useApp.getState().setRailOpen}
                    defaultSize={220}
                    minSize={150}
                    maxSize={360}
                  >
                    {/* The slide list stays mounted so its thumbnails do not load all over again. */}
                    <div className={cn("h-full", mode === "git" && "hidden")}>
                      <SlideRail />
                    </div>
                    {mode === "git" && <ChangesRail />}
                  </SidePanel>
                  <ResizeHandle />
                </>
              )}
              <Panel id="stage" minSize={360}>
                {hasDeck ? (
                  <div className="flex h-full flex-col">
                    <div className="min-h-0 flex-1">
                      {mode === "settings" ? <DeckSettings /> : mode === "git" ? <ChangesView /> : <Stage />}
                    </div>
                    {/* The deck's timeline under the slide, while it is open, whatever the sidebar shows. */}
                    {timelineOpen && (mode === "view" || mode === "edit") && <NarrationTimeline />}
                  </div>
                ) : (
                  <FileViewer />
                )}
              </Panel>
            </Group>
          </div>
        </Panel>
        <ResizeHandle />
        <SidePanel
          id="sidebar"
          open={sidebarOpen}
          onOpenChange={useApp.getState().setSidebarOpen}
          defaultSize={380}
          minSize={260}
          // Up to two thirds of the window, however wide it is, the slides keeping the rest.
          maxSize={SIDEBAR_MAX_SIZE}
        >
          {/* Fixed, it leaves the panel (and the layout) where it was, so restoring it is instant. */}
          <div data-testid="sidebar-body" className={sidebarMaximized ? "fixed inset-0 z-40 bg-background" : "h-full"}>
            <Sidebar />
          </div>
        </SidePanel>
      </Group>
      {/* The keyboard shortcuts, for the whole workbench: `?` or a button opens them. */}
      <ShortcutHelp />
    </>
  );
}

/**
 * A panel beside the stage that collapses rather than unmounting when closed, so opening it
 * again is instant: the slide rail's thumbnails and the chat do not load all over again.
 * Dragging it shut (or open) updates `open` through `onOpenChange`.
 */
function SidePanel(props: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSize: number;
  minSize: number;
  /** Pixels, or a string the panels library reads (such as "67%" of the window). */
  maxSize: number | string;
  children: ReactNode;
}) {
  const { id, open, onOpenChange, defaultSize, minSize, maxSize, children } = props;
  const ref = usePanelRef();
  // On mount `defaultSize` already matches `open`; after that, follow it.
  const mounted = useRef(false);
  /** The width it had when last open, to reopen at. */
  const lastWidth = useRef(defaultSize);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const panel = ref.current;
    try {
      if (!panel || panel.isCollapsed() !== open) return;
      if (open) panel.resize(lastWidth.current);
      else panel.collapse();
    } catch {
      // The group has not registered the panel yet (React re-running effects); its size follows `defaultSize`.
    }
  }, [open, ref]);
  const remember = (size: PanelSize) => {
    if (size.inPixels > 0) lastWidth.current = size.inPixels;
  };
  const onResize = (size: PanelSize, _id: unknown, previous: PanelSize | undefined) => {
    remember(size);
    // The first report comes before layout; only a resize after it is the user's doing.
    if (!previous) return;
    const shown = size.inPixels > 0;
    if (shown !== open) onOpenChange(shown);
  };
  return (
    <Panel
      id={id}
      panelRef={ref}
      collapsible
      collapsedSize={0}
      defaultSize={open ? defaultSize : 0}
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

function ResizeHandle() {
  return (
    <Separator className="relative w-px bg-border outline-none transition-colors after:absolute after:inset-y-0 after:-left-1 after:-right-1 data-[separator=active]:bg-primary data-[separator=hover]:bg-primary/50" />
  );
}
