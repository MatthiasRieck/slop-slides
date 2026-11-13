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
  Settings2,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";

import { useDropdown } from "../hooks/useDropdown";
import { useMenuKeys } from "../hooks/useMenuKeys";
import type { HistoryEntry, OpenedFile, WorkspaceInfo } from "../lib/api";
import { formatKeys } from "../lib/keys";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { cn, isMac, revealLabel } from "../lib/utils";
import { useApp } from "../store";
import { hiddenChatAttention } from "../store/attention";
import { ATTENTION_LABELS, AttentionMark } from "./AttentionMark";
import { ToolButton } from "./Button";
import { DeckActions, MenuItem } from "./DeckActions";
import { ModeTabs } from "./ModeTabs";
import { chooseWorkspace } from "./openDialogs";
import { SectionLabel } from "./SectionLabel";
import { TitleField } from "./TitleField";

/**
 * The workspace's bar. On the left, the slide list's toggle (for a deck), then the open file's
 * path from the workspace folder with the deck's title under it, which opens the file menu: for
 * the deck, rename it, open its settings or close it (back to the folder); for the folder, show
 * its files, reveal it in the file manager, open another folder or close this one (back to the
 * start screen); then undo / redo. For a deck, its mode tabs in the middle, then export and
 * present; then the sidebar's toggle while the sidebar is closed (open, it sits in the sidebar),
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
 * The open file's path (and a deck's title under it), or the folder's name with no file open, as
 * one button, opening the file menu. Its choices come in two sections, each under its label:
 * what is done to the open deck (or file), and what is done to the folder. Renaming turns the
 * title into a field in place: Enter takes the new title, Escape leaves the old one.
 */
function FileMenu(props: { workspace: WorkspaceInfo; file: OpenedFile | null; deckTitle: string | null }) {
  const { workspace, file, deckTitle } = props;
  const { open, setOpen, ref: menuRef } = useDropdown();
  const menu = useMenuKeys();
  const [renaming, setRenaming] = useState(false);
  const isDeck = deckTitle !== null;

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  if (renaming && isDeck) {
    return (
      <div className="flex min-w-32 flex-col justify-center">
        <Breadcrumbs workspace={workspace.name} path={file?.path ?? null} small />
        <TitleField
          aria-label="Deck title"
          title={deckTitle}
          selectOnMount
          onCommit={(title) => useApp.getState().renameDeck(title)}
          onDone={() => setRenaming(false)}
          onCancel={() => setRenaming(false)}
          className="h-6 w-64 max-w-full text-sm font-medium"
        />
      </div>
    );
  }

  return (
    <div ref={menuRef} className="relative min-w-24">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={file?.path ?? workspace.path}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex min-w-0 max-w-full items-center gap-1 rounded-md py-1 pr-1.5 text-left hover:bg-accent",
          open && "bg-accent",
        )}
      >
        <span className="flex min-w-0 flex-col justify-center">
          <Breadcrumbs workspace={workspace.name} path={file?.path ?? null} small={isDeck} />
          {isDeck && (
            <span data-deck-title title={deckTitle} className="truncate px-1.5 text-sm font-medium leading-5">
              {deckTitle || "Untitled"}
            </span>
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div
          role="menu"
          {...menu}
          className="enter-below absolute left-0 top-full z-20 mt-1 w-60 rounded-lg border bg-card p-1 shadow-lg outline-none"
        >
          {file && (
            <>
              <SectionLabel className="block px-2 pb-0.5 pt-1.5">{isDeck ? "Deck" : "File"}</SectionLabel>
              {isDeck && (
                <>
                  <MenuItem icon={PencilLine} label="Rename…" onClick={choose(() => setRenaming(true))} />
                  <MenuItem
                    icon={Settings2}
                    label="Deck settings"
                    hint="Its title, slide size and style"
                    onClick={choose(() => useApp.getState().openDeckSettings())}
                  />
                </>
              )}
              <MenuItem
                icon={FolderSearch}
                label={revealLabel}
                onClick={choose(() => void revealItemInDir(file.absolute))}
              />
              <MenuItem
                icon={X}
                label={isDeck ? "Close deck" : "Close file"}
                hint={`Back to ${workspace.name}`}
                onClick={choose(() => void useApp.getState().closeDeck())}
              />
              <hr className="my-1 border-border" />
            </>
          )}
          <SectionLabel className="block px-2 pb-0.5 pt-1.5">Folder</SectionLabel>
          <MenuItem
            icon={Files}
            label="Show in Files"
            hint={file ? "Where the file is in the folder" : "The folder's files, in the sidebar"}
            onClick={choose(() => useApp.getState().setSidebarTab("files"))}
          />
          {!file && (
            <MenuItem
              icon={FolderSearch}
              label={revealLabel}
              onClick={choose(() => void revealItemInDir(workspace.path))}
            />
          )}
          <MenuItem
            icon={FolderOpen}
            label="Open folder…"
            hint={`Work on the decks of another folder (${formatKeys(SHELL_SHORTCUTS.openFolder)})`}
            onClick={choose(() => void chooseWorkspace())}
          />
          <MenuItem
            icon={FolderClosed}
            label="Close folder"
            hint="Back to the start screen"
            onClick={choose(() => void useApp.getState().closeWorkspace())}
          />
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
  /** Said while the agent works, when the step has to wait. */
  const later = (step: string) => `${step}, once the agent is done`;
  return (
    <div className="flex items-center">
      <ToolButton
        variant="panel"
        size="md"
        label="Undo"
        title={undo ? `Undo ${historyLabel(undo)}` : undefined}
        shortcut="mod+z"
        disabledReason={undo ? later(`Undo ${historyLabel(undo)}`) : "Nothing to undo"}
        disabled={!undo || running}
        onClick={() => void app().undo()}
      >
        <Undo2 className="size-4" />
      </ToolButton>
      <ToolButton
        variant="panel"
        size="md"
        label="Redo"
        title={redo ? `Redo ${historyLabel(redo)}` : undefined}
        shortcut="mod+shift+z"
        disabledReason={redo ? later(`Redo ${historyLabel(redo)}`) : "Nothing to redo"}
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

/** Shows or hides the slide list on the left. */
function RailToggle() {
  const railOpen = useApp((s) => s.railOpen);
  const Icon = railOpen ? PanelLeftClose : PanelLeftOpen;
  return (
    <ToolButton
      variant="panel"
      size="md"
      label={railOpen ? "Hide slides" : "Show slides"}
      shortcut={SHELL_SHORTCUTS.rail}
      active={railOpen}
      onClick={() => useApp.getState().setRailOpen(!railOpen)}
    >
      <Icon className="size-4" />
    </ToolButton>
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
      <ToolButton
        variant="panel"
        size="md"
        label={label}
        title={attention ? `${label}: ${ATTENTION_LABELS[attention].toLowerCase()}` : label}
        shortcut={SHELL_SHORTCUTS.sidebar}
        active={sidebarOpen}
        onClick={() => useApp.getState().setSidebarOpen(!sidebarOpen)}
      >
        <Icon className="size-4" />
      </ToolButton>
      {attention && (
        <AttentionMark
          attention={attention}
          className="pointer-events-none absolute -right-0.5 -top-0.5 rounded-full bg-background p-px"
        />
      )}
    </span>
  );
}
