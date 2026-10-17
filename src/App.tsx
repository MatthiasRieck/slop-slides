import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Group, Panel, Separator, usePanelRef, type PanelSize } from "react-resizable-panels";

import { CodeView } from "./components/CodeView";
import { DeckToolbar } from "./components/DeckToolbar";
import { FileViewer } from "./components/FileViewer";
import { Home } from "./components/Home";
import { Presenter } from "./components/Presenter";
import { Sidebar } from "./components/Sidebar";
import { SlideImageExport } from "./components/SlideImageExport";
import { SlideRail } from "./components/SlideRail";
import { Stage } from "./components/Stage";
import { TopBar } from "./components/TopBar";
import { useApp } from "./store";

export function App() {
  const workspace = useApp((s) => s.workspace);
  const presenting = useApp((s) => s.presenting);

  return (
    <>
      {workspace ? <Workbench /> : <Home />}
      {presenting && <Presenter />}
      <SlideImageExport />
      <ErrorToast />
    </>
  );
}

/**
 * An open workspace: the open file in the middle (a deck in the slide editor, with its slide
 * rail, or another page as it is) and the sidebar with the chat and the files on the right.
 */
function Workbench() {
  const hasDeck = useApp((s) => s.deck !== null);
  const view = useApp((s) => s.view);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const railOpen = useApp((s) => s.railOpen);
  // Re-lint whenever the deck file changes on disk (agent, HTML view, slide operations).
  const deckVersion = useApp((s) =>
    s.deck ? [s.deck.id, s.deck.shellHash, ...s.deck.slides.map((x) => `${x.id}:${x.hash}`)].join("|") : "",
  );
  useEffect(() => {
    void useApp.getState().refreshLint();
  }, [deckVersion]);
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <Group orientation="horizontal" className="min-h-0 flex-1">
        {hasDeck && (
          <>
            <SidePanel id="rail" open={railOpen} onOpenChange={useApp.getState().setRailOpen} defaultSize={220} minSize={150} maxSize={360}>
              <SlideRail />
            </SidePanel>
            <ResizeHandle />
          </>
        )}
        <Panel id="stage" minSize={360}>
          {hasDeck ? (
            <div className="flex h-full flex-col">
              <DeckToolbar />
              <div className="min-h-0 flex-1">
                {/* The HTML view stays mounted so unsaved edits survive switching to the slides. */}
                <CodeView active={view === "code"} />
                {view === "slides" && <Stage />}
              </div>
            </div>
          ) : (
            <FileViewer />
          )}
        </Panel>
        <ResizeHandle />
        <SidePanel id="sidebar" open={sidebarOpen} onOpenChange={useApp.getState().setSidebarOpen} defaultSize={380} minSize={260} maxSize={640}>
          <Sidebar />
        </SidePanel>
      </Group>
    </div>
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
  maxSize: number;
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

function ErrorToast() {
  const error = useApp((s) => s.error);
  if (!error) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex max-w-lg -translate-x-1/2 items-start gap-2 rounded-lg border border-destructive/30 bg-card px-3 py-2 text-sm shadow-lg">
      <span className="selectable flex-1 text-destructive">{error}</span>
      <button
        type="button"
        onClick={() => useApp.getState().setError(null)}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
