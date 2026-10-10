import { Files, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { SIDEBAR_TABS, useApp, type SidebarTab } from "../store";
import { ChatPanel } from "./ChatPanel";
import { FileTree } from "./FileTree";

/** What each sidebar tab shows. Add a tab here and to `SIDEBAR_TABS` in the store. */
const TABS: Record<SidebarTab, { label: string; icon: typeof Files; render: () => ReactNode }> = {
  chat: { label: "Chat", icon: MessageSquare, render: () => <ChatTab /> },
  files: { label: "Files", icon: Files, render: () => <FileTree /> },
};

/** The right sidebar: one tab at a time (the chat, the workspace's files, …). */
export function Sidebar() {
  const active = useApp((s) => s.sidebarTab);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div role="tablist" aria-label="Sidebar" className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        {SIDEBAR_TABS.map((id) => {
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

/** The chat is about the open deck; without one there is nothing to talk about yet. */
function ChatTab() {
  const hasDeck = useApp((s) => s.deck !== null);
  if (hasDeck) return <ChatPanel />;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <MessageSquare className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">No presentation open</p>
      <p className="text-xs text-muted-foreground">Open a deck from the Files tab, or create one, to chat about it.</p>
      <button
        type="button"
        onClick={() => useApp.getState().setSidebarTab("files")}
        className="mt-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent"
      >
        Show files
      </button>
    </div>
  );
}
