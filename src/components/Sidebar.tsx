import { Files, MessageSquare, Plus, Settings, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { SIDEBAR_TABS, type SidebarTab, useApp } from "../store";
import { ToolButton } from "./Button";
import { ChatPanel } from "./ChatPanel";
import { MenuItem } from "./DeckActions";
import { FileTree } from "./FileTree";
import { useDismiss } from "./Popover";
import { SettingsPanel } from "./SettingsPanel";

/** What each sidebar tab shows. Add a tab here and to `SIDEBAR_TABS` in the store. */
const TABS: Record<SidebarTab, { label: string; hint: string; icon: typeof Files; render: () => ReactNode }> = {
  chat: { label: "Chat", hint: "Talk to the agent about the deck", icon: MessageSquare, render: () => <ChatPanel /> },
  files: { label: "Files", hint: "The workspace's folders and files", icon: Files, render: () => <FileTree /> },
  settings: { label: "Settings", hint: "How the app behaves", icon: Settings, render: () => <SettingsPanel /> },
};

/**
 * The right sidebar, from the top of the window to the bottom: a tab for each surface open in it
 * (the chat, the workspace's files, the settings, …), each closable, and a `+` to open another;
 * the settings button sits at its bottom left.
 */
export function Sidebar() {
  const tabs = useApp((s) => s.sidebarTabs);
  const active = useApp((s) => s.sidebarTab);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div data-tauri-drag-region className="flex h-14 shrink-0 items-center gap-1 border-b px-2">
        <div role="tablist" aria-label="Sidebar" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {tabs.map((id) => (
            <Tab key={id} id={id} active={id === active} />
          ))}
        </div>
        <OpenTabMenu open={tabs} />
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
  const { label, icon: Icon } = TABS[id];
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
        onClick={() => useApp.getState().closeSidebarTab(id)}
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
        <div role="menu" className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border bg-card p-1 shadow-lg">
          {closed.map((id) => (
            <MenuItem
              key={id}
              icon={TABS[id].icon}
              label={TABS[id].label}
              hint={TABS[id].hint}
              onClick={() => {
                setOpen(false);
                useApp.getState().setSidebarTab(id);
              }}
            />
          ))}
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
