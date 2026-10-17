import { Files, MessageSquare, Mic2, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/utils";
import { SIDEBAR_TABS, useApp, type SidebarTab } from "../store";
import { ChatPanel } from "./ChatPanel";
import { FileTree } from "./FileTree";
import { NarrationPanel } from "./NarrationPanel";
import { PresentationPresets } from "./PresentationPresets";

/** What each sidebar tab shows. Add a tab here and to `SIDEBAR_TABS` in the store. */
const TABS: Record<SidebarTab, { label: string; icon: typeof Files; render: () => ReactNode }> = {
  chat: { label: "Chat", icon: MessageSquare, render: () => <ChatPanel /> },
  narration: { label: "Narration", icon: Mic2, render: () => <NarrationPanel /> },
  presets: { label: "Presets", icon: SlidersHorizontal, render: () => <PresentationPresets /> },
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
