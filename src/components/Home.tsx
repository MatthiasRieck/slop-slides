import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FileUp,
  Folder,
  FolderOpen,
  FolderSearch,
  Library,
  MoreHorizontal,
  PencilLine,
  Plus,
  Presentation,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useDropdown } from "../hooks/useDropdown";
import { useMenuKeys } from "../hooks/useMenuKeys";
import { useShellKeys } from "../hooks/useShellKeys";
import { api, type GalleryDeck, type RecentWorkspace } from "../lib/api";
import { PROVIDER_IDS, PROVIDERS } from "../lib/models";
import { DECK_IDEAS, matchingDecks, UNTITLED_DECK } from "../lib/newDeck";
import { type Openable, openableOf } from "../lib/opening";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { pixelsOf } from "../lib/slideSize";
import { basename, cn, dirname, isMac, relativeTime, revealLabel, trashName } from "../lib/utils";
import { showError, useApp } from "../store";
import { Button, type ButtonSize, ToolButton, withShortcut } from "./Button";
import { InstallHint } from "./chat/InstallHint";
import { MenuItem } from "./DeckActions";
import { importPowerPoint } from "./export/importPowerPoint";
import { chooseDeck, chooseWorkspace, pickPptx } from "./openDialogs";
import { SectionLabel } from "./SectionLabel";
import { ShellButtons } from "./ShellButtons";
import { SlideImage } from "./SlideImage";
import { StyleChoice } from "./Templates";
import { TitleField } from "./TitleField";

/** Opens the SlopSlide library as the workspace; false when it did not open. */
export async function openLibrary(): Promise<boolean> {
  try {
    await useApp.getState().openWorkspace(await api.libraryFolder());
  } catch (error) {
    showError(error, { doing: "Could not open the library" });
  }
  return useApp.getState().workspace !== null;
}

/**
 * Importing a PowerPoint file as a new deck: `importing` names the file while its import runs,
 * `importFile` imports the file at a path, and `choose` asks for one first. `beforeImport` gets
 * a workspace open (false stops the import). One import runs at a time.
 */
export function usePptxImport(beforeImport?: () => Promise<boolean>) {
  const [importing, setImporting] = useState<string | null>(null);
  const busy = useRef(false);

  const importFile = async (path: string) => {
    if (busy.current) return;
    busy.current = true;
    setImporting(basename(path));
    try {
      if (beforeImport && !(await beforeImport())) return;
      await importPowerPoint(path);
    } finally {
      busy.current = false;
      setImporting(null);
    }
  };

  const choose = async () => {
    if (busy.current) return;
    const path = await pickPptx();
    if (path) await importFile(path);
  };

  return { importing, importFile, choose };
}

/** "Import PowerPoint…", saying which file while its import runs (see {@link usePptxImport}). */
export function ImportPptxButton(props: {
  job: ReturnType<typeof usePptxImport>;
  size?: ButtonSize;
  className?: string;
}) {
  const { importing, choose } = props.job;
  return (
    <Button size={props.size} busy={importing !== null} onClick={() => void choose()} className={props.className}>
      {importing === null ? (
        <>
          <FileUp />
          Import PowerPoint…
        </>
      ) : (
        `Importing ${importing}…`
      )}
    </Button>
  );
}

/**
 * Files and folders dropped on the start screen: `dragging` while something is held over the
 * window, and `onDrop` with what was let go. The chat listens for drops too (to attach them, see
 * chat/useAttachments.ts), but only in an open workspace, which the start screen is not: the two
 * are never mounted together, and this one stops listening as it goes.
 */
function useHomeDrops(onDrop: (paths: string[]) => void) {
  const [dragging, setDragging] = useState(false);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (disposed) return;
          const { type } = event.payload;
          if (type === "enter" || type === "over") setDragging(true);
          else if (type === "leave") setDragging(false);
          else if (event.payload.type === "drop") {
            setDragging(false);
            dropRef.current(event.payload.paths);
          }
        })
        .then((stop) => {
          if (disposed) stop();
          else unlisten = stop;
        });
    } catch {
      // Without a webview to listen to (the browser preview), nothing is dropped.
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return dragging;
}

/** The decks and folders opened before, as the start screen lists them. */
interface Recent {
  decks: GalleryDeck[];
  folders: RecentWorkspace[];
}

/**
 * The lists as last read, in this window: coming back to the start screen shows them at once,
 * while they are read again.
 */
let lastRecent: Recent | null = null;

/** With more decks than this, a field to find one shows above them. */
const FILTER_FROM = 8;

/**
 * The start screen: start a deck in the library from what it is about, the decks there are as
 * pictures of their first slides (the library's and the ones opened before), open a deck or a
 * folder, import a PowerPoint file, or go back to a folder opened before. A folder, a deck or a
 * PowerPoint file dropped on it opens the same way. The app's settings and the shortcuts are at
 * its top right; a first start says whether an agent is installed and offers an example deck.
 */
export function Home() {
  const [recent, setRecent] = useState(lastRecent);
  const decks = recent?.decks ?? null;
  const folders = recent?.folders ?? null;
  const pptx = usePptxImport(openLibrary);
  useShellKeys();

  const refresh = () =>
    Promise.all([api.deckGallery(), api.recentWorkspaces()])
      .then(([deckList, folderList]) => {
        lastRecent = {
          decks: Array.isArray(deckList) ? deckList : [],
          folders: Array.isArray(folderList) ? folderList : [],
        };
        setRecent(lastRecent);
      })
      .catch((error) =>
        showError(error, {
          doing: "Could not load the recent decks",
          action: { label: "Retry", run: () => void refresh() },
        }),
      );

  // biome-ignore lint/correctness/useExhaustiveDependencies: load the lists once on mount
  useEffect(() => {
    void refresh();
  }, []);

  const forget = async (remove: () => Promise<unknown>) => {
    try {
      await remove();
    } catch (error) {
      showError(error, { doing: "Could not remove it from the list" });
    }
    await refresh();
  };

  const openDropped = (dropped: Openable | null) => {
    if (!dropped) return;
    const app = useApp.getState();
    if (dropped.kind === "deck") void app.openDeckFile(dropped.path);
    else if (dropped.kind === "powerpoint") void pptx.importFile(dropped.path);
    else void app.openWorkspace(dropped.path);
  };
  const dragging = useHomeDrops((paths) => openDropped(openableOf(paths)));

  const nothingYet = decks !== null && folders !== null && decks.length === 0 && folders.length === 0;

  return (
    <div className="relative flex h-full flex-col">
      <header
        data-tauri-drag-region
        className={cn("flex h-14 shrink-0 items-center gap-1 pr-3", isMac ? "pl-[84px]" : "pl-4")}
      >
        <span data-tauri-drag-region className="text-sm font-semibold tracking-tight">
          SlopSlide
        </span>
        <span data-tauri-drag-region className="flex-1 self-stretch" />
        <ShellButtons />
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-8 px-8 pt-6 pb-10">
          <NewDeckForm
            heading="New deck"
            hint="New decks start in your SlopSlide library. Open a folder to work on the decks in it."
            beforeCreate={openLibrary}
            disabled={pptx.importing !== null}
            autoFocus
          />
          <AgentCheck />

          <section className="flex flex-col gap-2">
            <SectionLabel as="h2">Open</SectionLabel>
            <div className="flex flex-wrap gap-2">
              <Button
                size="2xl"
                title={withShortcut("Open a deck file", SHELL_SHORTCUTS.openDeck)}
                onClick={() => void chooseDeck()}
                className="bg-card"
              >
                <Presentation />
                Open deck…
              </Button>
              <Button
                size="2xl"
                title={withShortcut("Open a folder of decks", SHELL_SHORTCUTS.openFolder)}
                onClick={() => void chooseWorkspace()}
                className="bg-card"
              >
                <FolderOpen />
                Open folder…
              </Button>
              <ImportPptxButton job={pptx} size="2xl" className="bg-card" />
              <Button size="2xl" onClick={() => void openLibrary()} className="bg-card">
                <Library />
                SlopSlide library
              </Button>
            </div>
            {nothingYet && <FirstRun />}
          </section>

          {decks === null ? (
            <p role="status" className="text-xs text-muted-foreground">
              Looking for your decks…
            </p>
          ) : (
            decks.length > 0 && <DeckGallery decks={decks} onChanged={() => void refresh()} />
          )}

          {folders && folders.length > 0 && (
            <section className="flex flex-col gap-2">
              <SectionLabel as="h2">Recent folders</SectionLabel>
              <ul aria-label="Recent folders" className="flex flex-col divide-y rounded-lg border bg-card">
                {folders.map((workspace) => (
                  <RecentRow
                    key={workspace.path}
                    icon={<Folder className="size-4 shrink-0 text-muted-foreground" />}
                    name={workspace.name}
                    detail={workspace.path}
                    openedMs={workspace.openedMs}
                    onOpen={() => void useApp.getState().openWorkspace(workspace.path)}
                    removeLabel={`Remove ${workspace.name} from recent folders`}
                    onRemove={() => void forget(() => api.forgetWorkspace(workspace.path))}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
      {dragging && (
        <div
          role="status"
          className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium"
        >
          Drop a folder, a deck or a PowerPoint file to open it
        </div>
      )}
    </div>
  );
}

/** Nothing opened yet: what to do first, and an example deck to try the app on. */
function FirstRun() {
  const [making, setMaking] = useState(false);
  const openExample = async () => {
    setMaking(true);
    try {
      if (await openLibrary()) await useApp.getState().createExampleDeck();
    } finally {
      setMaking(false);
    }
  };
  return (
    <div data-testid="first-run" className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="text-xs text-muted-foreground">
        Nothing opened yet: say above what a deck is about and create it, or drop a folder, a deck or a PowerPoint file
        on this window.
      </p>
      <Button size="lg" busy={making} onClick={() => void openExample()}>
        {!making && <Presentation />}
        Open an example deck
      </Button>
    </div>
  );
}

/**
 * Whether an agent is installed, which writing decks takes: quietly so when one is, and how to
 * get one when none is. Checked again when the window comes back to the front (after installing).
 */
function AgentCheck() {
  const providers = useApp((s) => s.providers);
  useEffect(() => {
    if (useApp.getState().providers === undefined) void useApp.getState().refreshProviders({ quiet: true });
    const onFocus = () => void useApp.getState().refreshProviders({ quiet: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  if (providers === undefined) return null;
  const installed = PROVIDER_IDS.filter((id) => providers.some((p) => p.id === id && p.installed));
  if (installed.length > 0) {
    return (
      <p data-testid="agent-check" className="-mt-5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <CheckCircle2 className="size-3.5 text-success" />
        {installed.map((id) => PROVIDERS[id].cli).join(", ")} {installed.length > 1 ? "are" : "is"} ready to write your
        decks.
      </p>
    );
  }
  return (
    <div
      role="alert"
      data-testid="agent-check"
      className="-mt-4 flex gap-2 rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs leading-relaxed text-warning"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">No agent is installed yet. SlopSlide needs one to write your decks.</p>
        {PROVIDER_IDS.map((id) => (
          <p key={id}>
            <span className="font-medium">{PROVIDERS[id].cli}:</span> <InstallHint text={PROVIDERS[id].install} />
          </p>
        ))}
        <p className="text-foreground">You can still create, edit and present decks by hand.</p>
      </div>
    </div>
  );
}

/**
 * The decks there are, as pictures of their first slides, the one changed or opened last first:
 * each with its title, its folder and when it last changed. With more than a few, a field finds
 * one by its title or folder. `onChanged` reads them again after one was renamed, copied, moved
 * to the trash or taken off the recent ones.
 */
function DeckGallery({ decks, onChanged }: { decks: GalleryDeck[]; onChanged: () => void }) {
  const [query, setQuery] = useState("");
  const shown = matchingDecks(decks, query);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <SectionLabel as="h2">Your decks</SectionLabel>
        <span className="flex-1" />
        {decks.length > FILTER_FROM && (
          <label className="flex h-7 w-56 items-center gap-1.5 rounded-md border bg-card px-2 text-xs focus-within:border-input focus-within:ring-2 focus-within:ring-primary/20">
            <Search className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              type="search"
              aria-label="Find a deck"
              placeholder="Find a deck"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
              className="min-w-0 flex-1 bg-transparent outline-none"
            />
          </label>
        )}
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">No deck’s title or folder has “{query}” in it.</p>
      ) : (
        <ul aria-label="Your decks" className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-4">
          {shown.map((deck) => (
            <DeckCard key={deck.path} deck={deck} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Where a deck is, as a card says it: the folder it is in, or the one around its own. */
function folderOf(path: string): string {
  const folder = dirname(path);
  return basename(path) === "deck.html" ? `${basename(dirname(folder))} / ${basename(folder)}` : basename(folder);
}

/**
 * One deck on the start screen: its first slide (loaded once the card is near the view, a few
 * at a time), its title, its folder and when it last changed. A press opens it; its menu (the
 * "…" button, or a right-click) renames, copies, reveals it or moves it to the trash.
 */
function DeckCard({ deck, onChanged }: { deck: GalleryDeck; onChanged: () => void }) {
  const { open, setOpen, ref } = useDropdown<HTMLLIElement>();
  const menu = useMenuKeys();
  const [renaming, setRenaming] = useState(false);
  const title = deck.title || "Untitled";
  const changed = Math.max(deck.modifiedMs, deck.openedMs ?? 0);
  const app = useApp.getState;

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const run = async (action: () => Promise<unknown>) => {
    await action();
    onChanged();
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a right-click opens the card's menu, which its "…" button also opens.
    <li
      ref={ref}
      className="group relative flex flex-col gap-1.5"
      onContextMenu={(event) => {
        event.preventDefault();
        setOpen(true);
      }}
    >
      <button
        type="button"
        aria-label={`Open ${title}`}
        title={deck.path}
        onClick={() => void app().openDeckFile(deck.path, deck.workspace)}
        className="overflow-hidden rounded-lg shadow-thumbnail ring-1 ring-border transition hover:ring-2 hover:ring-primary"
      >
        <SlideImage
          deckId={deck.path}
          slideId="#1"
          version={String(deck.modifiedMs)}
          lazy
          size={pixelsOf(deck)}
          className="pointer-events-none bg-paper"
        />
      </button>
      <div className="flex min-w-0 items-start gap-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {renaming ? (
            <TitleField
              aria-label="Deck title"
              title={title}
              selectOnMount
              onCommit={async (next) => {
                try {
                  await api.renameDeck(deck.path, next);
                  onChanged();
                  return true;
                } catch (error) {
                  showError(error, { doing: "Could not rename the deck" });
                  return false;
                }
              }}
              onDone={() => setRenaming(false)}
              onCancel={() => setRenaming(false)}
              className="h-6 w-full text-sm font-medium"
            />
          ) : (
            <span className="truncate text-sm font-medium" title={title}>
              {title}
            </span>
          )}
          <span className="flex min-w-0 gap-1 text-2xs text-muted-foreground">
            <span className="truncate" title={dirname(deck.path)}>
              {folderOf(deck.path)}
            </span>
            <span className="shrink-0">· {relativeTime(changed)}</span>
          </span>
        </div>
        <ToolButton
          variant="panel"
          label={`More for ${title}`}
          title="Open, rename, duplicate or move to the trash"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn("shrink-0 opacity-60 focus-visible:opacity-100 group-hover:opacity-100", open && "opacity-100")}
        >
          <MoreHorizontal />
        </ToolButton>
      </div>
      {open && (
        <div
          role="menu"
          {...menu}
          className="enter-below absolute top-full right-0 z-dropdown mt-1 w-56 rounded-lg border bg-card p-1 shadow-popover outline-none"
        >
          <MenuItem
            icon={Presentation}
            label="Open"
            onClick={choose(() => void app().openDeckFile(deck.path, deck.workspace))}
          />
          <MenuItem icon={PencilLine} label="Rename…" onClick={choose(() => setRenaming(true))} />
          <MenuItem
            icon={Copy}
            label="Duplicate"
            hint={`A copy beside it, called “${title} copy”`}
            onClick={choose(() => void run(() => app().duplicateDeck(deck.path)))}
          />
          <MenuItem icon={FolderSearch} label={revealLabel} onClick={choose(() => void revealItemInDir(deck.path))} />
          {deck.openedMs !== null && (
            <MenuItem
              icon={X}
              label="Remove from recent decks"
              hint="The deck itself stays where it is"
              onClick={choose(() => void run(() => api.forgetDeck(deck.path).catch((error) => showError(error))))}
            />
          )}
          <hr className="my-1 border-border" />
          <MenuItem
            icon={Trash2}
            label={`Move to ${trashName}…`}
            onClick={choose(() => void run(() => app().trashDeck(deck.path, title)))}
          />
        </div>
      )}
    </li>
  );
}

/**
 * A folder opened before: its name over where it is, and how long ago it was opened.
 * The button at its end takes it off the list; dimmed until the row is pointed at or it has
 * the focus.
 */
function RecentRow(props: {
  icon: ReactNode;
  name: string;
  detail: string;
  openedMs: number;
  onOpen: () => void;
  removeLabel: string;
  onRemove: () => void;
}) {
  return (
    <li className="group flex items-center">
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left hover:bg-accent"
      >
        {props.icon}
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{props.name}</span>
          <span className="truncate text-xs text-muted-foreground">{props.detail}</span>
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relativeTime(props.openedMs)}</span>
      </button>
      <ToolButton
        variant="panel"
        label={props.removeLabel}
        title="Remove from this list"
        onClick={props.onRemove}
        className="mr-1.5 opacity-40 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X className="size-3.5" />
      </ToolButton>
    </li>
  );
}

/**
 * A new deck, created in the open workspace: what it is about (which goes to the agent as the
 * deck's first chat message, and names the deck unless a title is typed), an optional title,
 * and its style, which can be left to the agent. Enter creates it (Shift+Enter starts a new
 * line); "Start with an empty deck" makes one with nothing asked. `beforeCreate` gets a
 * workspace open first (false stops the creation). While the deck is being created, or while
 * `disabled`, the form takes no input, so it is not sent twice. Only the start screen's form
 * takes the focus as it shows (`autoFocus`): in a workspace, the focus stays where it is, in the
 * chat, say.
 */
export function NewDeckForm(props: {
  heading: string;
  hint?: string;
  beforeCreate?: () => Promise<boolean>;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [about, setAbout] = useState("");
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Set at once, where the state only shows on the next render. */
  const busy = useRef(false);
  const empty = !about.trim() && !title.trim();

  const create = async (asked: string, named: string) => {
    if (busy.current || props.disabled) return;
    busy.current = true;
    setCreating(true);
    try {
      if (props.beforeCreate && !(await props.beforeCreate())) return;
      await useApp.getState().createDeck(named, template, asked);
    } finally {
      busy.current = false;
      setCreating(false);
    }
  };

  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!empty) void create(about, title);
  };

  return (
    <form onSubmit={submit} aria-busy={creating || undefined} className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{props.heading}</h1>
      <fieldset disabled={creating || props.disabled} className="flex min-w-0 flex-col gap-2">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">What is the deck about?</span>
          <textarea
            autoFocus={props.autoFocus}
            rows={2}
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
            }}
            placeholder="Say what it is for, who it is for and how many slides: the agent writes it"
            className="min-h-16 resize-none rounded-lg border bg-card px-3 py-2 text-sm outline-none focus:border-input focus:ring-2 focus:ring-primary/20"
          />
        </label>
        {!about && (
          <div className="flex flex-wrap gap-1.5">
            {DECK_IDEAS.map((idea) => (
              <button
                key={idea}
                type="button"
                onClick={() => setAbout(idea)}
                className="max-w-full truncate rounded-full border bg-card px-2.5 py-0.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {idea}
              </button>
            ))}
          </div>
        )}
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Title (optional)</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="From what it is about, until you or the agent rename it"
              className="h-10 rounded-lg border bg-card px-3 text-sm outline-none focus:border-input focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <div className="flex flex-col gap-1">
            {/* The button names itself; this is the same name for the eye. */}
            <span aria-hidden className="text-xs font-medium text-muted-foreground">
              Style
            </span>
            <StyleChoice value={template} onChange={setTemplate} />
          </div>
          <Button
            type="submit"
            variant="primary"
            size="3xl"
            busy={creating}
            disabled={empty}
            title={empty ? "Say what the deck is about, or give it a title" : undefined}
          >
            {creating ? (
              "Creating…"
            ) : (
              <>
                <Plus />
                Create deck
              </>
            )}
          </Button>
        </div>
      </fieldset>
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {props.hint}
        <Button
          variant="ghost"
          size="sm"
          disabled={creating || props.disabled}
          onClick={() => void create("", UNTITLED_DECK)}
          className="font-medium text-foreground"
        >
          Start with an empty deck
        </Button>
      </p>
    </form>
  );
}
