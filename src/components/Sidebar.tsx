import { Files, Maximize2, MessageSquare, Minimize2, Plus, Settings, Shapes, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { cn, isMac } from "../lib/utils";
import { SIDEBAR_TABS, type SidebarTab, useApp } from "../store";
import { useSvgEditor } from "../svgStore";
import { ToolButton } from "./Button";
import { ChatPanel } from "./ChatPanel";
import { FileTree } from "./FileTree";
import { useDismiss } from "./Popover";
import { SettingsPanel } from "./SettingsPanel";
import { SvgEditor } from "./SvgEditor";
import { SidebarToggle } from "./TopBar";

interface TabKind {
  label: string;
  hint: string;
  icon: typeof Files;
  render: () => ReactNode;
  /** Closes the tab, when that takes more than closing it (such as asking about unsaved changes). */
  close?: () => void;
}

/** What each sidebar tab shows. Add a tab here and to `SIDEBAR_TABS` in the store. */
const TABS: Record<SidebarTab, TabKind> = {
  chat: { label: "Chat", hint: "Talk to the agent about the deck", icon: MessageSquare, render: () => <ChatPanel /> },
  files: { label: "Files", hint: "The workspace's folders and files", icon: Files, render: () => <FileTree /> },
  svg: {
    label: "SVG",
    hint: "Edit a drawing from a slide",
    icon: Shapes,
    render: () => <SvgEditor />,
    close: () => void useSvgEditor.getState().close(),
  },
  settings: { label: "Settings", hint: "How the app behaves", icon: Settings, render: () => <SettingsPanel /> },
};

/**
 * The right sidebar, from the top of the window to the bottom: a tab for each surface open in it
 * (the chat, the workspace's files, the settings, …), each closable, and a `+` to open another;
 * the maximize and hide buttons at its top right, the settings button at its bottom left. Maximized, it covers the whole window.
 */
export function Sidebar() {
  const tabs = useApp((s) => s.sidebarTabs);
  const active = useApp((s) => s.sidebarTab);
  const maximized = useApp((s) => s.sidebarMaximized);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div
        data-tauri-drag-region
        className={cn(
          "relative z-30 flex h-14 shrink-0 items-center gap-1 border-b px-2",
          // Over the whole window, it starts where the top bar does, clear of the window's buttons.
          maximized && isMac && "pl-[84px]",
        )}
      >
        <div role="tablist" aria-label="Sidebar" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {tabs.map((id) => (
            <Tab key={id} id={id} active={id === active} />
          ))}
        </div>
        <OpenTabMenu open={tabs} />
        <div data-tauri-drag-region className="flex-1" />
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
      <div role="tabpanel" className="min-h-0 flex-1">
        {active ? TABS[active].render() : <NoTabs />}
      </div>
      <div className="flex h-10 shrink-0 items-center border-t px-2">
        <ToolButton
          variant="panel"
          size="md"
          label="Settings"
          active={active === "settings"}
          onClick={() => useApp.getState().setSidebarTab("settings")}
        >
          <Settings className="size-4" />
        </ToolButton>
      </div>
    </div>
  );
}

/** One open tab. Hovering (or focusing) it puts its close button where its icon is. */
function Tab({ id, active }: { id: SidebarTab; active: boolean }) {
  const { label, icon: Icon, close } = TABS[id];
  return (
    <div
      className={cn(
        "group relative flex shrink-0 items-center rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => useApp.getState().setSidebarTab(id)}
        className="flex items-center gap-1.5 py-1 pl-2 pr-2.5"
      >
        <Icon className="size-3.5 group-focus-within:invisible group-hover:invisible" />
        {label}
      </button>
      <button
        type="button"
        aria-label={`Close ${label}`}
        title={`Close ${label}`}
        onClick={() => (close ? close() : useApp.getState().closeSidebarTab(id))}
        className="invisible absolute left-1.5 flex size-4.5 items-center justify-center rounded-sm hover:bg-foreground/10 group-focus-within:visible group-hover:visible"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** `+`: a menu of the surfaces not open in a tab yet. */
function OpenTabMenu({ open: openTabs }: { open: SidebarTab[] }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(open, menuRef, () => setOpen(false), { escape: true });
  const closed = SIDEBAR_TABS.filter((id) => !openTabs.includes(id));
  return (
    <div ref={menuRef} className="relative shrink-0">
      <ToolButton
        variant="panel"
        size="md"
        label="Open a tab"
        title={closed.length ? "Open a tab" : "Every tab is open"}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!closed.length}
        onClick={() => setOpen((v) => !v)}
      >
        <Plus className="size-4" />
      </ToolButton>
      {open && closed.length > 0 && (
        <div role="menu" className="absolute left-0 top-full z-20 mt-1 w-40 rounded-lg border bg-card p-1 shadow-lg">
          {closed.map((id) => {
            const { label, hint, icon: Icon } = TABS[id];
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                title={hint}
                onClick={() => {
                  setOpen(false);
                  useApp.getState().setSidebarTab(id);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium hover:bg-accent"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Every tab is closed: what can open in one. */
function NoTabs() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6">
      <h2 className="text-sm font-medium">Open a tab</h2>
      <div className="flex w-full max-w-56 flex-col gap-0.5">
        {SIDEBAR_TABS.map((id) => {
          const { label, icon: Icon } = TABS[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => useApp.getState().setSidebarTab(id)}
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <Icon className="size-4 text-muted-foreground" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
