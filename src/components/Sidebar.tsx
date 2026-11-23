import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Code2,
  Files,
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  Shapes,
  StickyNote,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { keepFocus } from "@/lib/focus";
import { scrollBehavior } from "../lib/motion";
import { cn, isMac } from "../lib/utils";
import { SIDEBAR_TABS, type SidebarTab, settleUnsavedEdits, useApp } from "../store";
import { hiddenChatAttention } from "../store/attention";
import { selectedSlideNarrated } from "../store/chrome";
import { useSvgEditor } from "../svgStore";
import { AttentionMark } from "./AttentionMark";
import { ChatPanel } from "./ChatPanel";
import { MenuItem } from "./DeckActions";
import { FileTree } from "./FileTree";
import { CodePanel, SvgEditor } from "./lazy";
import { NarrationPanel } from "./NarrationPanel";
import { NotesPanel } from "./NotesPanel";
import { SidebarToggle } from "./TopBar";

interface TabKind {
  label: string;
  hint: string;
  icon: typeof Files;
  /** The tab's contents; `active` while it is the tab shown. */
  render: (active: boolean) => ReactNode;
  /**
   * Once shown, stays mounted (hidden) behind the other tabs while open, to keep what it holds,
   * such as unsaved edits. Until it first shows it is not mounted, nor its code loaded.
   */
  keepMounted?: boolean;
  /** Closes the tab, when that takes more than closing it (such as asking about unsaved changes). */
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
  files: { label: "Files", hint: "The workspace's folders and files", icon: Files, render: () => <FileTree /> },
  narration: {
    label: "Narration",
    hint: "What is said over the selected slide, and the voice that says it",
    icon: AudioLines,
    render: () => <NarrationPanel />,
  },
  notes: {
    label: "Notes",
    hint: "Speaker notes for the selected slide; only the presenter sees them",
    icon: StickyNote,
    render: () => <NotesPanel />,
  },
  code: {
    label: "HTML",
    hint: "The deck file's source, scrolled to the selected slide",
    icon: Code2,
    render: (active) => <CodePanel active={active} />,
    keepMounted: true,
    close: () => void closeCodeTab(),
  },
  svg: {
    label: "SVG",
    hint: "Edit a drawing from a slide",
    icon: Shapes,
    render: () => <SvgEditor />,
    close: () => void useSvgEditor.getState().close(),
  },
};

/**
 * Closes the HTML tab. With edits not saved to the deck file, the user first saves them, gives
 * them up, or keeps the tab open.
 */
async function closeCodeTab() {
  if (useApp.getState().codeDirty && !(await settleUnsavedEdits())) return;
  useApp.getState().closeSidebarTab("code");
}

/**
 * The right sidebar, from the top of the window to the bottom: a tab for each surface open in it
 * (the chat, the workspace's files, the slide's narration and notes, the deck's HTML, …), each
 * closable, and a `+` to open another; the maximize and hide buttons at its top right. Maximized,
 * it covers the whole window.
 */
export function Sidebar() {
  const tabs = useApp((s) => s.sidebarTabs);
  const active = useApp((s) => s.sidebarTab);
  const maximized = useApp((s) => s.sidebarMaximized);
  const mounted = useMountedTabs(tabs, active);
  return (
    <Tabs
      value={active}
      onValueChange={(value) => useApp.getState().setSidebarTab(value as SidebarTab)}
      className="h-full min-h-0 gap-0 bg-background"
    >
      <div
        data-tauri-drag-region
        className={cn(
          "relative z-30 flex h-14 shrink-0 items-center gap-1 border-b px-2",
          // Over the whole window, it starts where the top bar does, clear of the window's buttons.
          maximized && isMac && "pl-[84px]",
        )}
      >
        <TabStrip tabs={tabs} active={active} />
        <div data-tauri-drag-region className="flex-1" />
        <Button
          variant="tool"
          size="icon-sm"
          tooltip={maximized ? "Restore the sidebar" : "Maximize the sidebar over the slides"}
          tooltipSide="bottom"
          aria-pressed={maximized}
          onClick={() => useApp.getState().setSidebarMaximized(!maximized)}
        >
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <SidebarToggle />
      </div>
      <div className="min-h-0 flex-1">
        {mounted.map((id) => (
          // Behind the tab that shows, those that stay mounted are hidden, not gone. The panel
          // is no stop of its own for Tab: what is in it is.
          <TabsContent key={id} value={id} keepMounted tabIndex={-1} className="h-full text-base">
            {TABS[id].render(id === active)}
          </TabsContent>
        ))}
        {!active && <NoTabs />}
      </div>
    </Tabs>
  );
}

/**
 * The open tabs to render, in their order: the one showing, and those that stay mounted behind
 * it once they have shown (see `TabKind.keepMounted`).
 */
function useMountedTabs(tabs: SidebarTab[], active: SidebarTab | null): SidebarTab[] {
  const [kept, setKept] = useState<SidebarTab[]>([]);
  const mounted = tabs.filter((id) => id === active || kept.includes(id));
  const keep = mounted.filter((id) => TABS[id].keepMounted);
  // Adjusted while rendering, so a tab is kept from the render that first shows it.
  if (keep.length !== kept.length || keep.some((id, i) => id !== kept[i])) setKept(keep);
  return mounted;
}

/** How far a tab strip can scroll each way, in pixels. */
interface Overflow {
  left: number;
  right: number;
}

/**
 * The open tabs, then `+`. The arrows go from tab to tab, Home and End to the ends; a click,
 * Enter or Space shows the tab. When they don't fit, the strip scrolls without a scrollbar: its
 * cut-off ends fade out, and ‹ › after the `+` scroll it a page at a time. The active tab scrolls
 * into view.
 */
function TabStrip({ tabs, active }: { tabs: SidebarTab[]; active: SidebarTab | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState<Overflow>({ left: 0, right: 0 });

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measures, and watches the new tabs, when tabs open or close
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const measure = () => {
      const left = Math.max(0, Math.round(strip.scrollLeft));
      const right = Math.max(0, Math.round(strip.scrollWidth - strip.clientWidth - strip.scrollLeft));
      setOverflow((o) => (o.left === left && o.right === right ? o : { left, right }));
    };
    measure();
    strip.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    for (const child of strip.children) observer.observe(child);
    return () => {
      strip.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [tabs]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: brings the active tab into view whenever it or the tabs change
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs]);

  const scroll = (direction: -1 | 1) => {
    const strip = ref.current;
    if (strip) strip.scrollBy({ left: direction * strip.clientWidth * 0.75, behavior: scrollBehavior() });
  };
  const fade = 24;
  const mask = `linear-gradient(to right, ${overflow.left ? "transparent" : "black"}, black ${overflow.left ? fade : 0}px, black calc(100% - ${overflow.right ? fade : 0}px), ${overflow.right ? "transparent" : "black"})`;
  const overflowing = overflow.left > 0 || overflow.right > 0;

  return (
    <>
      <TabsList
        ref={ref}
        aria-label="Sidebar"
        className="no-scrollbar w-auto min-w-0 justify-start gap-1 overflow-x-auto rounded-none bg-transparent p-0 group-data-horizontal/tabs:h-auto"
        data-fade={[overflow.left && "left", overflow.right && "right"].filter(Boolean).join(" ") || undefined}
        style={overflowing ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      >
        {tabs.map((id) => (
          <Tab key={id} id={id} active={id === active} />
        ))}
      </TabsList>
      <OpenTabMenu open={tabs} />
      {overflowing && (
        <div className="flex shrink-0 items-center">
          <Button
            variant="tool"
            size="icon-xs"
            aria-label="Scroll tabs left"
            disabled={!overflow.left}
            onClick={() => scroll(-1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="tool"
            size="icon-xs"
            aria-label="Scroll tabs right"
            disabled={!overflow.right}
            onClick={() => scroll(1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </>
  );
}

/**
 * One open tab: its icon and name, then its close button on the trailing edge, which shows on
 * the active tab and while the tab is hovered or holds the focus. A middle click closes it too.
 */
function Tab({ id, active }: { id: SidebarTab; active: boolean }) {
  const { label, icon: Icon, close } = TABS[id];
  // A dot on the tab: the HTML has unsaved edits, or the selected slide has narration.
  const mark = useApp((s) => {
    if (id === "code") return s.codeDirty ? "Unsaved changes" : null;
    return id === "narration" && selectedSlideNarrated(s) ? "This slide has narration" : null;
  });
  // On the chat's tab while another one shows: the agent works, or waits for an approval.
  const attention = useApp((s) => (id === "chat" ? hiddenChatAttention(s) : null));
  const closeTab = () => (close ? close() : useApp.getState().closeSidebarTab(id));
  return (
    <div
      className={cn(
        "group flex shrink-0 items-center rounded-md text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <TabsTrigger
        value={id}
        // A press leaves the focus where it is (in the slide, say), as its keys go on working there.
        // (The middle button would start scrolling otherwise; here it closes the tab.)
        onMouseDown={keepFocus}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          closeTab();
        }}
        className="h-auto flex-none gap-1.5 border-0 py-1 pr-1 pl-2 text-xs text-inherit data-active:bg-transparent data-active:text-inherit data-active:shadow-none dark:text-inherit dark:data-active:bg-transparent dark:data-active:text-inherit [&_svg:not([class*='size-'])]:size-3.5"
      >
        <Icon />
        {label}
        {mark && (
          <span data-testid={`${id}-mark`} title={mark} aria-hidden className="size-1.5 rounded-full bg-primary" />
        )}
        {attention && <AttentionMark attention={attention} />}
      </TabsTrigger>
      <Button
        variant="ghost"
        size="icon-2xs"
        tooltip={`Close ${label}`}
        tooltipSide="bottom"
        onClick={closeTab}
        className={cn(
          "mr-1 size-4.5 rounded-sm opacity-0 hover:bg-foreground/10 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [&_svg:not([class*='size-'])]:size-3.5",
          active && "opacity-100",
        )}
      >
        <X />
      </Button>
    </div>
  );
}

/** `+`: a menu of the surfaces not open in a tab yet. */
function OpenTabMenu({ open: openTabs }: { open: SidebarTab[] }) {
  const closed = SIDEBAR_TABS.filter((id) => !openTabs.includes(id));
  const none = closed.length === 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={none}
        render={
          <Button
            variant="tool"
            size="icon-sm"
            aria-label="Open a tab"
            disabled={none}
            tooltip={none ? "Every tab is open" : "Open a tab"}
            tooltipSide="bottom"
            className="shrink-0"
          />
        }
      >
        <Plus />
      </DropdownMenuTrigger>
      {/* Each surface with what it is for under its name, as the other menus of the shell say it. */}
      <DropdownMenuContent align="start" className="w-64">
        {closed.map((id) => (
          <MenuItem
            key={id}
            icon={TABS[id].icon}
            label={TABS[id].label}
            hint={TABS[id].hint}
            onClick={() => useApp.getState().setSidebarTab(id)}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Every tab is closed: what can open in one. */
function NoTabs() {
  return (
    <Empty className="h-full">
      <EmptyHeader>
        <EmptyTitle>
          <h2>Open a tab</h2>
        </EmptyTitle>
      </EmptyHeader>
      <EmptyContent className="max-w-56 items-stretch gap-0.5">
        {SIDEBAR_TABS.map((id) => {
          const { label, icon: Icon } = TABS[id];
          return (
            <Button
              key={id}
              variant="ghost"
              onClick={() => useApp.getState().setSidebarTab(id)}
              className="justify-start gap-2.5 px-2 font-normal"
            >
              <Icon className="text-muted-foreground" />
              {label}
            </Button>
          );
        })}
      </EmptyContent>
    </Empty>
  );
}
