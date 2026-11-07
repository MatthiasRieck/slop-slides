import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  FolderOpen,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  Settings2,
  Undo2,
  X,
} from "lucide-react";
import { useRef, useState } from "react";

import type { HistoryEntry, OpenedFile } from "../lib/api";
import { basename, cn, isMac, revealLabel } from "../lib/utils";
import { useApp } from "../store";
import { ToolButton } from "./Button";
import { DeckActions, MenuItem } from "./DeckActions";
import { ModeTabs } from "./ModeTabs";
import { useDismiss } from "./Popover";

/**
 * The workspace's bar. On the left, the slide rail toggle (for a deck), the open file's path from
 * the workspace folder with the deck's title under it, which opens a menu to open the deck's
 * settings, close the file (back to the workspace) or reveal it in the file manager, then undo /
 * redo; for a deck, its mode tabs in the middle with the chat button after a separator, then export
 * and present; then the sidebar toggle while the sidebar is closed (open, it sits in the sidebar). The tools of each mode live above the slide (DeckToolbar,
 * Stage), and the lint status beside Tidy layout under it.
 */
export function TopBar() {
  const workspace = useApp((s) => s.workspace);
  const hasDeck = useApp((s) => s.deck !== null);
  const deckTitle = useApp((s) => s.deck?.title ?? null);
  const openedFile = useApp((s) => s.openedFile);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  if (!workspace) return null;

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "relative z-30 grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-3 border-b bg-background pr-3",
        isMac ? "pl-[84px]" : "pl-3",
      )}
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-1 self-stretch">
        {hasDeck && <RailToggle />}
        {openedFile ? (
          <FileMenu workspace={workspace.name} file={openedFile} deckTitle={deckTitle} />
        ) : (
          <Breadcrumbs workspace={workspace.name} path={null} small={false} />
        )}
        {hasDeck && <EditHistory />}
      </div>
      {hasDeck ? (
        <div className="flex items-center gap-1 self-stretch">
          <ModeTabs />
          <hr aria-orientation="vertical" className="mx-1 h-8 w-px border-0 bg-border" />
          <ChatButton />
        </div>
      ) : (
        <div />
      )}
      <div data-tauri-drag-region className="flex items-center justify-end gap-1 self-stretch">
        {hasDeck && (
          <div className="mr-2 flex items-center gap-1">
            <DeckActions />
          </div>
        )}
        {/* Open, the sidebar carries its own toggle, beside its maximize button. */}
        {!sidebarOpen && <SidebarToggle />}
      </div>
    </header>
  );
}

/**
 * The workspace folder, then each folder of the open file's path, then the file. Small and muted
 * above a deck's title; otherwise it is the title.
 */
function Breadcrumbs({ workspace, path, small }: { workspace: string; path: string | null; small: boolean }) {
  const crumbs = [workspace, ...(path ? path.split("/").filter(Boolean) : [])];
  return (
    <span
      data-breadcrumbs
      title={path ?? workspace}
      className={cn("flex min-w-0 items-center gap-1 px-1.5", small ? "text-2xs leading-4" : "text-sm")}
    >
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional path segments
          <span key={i} className={cn("flex items-center gap-1", last ? "min-w-0" : "shrink-0")}>
            {i > 0 && <span className="text-muted-foreground/40">/</span>}
            <span
              aria-current={last ? "page" : undefined}
              className={cn(
                "truncate",
                !last && "max-w-40 text-muted-foreground",
                last && (small ? "text-muted-foreground" : "font-medium text-foreground"),
              )}
            >
              {crumb}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * The open file's path (and a deck's title under it) as one button, opening a menu like Export's:
 * the deck's settings (for a deck), close the file, or show it in the file manager.
 */
function FileMenu({ workspace, file, deckTitle }: { workspace: string; file: OpenedFile; deckTitle: string | null }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(open, menuRef, () => setOpen(false), { escape: true });
  const name = basename(file.path);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={menuRef} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={file.path}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex min-w-0 max-w-full items-center gap-1 rounded-md py-1 pr-1.5 text-left hover:bg-accent",
          open && "bg-accent",
        )}
      >
        <span className="flex min-w-0 flex-col justify-center">
          <Breadcrumbs workspace={workspace} path={file.path} small={deckTitle !== null} />
          {deckTitle !== null && (
            <span data-deck-title title={deckTitle} className="truncate px-1.5 text-sm font-medium leading-5">
              {deckTitle || "Untitled"}
            </span>
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border bg-card p-1 shadow-lg">
          {deckTitle !== null && (
            <MenuItem
              icon={Settings2}
              label="Settings"
              hint="The slide size and the deck's style"
              onClick={choose(() => useApp.getState().setMode("settings"))}
            />
          )}
          <MenuItem icon={X} label={`Close ${name}`} onClick={choose(() => void useApp.getState().closeDeck())} />
          <MenuItem icon={FolderOpen} label={revealLabel} onClick={choose(() => void revealItemInDir(file.absolute))} />
        </div>
      )}
    </div>
  );
}

/**
 * Undo and redo of the open deck's changes, whatever made them: edits, the slide rail, review
 * marks, narration, the code view, the agent, or another app. Off while the agent is working.
 */
function EditHistory() {
  const undo = useApp((s) => s.history?.undo ?? null);
  const redo = useApp((s) => s.history?.redo ?? null);
  const running = useApp((s) => s.running);
  const app = useApp.getState;
  const busy = running ? " (once the agent is done)" : "";
  return (
    <div className="flex items-center">
      <ToolButton
        variant="panel"
        size="md"
        label="Undo"
        title={undo ? `Undo ${historyLabel(undo)} (⌘Z)${busy}` : "Nothing to undo"}
        disabled={!undo || running}
        onClick={() => void app().undo()}
      >
        <Undo2 className="size-4" />
      </ToolButton>
      <ToolButton
        variant="panel"
        size="md"
        label="Redo"
        title={redo ? `Redo ${historyLabel(redo)} (⇧⌘Z)${busy}` : "Nothing to redo"}
        disabled={!redo || running}
        onClick={() => void app().redo()}
      >
        <Redo2 className="size-4" />
      </ToolButton>
    </div>
  );
}

/** How an undo or redo names the change, e.g. `“Move slides”` or `chat: “Bigger title”`. */
export function historyLabel(entry: HistoryEntry): string {
  return entry.source === "chat" ? `chat: “${entry.label}”` : `“${entry.label}”`;
}

/** Opens the chat in the sidebar, or hides the sidebar when the chat is already showing. */
function ChatButton() {
  const showing = useApp((s) => s.sidebarOpen && s.sidebarTab === "chat");
  const label = showing ? "Hide chat" : "Show chat";
  return (
    <ToolButton
      variant="panel"
      size="md"
      title={label}
      aria-label={label}
      aria-pressed={showing}
      onClick={() => {
        const app = useApp.getState();
        if (showing) app.setSidebarOpen(false);
        else app.setSidebarTab("chat");
      }}
    >
      <MessageSquare className="size-5" strokeWidth={1.75} />
    </ToolButton>
  );
}

/** Shows or hides the slide rail on the left. */
function RailToggle() {
  const railOpen = useApp((s) => s.railOpen);
  const Icon = railOpen ? PanelLeftClose : PanelLeftOpen;
  const label = railOpen ? "Hide slides" : "Show slides";
  return (
    <ToolButton
      variant="panel"
      size="md"
      title={label}
      aria-label={label}
      aria-pressed={railOpen}
      onClick={() => useApp.getState().setRailOpen(!railOpen)}
    >
      <Icon className="size-4" />
    </ToolButton>
  );
}

/** Shows or hides the sidebar (chat, files) on the right. */
export function SidebarToggle() {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const Icon = sidebarOpen ? PanelRightClose : PanelRightOpen;
  const label = sidebarOpen ? "Hide sidebar" : "Show sidebar";
  return (
    <ToolButton
      variant="panel"
      size="md"
      title={label}
      aria-label={label}
      aria-pressed={sidebarOpen}
      onClick={() => useApp.getState().setSidebarOpen(!sidebarOpen)}
    >
      <Icon className="size-4" />
    </ToolButton>
  );
}
