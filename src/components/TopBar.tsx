import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AppWindow,
  Bot,
  ChevronDown,
  Copy,
  FileInput,
  FilePlus2,
  Files,
  FileUp,
  FolderClosed,
  FolderOpen,
  FolderSearch,
  History,
  ListTree,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PencilLine,
  Presentation,
  Redo2,
  Settings2,
  Trash2,
  Undo2,
  User,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type BoxSize, useContentFit } from "../hooks/useContentSize";
import { useMenuKeys } from "../hooks/useMenuKeys";
import { api, type DeckVersions, type HistoryEntry, type OpenedFile, type WorkspaceInfo } from "../lib/api";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { type TopBarRoom, topBarRoom } from "../lib/topBar";
import { cn, isMac, relativeTime, revealLabel, trashName } from "../lib/utils";
import { showError, showSuccess, useApp } from "../store";
import { hiddenChatAttention } from "../store/attention";
import { ATTENTION_LABELS, AttentionMark } from "./AttentionMark";
import { ToolButton } from "./Button";
import { DeckActions, MenuItem } from "./DeckActions";
import { importPowerPoint as importPptxFile } from "./export/importPowerPoint";
import { ModeTabs } from "./ModeTabs";
import { NewDeckDialog } from "./NewDeck";
import { chooseDeck, chooseWorkspace, pickPptx } from "./openDialogs";
import { Popover } from "./Popover";
import { SaveStatus } from "./SaveStatus";
import { SectionLabel } from "./SectionLabel";
import { ShellButtons } from "./ShellButtons";
import { TitleField } from "./TitleField";

/**
 * The workspace's bar. On the left, the slide list's toggle (for a deck), then the open file's
 * folder with the deck's title under it, which opens the file menu (a double-click renames the
 * deck in place): start, open or import another deck, open another window; for the deck, rename,
 * duplicate, reveal, trash or close it; for the folder, browse, reveal or close it. Then undo and
 * redo, with the deck's earlier versions to go back to, and the word that the deck is saved. For
 * a deck, its mode tabs in the middle, then export and present; then, while the sidebar is
 * closed, the app's settings, the shortcuts and the sidebar's toggle (open, they sit in the
 * sidebar), which marks an agent that works or waits while the chat is out of sight.
 *
 * Short of room, the bar gives it up in a set order (see ../lib/topBar.ts): labels first, then
 * the folder line over the title, the tabs' names and Present's. The left group alone shrinks,
 * its title shortening to "…": nothing ever lies over the mode tabs.
 */
export function TopBar() {
  const workspace = useApp((s) => s.workspace);
  const hasDeck = useApp((s) => s.deck !== null);
  const deckTitle = useApp((s) => s.deck?.title ?? null);
  const openedFile = useApp((s) => s.openedFile);
  const header = useRef<HTMLElement>(null);
  // Renders as the bar crosses a width where its room changes, not at every pixel of a drag.
  const room = useContentFit(header, roomFor);
  if (!workspace) return null;

  return (
    <header
      ref={header}
      data-tauri-drag-region
      className={cn(
        "relative z-dropdown grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(max-content,1fr)] items-center gap-3 border-b bg-background pr-3",
        isMac ? "pl-[84px]" : "pl-3",
      )}
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-1 self-stretch overflow-hidden">
        {hasDeck && <RailToggle />}
        {/* Keyed: another file starts with its menu closed and its title not being renamed. */}
        <FileMenu
          key={openedFile?.absolute ?? ""}
          workspace={workspace}
          file={openedFile}
          deckTitle={deckTitle}
          room={room}
        />
        {hasDeck && <EditHistory />}
        {hasDeck && <SaveStatus compact={!room.labels} />}
      </div>
      {hasDeck ? (
        <div className="flex items-center gap-1 self-stretch">
          <ModeTabs compact={!room.tabLabels} />
        </div>
      ) : (
        <div />
      )}
      <div data-tauri-drag-region className="flex items-center justify-end gap-1 self-stretch">
        {hasDeck && (
          <div className="mr-2 flex items-center gap-1">
            <DeckActions exportLabel={room.labels} presentLabel={room.presentLabel} />
          </div>
        )}
        <SidebarClosedButtons />
      </div>
      <NewDeckDialog />
    </header>
  );
}

const roomFor = (size: BoxSize | null) => topBarRoom(size?.width ?? null);

/** While the sidebar is closed, what it carries when open: the app's settings, the shortcuts, and its toggle. */
function SidebarClosedButtons() {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  if (sidebarOpen) return null;
  return (
    <>
      <ShellButtons />
      <SidebarToggle />
    </>
  );
}

/** What the line over a deck's title says: the folders of its path, without the `deck.html` every deck in a folder of its own ends in. */
export function crumbsOf(workspace: string, path: string | null, isDeck: boolean): string[] {
  const parts = path ? path.split("/").filter(Boolean) : [];
  if (isDeck && parts.at(-1) === "deck.html") parts.pop();
  return [workspace, ...parts];
}

/**
 * The workspace folder, then each folder of the open file's path, then the file (unless it is a
 * deck's `deck.html`). Small and muted above a deck's title; otherwise it is the title.
 */
function Breadcrumbs({ crumbs, title, small }: { crumbs: string[]; title: string; small: boolean }) {
  return (
    <span
      data-breadcrumbs
      title={title}
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
 * Imports the PowerPoint file the user picks as a new deck in the open folder, saying which slide
 * it reads while it runs, then what did not come along (see export/PptxImport.tsx).
 */
async function importPowerPoint() {
  const path = await pickPptx();
  if (path) await importPptxFile(path);
}

/**
 * The open file's folder (and a deck's title under it), or the folder's name with no file open, as
 * one button, opening the file menu; a double-click on a deck's title renames it in place: Enter
 * takes the new title, Escape leaves the old one. The menu's choices come in sections: starting,
 * opening and importing another deck, what is done to the open deck (or file), and what is done
 * to the folder.
 */
function FileMenu(props: {
  workspace: WorkspaceInfo;
  file: OpenedFile | null;
  deckTitle: string | null;
  room: TopBarRoom;
}) {
  const { workspace, file, deckTitle, room } = props;
  // A popover of its own, out of the bar: the bar's left part clips what overflows it.
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useMenuKeys();
  const [renaming, setRenaming] = useState(false);
  const isDeck = deckTitle !== null;
  const crumbs = crumbsOf(workspace.name, file?.path ?? null, isDeck);
  const app = useApp.getState;

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  if (renaming && isDeck) {
    return (
      <div className="flex min-w-24 flex-col justify-center">
        {room.extras && <Breadcrumbs crumbs={crumbs} title={file?.path ?? workspace.path} small />}
        <TitleField
          aria-label="Deck title"
          title={deckTitle}
          selectOnMount
          onCommit={(title) => app().renameDeck(title)}
          onDone={() => setRenaming(false)}
          onCancel={() => setRenaming(false)}
          className="h-6 w-64 max-w-full text-sm font-medium"
        />
      </div>
    );
  }

  const title = deckTitle || "Untitled";
  return (
    <div className="relative min-w-12 shrink">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={isDeck ? `${title}: double-click to rename, click for the deck's menu` : (file?.path ?? workspace.path)}
        onClick={() => setOpen((v) => !v)}
        onDoubleClick={() => {
          if (!isDeck) return;
          setOpen(false);
          setRenaming(true);
        }}
        className={cn(
          "flex min-w-0 max-w-full items-center gap-1 rounded-md py-1 pr-1.5 text-left hover:bg-accent",
          open && "bg-accent",
        )}
      >
        <span className="flex min-w-0 flex-col justify-center">
          {(!isDeck || room.extras) && (
            <Breadcrumbs crumbs={crumbs} title={file?.path ?? workspace.path} small={isDeck} />
          )}
          {isDeck && (
            <span data-deck-title className="truncate px-1.5 text-sm font-medium leading-5">
              {title}
            </span>
          )}
        </span>
        <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <Popover anchor={button} placement="below" width={256} portal variant="menu" onClose={() => setOpen(false)}>
          <div role="menu" {...menu} className="p-1 outline-none">
            <MenuItem
              icon={FilePlus2}
              label="New deck…"
              hint={`In a new folder in ${workspace.name}`}
              onClick={choose(() => app().setNewDeckOpen(true))}
            />
            <MenuItem
              icon={Presentation}
              label="Open deck…"
              shortcut={SHELL_SHORTCUTS.openDeck}
              onClick={choose(() => void chooseDeck())}
            />
            <MenuItem
              icon={FolderOpen}
              label="Open folder…"
              shortcut={SHELL_SHORTCUTS.openFolder}
              onClick={choose(() => void chooseWorkspace())}
            />
            <MenuItem
              icon={FileUp}
              label="Import PowerPoint…"
              hint={`As a new deck in ${workspace.name}`}
              onClick={choose(() => void importPowerPoint())}
            />
            <MenuItem
              icon={AppWindow}
              label="New window"
              shortcut="mod+n"
              onClick={choose(
                () => void api.newWindow().catch((error) => showError(error, { doing: "Could not open a new window" })),
              )}
            />
            <hr className="my-1 border-border" />
            {file && (
              <>
                <SectionLabel className="block px-2 pb-0.5 pt-1.5">{isDeck ? "Deck" : "File"}</SectionLabel>
                {isDeck && (
                  <>
                    <MenuItem icon={PencilLine} label="Rename…" onClick={choose(() => setRenaming(true))} />
                    <MenuItem
                      icon={Settings2}
                      label="Deck settings…"
                      hint="Its title, slide size and style"
                      onClick={choose(() => app().openDeckSettings())}
                    />
                    <MenuItem
                      icon={Copy}
                      label="Duplicate deck"
                      hint="Opens a copy of it, beside it"
                      onClick={choose(() => void app().duplicateDeck(file.absolute, { open: true }))}
                    />
                  </>
                )}
                <MenuItem
                  icon={ListTree}
                  label="Reveal in sidebar"
                  hint="Where it is among the folder's files"
                  onClick={choose(() => app().setSidebarTab("files"))}
                />
                <MenuItem
                  icon={FolderSearch}
                  label={revealLabel}
                  onClick={choose(() => void revealItemInDir(file.absolute))}
                />
                {isDeck && (
                  <MenuItem
                    icon={Trash2}
                    label={`Move deck to ${trashName}…`}
                    onClick={choose(() => void app().trashDeck(file.absolute, title))}
                  />
                )}
                <MenuItem
                  icon={X}
                  label={isDeck ? "Close deck" : "Close file"}
                  hint={`Back to the folder “${workspace.name}”`}
                  onClick={choose(() => void app().closeDeck())}
                />
                <hr className="my-1 border-border" />
              </>
            )}
            <SectionLabel className="block px-2 pb-0.5 pt-1.5">Folder</SectionLabel>
            {!file && (
              <>
                <MenuItem
                  icon={Files}
                  label="Browse files"
                  hint="The folder's files, in the sidebar"
                  onClick={choose(() => app().setSidebarTab("files"))}
                />
                <MenuItem
                  icon={FolderSearch}
                  label={revealLabel}
                  onClick={choose(() => void revealItemInDir(workspace.path))}
                />
              </>
            )}
            <MenuItem
              icon={FolderClosed}
              label="Close folder"
              hint="Back to the start screen"
              onClick={choose(() => void app().closeWorkspace())}
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

/**
 * Undo and redo of the open deck's changes, whatever made them: edits, the slide rail, review
 * marks, narration, the code view, the agent, or another app. Off while the agent is working.
 * Between them, the deck's earlier versions to go back to (see `VersionMenu`).
 */
function EditHistory() {
  const undo = useApp((s) => s.history?.undo ?? null);
  const redo = useApp((s) => s.history?.redo ?? null);
  const running = useApp((s) => s.running);
  const app = useApp.getState;
  /** Said while the agent works, when the step has to wait. */
  const later = (step: string) => `${step}, once the agent is done`;
  return (
    <div className="flex shrink-0 items-center">
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
      <VersionMenu running={running} />
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

/** Who made a change in a deck's history, as the version list says it, with its icon. */
export function versionSource(entry: HistoryEntry): { who: string; icon: typeof User } {
  switch (entry.source) {
    case "chat":
      return { who: "Agent", icon: Bot };
    case "external":
      return { who: "Another app", icon: FileInput };
    case "open":
      return { who: "Opened", icon: History };
    default:
      return { who: "You", icon: User };
  }
}

/** What a day of versions is headed by: "Today", "Yesterday", or its date. */
export function dayLabel(time: number, now = Date.now()): string {
  const day = (ms: number) => new Date(ms).toDateString();
  if (day(time) === day(now)) return "Today";
  if (day(time) === day(now - 86_400_000)) return "Yesterday";
  return new Date(time).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * The deck's earlier versions, newest first, under the day they were made: what made each, who
 * (you, the agent, another app) and when. The deck's version is marked; the ones after it were
 * undone. Choosing one puts the deck back as it was then, as one change: Undo takes it back,
 * which the toast that says so offers too. Off while the agent works.
 */
function VersionMenu({ running }: { running: boolean }) {
  const deck = useApp((s) => s.deck?.id ?? null);
  const historyKey = useApp((s) => s.history?.current ?? null);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<DeckVersions | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useMenuKeys();

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the deck moves to another version
  useEffect(() => {
    if (!open || !deck) return;
    let live = true;
    api
      .deckVersions(deck)
      .then((list) => live && setVersions(list))
      .catch((error) => {
        if (!live) return;
        setOpen(false);
        showError(error, { doing: "Could not list the deck's versions" });
      });
    return () => {
      live = false;
    };
  }, [open, deck, historyKey]);

  const goBack = async (entry: HistoryEntry) => {
    setOpen(false);
    const app = useApp.getState();
    if (await app.restoreVersion(entry.id)) {
      showSuccess(`Back to the version after “${entry.label}”`, { label: "Undo", run: () => void app.undo() });
    }
  };

  const entries = versions?.entries ?? [];
  const at = entries.findIndex((e) => e.id === versions?.current);
  return (
    <>
      <ToolButton
        ref={button}
        variant="panel"
        label="Earlier versions"
        title="Go back to an earlier version"
        disabledReason="Go back to an earlier version, once the agent is done"
        disabled={running || !deck}
        aria-haspopup="menu"
        aria-expanded={open}
        active={open}
        onClick={() => {
          setVersions(null);
          setOpen((v) => !v);
        }}
        className="-mx-0.5 px-0 py-1.5"
      >
        <ChevronDown className="size-3" />
      </ToolButton>
      {open && (
        <Popover
          anchor={button}
          placement="below"
          width={320}
          portal
          label="Earlier versions"
          onClose={() => setOpen(false)}
        >
          <div className="border-b px-3 py-2">
            <p className="text-xs font-medium">Earlier versions</p>
            <p className="text-2xs text-muted-foreground">
              Going back is one change: Undo brings the deck back to now.
            </p>
          </div>
          {versions === null ? (
            <p role="status" className="px-3 py-3 text-xs text-muted-foreground">
              Loading versions…
            </p>
          ) : entries.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              No versions yet: each change to the deck from now on can be gone back to.
            </p>
          ) : (
            <div role="menu" {...menu} aria-label="Versions" className="min-h-0 overflow-y-auto p-1 outline-none">
              {entries.map((entry, i) => {
                const { who, icon: Icon } = versionSource(entry);
                const current = i === at;
                const undone = at >= 0 && i < at;
                const newDay = i === 0 || dayLabel(entries[i - 1]!.time) !== dayLabel(entry.time);
                return (
                  <div key={entry.id}>
                    {newDay && <SectionLabel className="block px-2 pt-1.5 pb-0.5">{dayLabel(entry.time)}</SectionLabel>}
                    <button
                      type="button"
                      role="menuitem"
                      aria-current={current || undefined}
                      disabled={current}
                      title={current ? "The deck is at this version" : "Go back to this version"}
                      onClick={() => void goBack(entry)}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:hover:bg-transparent",
                        current && "bg-primary/10",
                      )}
                    >
                      <Icon
                        className={cn("mt-0.5 size-4 shrink-0", current ? "text-primary" : "text-muted-foreground")}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn("truncate text-xs font-medium", undone && "text-muted-foreground")}>
                          {entry.label}
                        </span>
                        <span className="text-2xs text-muted-foreground">
                          {who} · {relativeTime(entry.time)}
                          {current && " · Now"}
                          {undone && " · Undone"}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Popover>
      )}
    </>
  );
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
      className="shrink-0"
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
