import { AudioLines, Code2, Files, Maximize2, MessageSquare, Minimize2, Shapes, X } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { useRovingTabs } from "../hooks/useRovingTabs";
import { type TabLabels, tabLabels } from "../lib/sidebarTabs";
import { cn, isMac } from "../lib/utils";
import { type SidebarTab, useApp } from "../store";
import { hiddenChatAttention } from "../store/attention";
import { selectedSlideNarrated } from "../store/chrome";
import { useSvgEditor } from "../svgStore";
import { AttentionMark } from "./AttentionMark";
import { keepFocus, ToolButton } from "./Button";
import { ChatPanel } from "./ChatPanel";
import { FileTree } from "./FileTree";
import { CodePanel, SvgEditor } from "./lazy";
import { NarrationPanel } from "./NarrationPanel";
import { ShellButtons } from "./ShellButtons";
import { SidebarToggle } from "./TopBar";

export { ShellButtons } from "./ShellButtons";

interface TabKind {
  label: string;
  hint: string;
  icon: typeof Files;
  /** The tab's contents; `active` while it is the tab shown. */
  render: (active: boolean) => ReactNode;
  /**
   * Once shown, stays mounted (hidden) behind the other tabs, to keep what it holds, such as
   * unsaved edits. Until it first shows it is not mounted, nor its code loaded.
   */
  keepMounted?: boolean;
  /**
   * Closes the tab, for one that is only there while what it holds is open (see `ON_DEMAND_TABS`
   * in the store): it gets a close button, and a middle click closes it too.
   */
  close?: () => void;
}

/** What each sidebar tab shows. Add a tab here and to `SIDEBAR_TABS` in the store. */
const TABS: Record<SidebarTab, TabKind> = {
  chat: {
    label: "Chat",
    hint: "Talk to the agent about the deck",
    icon: MessageSquare,
    render: (active) => <ChatPanel active={active} />,
    keepMounted: true,
  },
  files: { label: "Files", hint: "The folders and files of the open folder", icon: Files, render: () => <FileTree /> },
  narration: {
    label: "Narration",
    hint: "What is said over the selected slide, and the voice that says it",
    icon: AudioLines,
    render: () => <NarrationPanel />,
  },
  code: {
    label: "Code",
    hint: "The deck's HTML and CSS, at the selected slide",
    icon: Code2,
    render: (active) => <CodePanel active={active} />,
    keepMounted: true,
  },
  svg: {
    label: "Drawing",
    hint: "The drawing being edited, from a slide",
    icon: Shapes,
    render: () => <SvgEditor />,
    close: () => void useSvgEditor.getState().close(),
  },
};

/**
 * The right sidebar, from the top of the window to the bottom: a tab for each of its panels (the
 * chat and the files always, the deck's narration and code while a deck is open, a drawing while
 * it is being edited), the maximize and hide buttons at its top right, and the app's settings and
 * the keyboard shortcuts at its bottom left. Maximized, it covers the whole window.
 */
export function Sidebar() {
  const tabs = useApp((s) => s.sidebarTabs);
  const active = useApp((s) => s.sidebarTab);
  const maximized = useApp((s) => s.sidebarMaximized);
  const mounted = useMountedTabs(tabs, active);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        data-tauri-drag-region
        className={cn(
          "relative z-dropdown flex h-14 shrink-0 items-center gap-1 border-b px-2",
          // Over the whole window, it starts where the top bar does, clear of the window's buttons.
          maximized && isMac && "pl-[84px]",
        )}
      >
        <TabStrip tabs={tabs} active={active} />
        <ToolButton
          variant="panel"
          size="md"
          label={maximized ? "Restore the sidebar" : "Maximize the sidebar over the slides"}
          active={maximized}
          onClick={() => useApp.getState().setSidebarMaximized(!maximized)}
        >
          {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
        </ToolButton>
        <SidebarToggle />
      </div>
      <div role="tabpanel" aria-label={TABS[active].label} className="min-h-0 flex-1">
        {mounted.map((id) => (
          <div key={id} className={cn("h-full", id !== active && "hidden")}>
            {TABS[id].render(id === active)}
          </div>
        ))}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-t px-2">
        <ShellButtons />
      </div>
    </div>
  );
}

/**
 * The tabs to render, in their order: the one showing, and those that stay mounted behind it
 * once they have shown (see `TabKind.keepMounted`).
 */
function useMountedTabs(tabs: SidebarTab[], active: SidebarTab): SidebarTab[] {
  const [kept, setKept] = useState<SidebarTab[]>([]);
  const mounted = tabs.filter((id) => id === active || kept.includes(id));
  const keep = mounted.filter((id) => TABS[id].keepMounted);
  // Adjusted while rendering, so a tab is kept from the render that first shows it.
  if (keep.length !== kept.length || keep.some((id, i) => id !== kept[i])) setKept(keep);
  return mounted;
}

/** The room between two tabs, in pixels (`gap-1`). */
const TAB_GAP = 4;
/** The room kept for the marks on the tabs, in pixels. */
const MARK_ROOM = 16;

/**
 * Which tabs show their name, for the room the strip has: a copy of the tabs, out of sight and
 * with every name, says how wide they would be (see `tabLabels`). Measured again whenever the
 * strip or a tab changes size: the sidebar is dragged, a tab comes or goes, a mark shows.
 */
function useTabLabels(tabs: SidebarTab[], active: SidebarTab) {
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [labels, setLabels] = useState<TabLabels>("all");

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const measure = measureRef.current;
    if (!strip || !measure) return;
    const measureTabs = () => {
      const copies = Array.from(measure.children) as HTMLElement[];
      // The last copy is a tab without its name.
      const icon = copies.pop()?.offsetWidth ?? 0;
      const full = copies.map((copy) => copy.offsetWidth);
      // The marks a tab may show (unsaved edits, the agent at work) are not in the copies.
      const available = strip.clientWidth > 0 ? Math.max(1, strip.clientWidth - MARK_ROOM) : 0;
      setLabels(tabLabels(full, icon, TAB_GAP, tabs.indexOf(active), available));
    };
    measureTabs();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureTabs);
    observer.observe(strip);
    for (const copy of measure.children) observer.observe(copy);
    return () => observer.disconnect();
  }, [tabs, active]);

  return { stripRef, measureRef, labels };
}

/**
 * The sidebar's tabs, in the room left of the sidebar's buttons. They never scroll or clip: when
 * their names do not all fit, only the tab showing keeps its name and the others show their
 * icon, with the name in a tooltip; in a very narrow sidebar all of them do.
 */
function TabStrip({ tabs, active }: { tabs: SidebarTab[]; active: SidebarTab }) {
  const roving = useRovingTabs();
  const { stripRef, measureRef, labels } = useTabLabels(tabs, active);
  const named = (id: SidebarTab) => labels === "all" || (labels === "active" && id === active);
  return (
    <div ref={stripRef} data-tauri-drag-region data-labels={labels} className="relative flex min-w-0 flex-1">
      <div
        ref={roving.ref}
        role="tablist"
        aria-label="Sidebar"
        onKeyDown={roving.onKeyDown}
        className="flex min-w-0 items-center gap-1"
      >
        {tabs.map((id) => (
          <Tab key={id} id={id} active={id === active} named={named(id)} />
        ))}
      </div>
      {/* The tabs with every name, and one without, only to be measured. */}
      <div
        ref={measureRef}
        data-testid="tab-sizes"
        aria-hidden
        inert
        className="pointer-events-none invisible absolute top-0 left-0 flex text-xs font-medium"
      >
        {tabs.map((id) => (
          <TabFace key={id} id={id} named />
        ))}
        <TabFace id="chat" named={false} />
      </div>
    </div>
  );
}

/** What a tab shows: its icon, its name when there is room for it, and its close button if it has one. */
function TabFace({ id, named, children }: { id: SidebarTab; named: boolean; children?: ReactNode }) {
  const { label, icon: Icon, close } = TABS[id];
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 py-1.5", named ? "px-2" : "px-1.5", close && "pr-6")}>
      <Icon className="size-4 shrink-0" />
      {named && label}
      {children}
    </span>
  );
}

/**
 * One tab: its icon and, with room for it, its name. A tab that is only there while what it
 * holds is open has a close button on its trailing edge, and a middle click closes it too.
 */
function Tab({ id, active, named }: { id: SidebarTab; active: boolean; named: boolean }) {
  const { label, hint, close } = TABS[id];
  // A dot on the tab: the code has unsaved edits, or the selected slide has narration.
  const mark = useApp((s) => {
    if (id === "code") return s.codeDirty ? "Unsaved changes" : null;
    return id === "narration" && selectedSlideNarrated(s) ? "This slide has narration" : null;
  });
  // On the chat's tab while another one shows: the agent works, or waits for an approval.
  const attention = useApp((s) => (id === "chat" ? hiddenChatAttention(s) : null));
  return (
    <div
      className={cn(
        "relative flex shrink-0 items-center rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        aria-label={label}
        title={named ? hint : `${label}: ${hint}`}
        // A press leaves the focus where it is (in the slide, say), as its keys go on working there.
        // (The middle button would start scrolling otherwise; here it closes an on-demand tab.)
        onMouseDown={keepFocus}
        onClick={() => useApp.getState().setSidebarTab(id)}
        onAuxClick={(event) => {
          if (event.button !== 1 || !close) return;
          event.preventDefault();
          close();
        }}
        className="rounded-md"
      >
        <TabFace id={id} named={named}>
          {mark && (
            <span data-testid={`${id}-mark`} title={mark} aria-hidden className="size-1.5 rounded-full bg-primary" />
          )}
          {attention && <AttentionMark attention={attention} />}
        </TabFace>
      </button>
      {close && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          onClick={close}
          className="absolute right-1 flex size-4.5 items-center justify-center rounded-sm hover:bg-foreground/10"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
