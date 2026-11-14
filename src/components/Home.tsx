import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FileUp, Folder, FolderOpen, Library, Plus, Presentation, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { useShellKeys } from "../hooks/useShellKeys";
import { api, type RecentDeck, type RecentWorkspace } from "../lib/api";
import { type Openable, openableOf } from "../lib/opening";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { basename, cn, dirname, isMac, relativeTime } from "../lib/utils";
import { showError, useApp } from "../store";
import { Button, type ButtonSize, ToolButton, withShortcut } from "./Button";
import { chooseDeck, chooseWorkspace, pickPptx } from "./openDialogs";
import { SectionLabel } from "./SectionLabel";
import { TemplateSelect } from "./Templates";

/** Opens the SlopSlide library as the workspace; false when it did not open. */
async function openLibrary(): Promise<boolean> {
  try {
    await useApp.getState().openWorkspace(await api.libraryFolder());
  } catch (error) {
    showError(error);
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
      await useApp.getState().importPptx(path);
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
  decks: RecentDeck[];
  folders: RecentWorkspace[];
}

/**
 * The lists as last read, in this window: coming back to the start screen shows them at once,
 * while they are read again.
 */
let lastRecent: Recent | null = null;

/**
 * The start screen: start a deck in the library, open a folder, a deck in its folder or the
 * library, import a PowerPoint file, or go back to a deck or a folder opened before. A folder, a
 * deck or a PowerPoint file dropped on it opens the same way.
 */
export function Home() {
  const [recent, setRecent] = useState(lastRecent);
  const decks = recent?.decks ?? null;
  const folders = recent?.folders ?? null;
  const pptx = usePptxImport(openLibrary);
  useShellKeys();

  const refresh = () =>
    Promise.all([api.recentDecks(), api.recentWorkspaces()])
      .then(([deckList, folderList]) => {
        lastRecent = {
          decks: Array.isArray(deckList) ? deckList : [],
          folders: Array.isArray(folderList) ? folderList : [],
        };
        setRecent(lastRecent);
      })
      .catch((error) => showError(error));

  // biome-ignore lint/correctness/useExhaustiveDependencies: load the recent lists once on mount
  useEffect(() => {
    void refresh();
  }, []);

  const forget = async (remove: () => Promise<void>) => {
    try {
      await remove();
      await refresh();
    } catch (error) {
      showError(error);
    }
  };

  const openDropped = (dropped: Openable | null) => {
    if (!dropped) return;
    const app = useApp.getState();
    if (dropped.kind === "deck") void app.openDeckFile(dropped.path);
    else if (dropped.kind === "powerpoint") void pptx.importFile(dropped.path);
    else void app.openWorkspace(dropped.path);
  };
  const dragging = useHomeDrops((paths) => openDropped(openableOf(paths)));

  const nothingRecent = decks !== null && folders !== null && decks.length === 0 && folders.length === 0;

  return (
    <div className="relative flex h-full flex-col">
      <header data-tauri-drag-region className={cn("flex h-14 shrink-0 items-center", isMac ? "pl-[84px]" : "pl-4")}>
        <span data-tauri-drag-region className="text-sm font-semibold tracking-tight">
          SlopSlide
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-10">
          <NewDeckForm
            heading="New deck"
            hint="New decks start in your SlopSlide library. Open a folder to work on the decks in it."
            beforeCreate={openLibrary}
            disabled={pptx.importing !== null}
            autoFocus
          />

          <section className="flex flex-col gap-2">
            <SectionLabel as="h2">Open</SectionLabel>
            <div className="flex flex-wrap gap-2">
              <Button
                size="2xl"
                title={withShortcut("Open a folder of decks", SHELL_SHORTCUTS.openFolder)}
                onClick={() => void chooseWorkspace()}
                className="bg-card"
              >
                <FolderOpen />
                Open folder…
              </Button>
              <Button size="2xl" onClick={() => void chooseDeck()} className="bg-card">
                <Presentation />
                Open deck…
              </Button>
              <Button size="2xl" onClick={() => void openLibrary()} className="bg-card">
                <Library />
                SlopSlide library
              </Button>
              <ImportPptxButton job={pptx} size="2xl" className="bg-card" />
            </div>
            {nothingRecent && (
              <p data-testid="first-run" className="text-xs text-muted-foreground">
                Nothing opened yet: name a deck above and create it, or drop a folder, a deck or a PowerPoint file on
                this window.
              </p>
            )}
          </section>

          {decks && decks.length > 0 && (
            <section className="flex flex-col gap-2">
              <SectionLabel as="h2">Recent decks</SectionLabel>
              <ul aria-label="Recent decks" className="flex flex-col divide-y rounded-lg border bg-card">
                {decks.map((deck) => (
                  <RecentRow
                    key={deck.path}
                    icon={<Presentation className="size-4 shrink-0 text-primary" />}
                    name={deck.title || "Untitled"}
                    detail={dirname(deck.path)}
                    openedMs={deck.openedMs}
                    onOpen={() => void useApp.getState().openDeckFile(deck.path, deck.workspace)}
                    removeLabel={`Remove ${deck.title || "Untitled"} from recent decks`}
                    onRemove={() => void forget(() => api.forgetDeck(deck.path))}
                  />
                ))}
              </ul>
            </section>
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

/**
 * A deck or folder opened before: its name over where it is, and how long ago it was opened.
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
 * Title and style for a new deck, created in the open workspace. `beforeCreate` gets a
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
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Set at once, where the state only shows on the next render. */
  const busy = useRef(false);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy.current || props.disabled) return;
    busy.current = true;
    setCreating(true);
    try {
      if (props.beforeCreate && !(await props.beforeCreate())) return;
      await useApp.getState().createDeck(title.trim() || "Untitled deck", template);
    } finally {
      busy.current = false;
      setCreating(false);
    }
  };

  return (
    <form onSubmit={create} aria-busy={creating || undefined} className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{props.heading}</h1>
      <fieldset disabled={creating || props.disabled} className="flex min-w-0 items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Title</span>
          <input
            autoFocus={props.autoFocus}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Deck title, e.g. Series A pitch"
            className="h-10 rounded-lg border bg-card px-3 text-sm outline-none focus:border-input focus:ring-2 focus:ring-primary/20"
          />
        </label>
        <div className="flex flex-col gap-1">
          {/* The select names itself; this is the same name for the eye. */}
          <span aria-hidden className="text-xs font-medium text-muted-foreground">
            Style
          </span>
          <TemplateSelect value={template} onChange={setTemplate} />
        </div>
        <Button type="submit" variant="primary" size="3xl" busy={creating}>
          {creating ? (
            "Creating…"
          ) : (
            <>
              <Plus />
              Create deck
            </>
          )}
        </Button>
      </fieldset>
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
    </form>
  );
}
