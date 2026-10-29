import { AudioLines, Files, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { SIDEBAR_TABS, type SidebarTab, useApp } from "../store";
import { ChatPanel } from "./ChatPanel";
import { FileTree } from "./FileTree";
import { NarrationPanel } from "./NarrationPanel";

/** What each sidebar tab shows. Add a tab here and to `SIDEBAR_TABS` in the store. */
const TABS: Record<SidebarTab, { label: string; icon: typeof Files; render: () => ReactNode }> = {
  chat: { label: "Chat", icon: MessageSquare, render: () => <ChatPanel /> },
  narration: { label: "Narration", icon: AudioLines, render: () => <NarrationPanel /> },
  files: { label: "Files", icon: Files, render: () => <FileTree /> },
};

/** Tabs that only make sense with a deck open. */
const DECK_TABS: SidebarTab[] = ["narration"];

/** The right sidebar: one tab at a time (the chat, the workspace's files, …). */
export function Sidebar() {
  const hasDeck = useApp((s) => s.deck !== null);
  const tabs = SIDEBAR_TABS.filter((id) => hasDeck || !DECK_TABS.includes(id));
  const chosen = useApp((s) => s.sidebarTab);
  const active = tabs.includes(chosen) ? chosen : "chat";
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div role="tablist" aria-label="Sidebar" className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        {tabs.map((id) => {
          const { label, icon: Icon } = TABS[id];
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={id === active}
              onClick={() => useApp.getState().setSidebarTab(id)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
                id === active && "bg-accent text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="min-h-0 flex-1">
        {TABS[active].render()}
      </div>
    </div>
  );
}
