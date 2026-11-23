import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  Files,
  FolderClosed,
  FolderOpen,
  FolderSearch,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PencilLine,
  Redo2,
  Settings,
  Settings2,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { HistoryEntry, OpenedFile, WorkspaceInfo } from "../lib/api";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { cn, isMac, revealLabel } from "../lib/utils";
import { openSettings, useApp } from "../store";
import { hiddenChatAttention } from "../store/attention";
import { ATTENTION_LABELS, AttentionMark } from "./AttentionMark";
import { DeckActions, MenuItem } from "./DeckActions";
import { ModeTabs } from "./ModeTabs";
import { chooseWorkspace } from "./openDialogs";
import { TitleField } from "./TitleField";

/**
 * The workspace's bar. On the left, the slide list's toggle (for a deck), then the open file's
 * path from the workspace folder with the deck's title under it, which opens the file menu: for
 * the deck, rename it, open its settings or close it (back to the folder); for the folder, show
 * its files, reveal it in the file manager, open another folder or close this one (back to the
 * start screen); then undo / redo. For a deck, its mode tabs in the middle. On the right, the
 * gear that opens the app's settings, then, for a deck, export and present; then the sidebar's
 * toggle while the sidebar is closed (open, it sits in the sidebar),
 * which marks an agent that works or waits while the chat is out of sight. The tools of each
 * mode live above the slide (Stage), and the lint status beside Tidy layout under it.
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
        {/* Keyed: another file starts with its menu closed and its title not being renamed. */}
        <FileMenu key={openedFile?.absolute ?? ""} workspace={workspace} file={openedFile} deckTitle={deckTitle} />
        {hasDeck && <EditHistory />}
      </div>
      {hasDeck ? (
        <div className="flex items-center gap-1 self-stretch">
          <ModeTabs />
        </div>
      ) : (
        <div />
      )}
      <div data-tauri-drag-region className="flex items-center justify-end gap-1 self-stretch">
        <Button
          variant="tool"
          size="icon-sm"
          tooltip="Settings"
          shortcut={SHELL_SHORTCUTS.appSettings}
          tooltipSide="bottom"
          onClick={() => openSettings()}
        >
          <Settings />
        </Button>
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
function Breadcrumbs(props: {
  workspace: string;
  path: string | null;
  small: boolean;
  /** Says the whole path on hover, where nothing around it does (the file's menu button has its own tooltip). */
  hint?: boolean;
}) {
  const { workspace, path, small } = props;
  const crumbs = [workspace, ...(path ? path.split("/").filter(Boolean) : [])];
  return (
    <span
      data-breadcrumbs
      title={props.hint ? (path ?? workspace) : undefined}
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
 * The open file's path (and a deck's title under it), or the folder's name with no file open, as
 * one button, opening the file menu. Its choices come in two sections, each under its label:
 * what is done to the open deck (or file), and what is done to the folder. Renaming turns the
 * title into a field in place: Enter takes the new title, Escape leaves the old one.
 */
function FileMenu(props: { workspace: WorkspaceInfo; file: OpenedFile | null; deckTitle: string | null }) {
  const { workspace, file, deckTitle } = props;
  const [renaming, setRenaming] = useState(false);
  const isDeck = deckTitle !== null;

  if (renaming && isDeck) {
    return (
      <div className="flex min-w-32 flex-col justify-center">
        <Breadcrumbs workspace={workspace.name} path={file?.path ?? null} small hint />
        <TitleField
          aria-label="Deck title"
          title={deckTitle}
          selectOnMount
          onCommit={(title) => useApp.getState().renameDeck(title)}
          onDone={() => setRenaming(false)}
          onCancel={() => setRenaming(false)}
          className="h-6 w-64 max-w-full px-1.5 font-medium"
        />
      </div>
    );
  }

  return (
    <div className="min-w-24">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              // Where the file is, in full: the path in the button is cut short when the bar is narrow.
              tooltip={file?.path ?? workspace.path}
              tooltipSide="bottom"
              className="h-auto max-w-full min-w-0 shrink justify-start gap-1 py-1 pr-1.5 pl-0 text-left font-normal"
            />
          }
        >
          <span className="flex min-w-0 flex-col justify-center">
            <Breadcrumbs workspace={workspace.name} path={file?.path ?? null} small={isDeck} />
            {isDeck && (
              <span data-deck-title className="truncate px-1.5 text-sm font-medium leading-5">
                {deckTitle || "Untitled"}
              </span>
            )}
          </span>
          <ChevronDown className="size-3 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          {file && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel className={sectionLabel}>{isDeck ? "Deck" : "File"}</DropdownMenuLabel>
                {isDeck && (
                  <>
                    <MenuItem icon={PencilLine} label="Rename…" onClick={() => setRenaming(true)} />
                    <MenuItem
                      icon={Settings2}
                      label="Deck settings"
                      hint="Its title, slide size and style"
                      onClick={() => useApp.getState().openDeckSettings()}
                    />
                  </>
                )}
                <MenuItem icon={FolderSearch} label={revealLabel} onClick={() => void revealItemInDir(file.absolute)} />
                <MenuItem
                  icon={X}
                  label={isDeck ? "Close deck" : "Close file"}
                  hint={`Back to ${workspace.name}`}
                  onClick={() => void useApp.getState().closeDeck()}
                />
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuGroup>
            <DropdownMenuLabel className={sectionLabel}>Folder</DropdownMenuLabel>
            <MenuItem
              icon={Files}
              label="Show in Files"
              hint={file ? "Where the file is in the folder" : "The folder's files, in the sidebar"}
              onClick={() => useApp.getState().setSidebarTab("files")}
            />
            {!file && (
              <MenuItem icon={FolderSearch} label={revealLabel} onClick={() => void revealItemInDir(workspace.path)} />
            )}
            <MenuItem
              icon={FolderOpen}
              label="Open folder…"
              hint="Work on the decks of another folder"
              shortcut={SHELL_SHORTCUTS.openFolder}
              onClick={() => void chooseWorkspace()}
            />
            <MenuItem
              icon={FolderClosed}
              label="Close folder"
              hint="Back to the start screen"
              onClick={() => void useApp.getState().closeWorkspace()}
            />
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The small uppercase label over a section of a menu. */
const sectionLabel = "px-2 pt-1.5 pb-0.5 text-2xs uppercase tracking-wide";

/**
 * Undo and redo of the open deck's changes, whatever made them: edits, the slide rail, review
 * marks, narration, the code view, the agent, or another app. Off while the agent is working.
 */
function EditHistory() {
  const undo = useApp((s) => s.history?.undo ?? null);
  const redo = useApp((s) => s.history?.redo ?? null);
  const running = useApp((s) => s.running);
  const app = useApp.getState;
  /** Said while the agent works, when the step has to wait. */
  const later = (step: string) => `${step}, once the agent is done`;
  /** A step's tooltip: what it takes back or brings back, or why it cannot just now. Its keys show while it can. */
  const hint = (name: string, entry: HistoryEntry | null) => {
    if (!entry) return { tooltip: `Nothing to ${name.toLowerCase()}` };
    const step = `${name} ${historyLabel(entry)}`;
    return running ? { tooltip: later(step) } : { tooltip: step };
  };
  return (
    <div className="flex items-center">
      <Button
        variant="tool"
        size="icon-sm"
        aria-label="Undo"
        {...hint("Undo", undo)}
        {...(undo && !running && { shortcut: "mod+z" })}
        tooltipSide="bottom"
        disabled={!undo || running}
        onClick={() => void app().undo()}
      >
        <Undo2 />
      </Button>
      <Button
        variant="tool"
        size="icon-sm"
        aria-label="Redo"
        {...hint("Redo", redo)}
        {...(redo && !running && { shortcut: "mod+shift+z" })}
        tooltipSide="bottom"
        disabled={!redo || running}
        onClick={() => void app().redo()}
      >
        <Redo2 />
      </Button>
    </div>
  );
}

/** How an undo or redo names the change, e.g. `“Move slides”` or `chat: “Bigger title”`. */
export function historyLabel(entry: HistoryEntry): string {
  return entry.source === "chat" ? `chat: “${entry.label}”` : `“${entry.label}”`;
}

/** Shows or hides the slide list on the left. */
function RailToggle() {
  const railOpen = useApp((s) => s.railOpen);
  const Icon = railOpen ? PanelLeftClose : PanelLeftOpen;
  return (
    <Button
      variant="tool"
      size="icon-sm"
      tooltip={railOpen ? "Hide slides" : "Show slides"}
      shortcut={SHELL_SHORTCUTS.rail}
      tooltipSide="bottom"
      aria-pressed={railOpen}
      onClick={() => useApp.getState().setRailOpen(!railOpen)}
    >
      <Icon />
    </Button>
  );
}

/**
 * Shows or hides the sidebar (chat, files) on the right. While the chat is out of sight, it
 * carries the agent's mark: a spinner while a turn runs, a warning dot while the agent waits
 * for an approval.
 */
export function SidebarToggle() {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const attention = useApp(hiddenChatAttention);
  const Icon = sidebarOpen ? PanelRightClose : PanelRightOpen;
  const label = sidebarOpen ? "Hide sidebar" : "Show sidebar";
  return (
    <span className="relative flex">
      <Button
        variant="tool"
        size="icon-sm"
        aria-label={label}
        tooltip={attention ? `${label}: ${ATTENTION_LABELS[attention].toLowerCase()}` : label}
        shortcut={SHELL_SHORTCUTS.sidebar}
        tooltipSide="bottom"
        aria-pressed={sidebarOpen}
        onClick={() => useApp.getState().setSidebarOpen(!sidebarOpen)}
      >
        <Icon />
      </Button>
      {attention && (
        <AttentionMark
          attention={attention}
          className="pointer-events-none absolute -right-0.5 -top-0.5 rounded-full bg-background p-px"
        />
      )}
    </span>
  );
}
