import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FileUp, Folder, FolderOpen, Library, Plus, Presentation, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { useShellKeys } from "../hooks/useShellKeys";
import { api, type RecentDeck, type RecentWorkspace } from "../lib/api";
import { type Openable, openableOf } from "../lib/opening";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { basename, cn, dirname, isMac, relativeTime } from "../lib/utils";
import { showError, useApp } from "../store";
import { chooseDeck, chooseWorkspace, pickFolder, pickPptx } from "./openDialogs";
import { SECTION_HEADING } from "./styles";
import { TemplateSelect } from "./Templates";

/** The small muted label over a field of the new deck's form. */
const fieldLabel = "text-xs text-muted-foreground";

/**
 * Opens a folder for decks as the workspace: `folder`, or the SlopSlide library (made where it
 * is missing) without one. False when it did not open.
 */
async function openDeckFolder(folder?: string | null): Promise<boolean> {
  try {
    await useApp.getState().openWorkspace(folder ?? (await api.libraryFolder(true)));
  } catch (error) {
    showError(error);
  }
  return useApp.getState().workspace !== null;
}

const openLibrary = () => openDeckFolder();

/**
 * Where the start screen's form creates its deck: the library (`api.libraryFolder`, read again
 * when the settings name another), or the folder `picked` for this deck instead, which
 * `asDefault` makes the library from then on.
 */
function useDeckLocation(enabled: boolean) {
  const saved = useApp((s) => s.settings.libraryFolder);
  const [library, setLibrary] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [asDefault, setAsDefault] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `saved` is why the library is read again
  useEffect(() => {
    if (!enabled) return;
    let gone = false;
    // Without it (the browser preview), the form leaves the path out; creating a deck says why.
    Promise.resolve()
      .then(() => api.libraryFolder())
      .then(
        (path) => !gone && typeof path === "string" && setLibrary(path),
        () => {},
      );
    return () => {
      gone = true;
    };
  }, [enabled, saved]);

  /** The folder picked, while it is another than the library. */
  const custom = picked !== null && picked !== library ? picked : null;

  const change = async () => {
    try {
      const folder = await pickFolder("Choose where to create the deck", custom ?? library);
      if (folder) setPicked(folder);
    } catch (error) {
      showError(error);
    }
  };

  /** Gets the folder open as the workspace, the library first set to it if asked; false when it did not open. */
  const open = async (): Promise<boolean> => {
    if (custom && asDefault) await useApp.getState().updateSettings({ libraryFolder: custom });
    return openDeckFolder(custom);
  };

  return { path: custom ?? library, custom: custom !== null, asDefault, setAsDefault, change, open };
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
  size?: ButtonProps["size"];
  className?: string;
}) {
  const { importing, choose } = props.job;
  const busy = importing !== null;
  return (
    <Button
      variant="outline"
      size={props.size ?? "xs"}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => void choose()}
      className={props.className}
    >
      {busy ? (
        <>
          <Spinner aria-hidden="true" data-icon="inline-start" />
          {`Importing ${importing}…`}
        </>
      ) : (
        <>
          <FileUp data-icon="inline-start" />
          Import PowerPoint…
        </>
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
            hint="The deck gets a folder of its own in this location, named after its title."
            chooseLocation
            disabled={pptx.importing !== null}
            autoFocus
          />

          <section className="flex flex-col gap-2">
            <h2 className={SECTION_HEADING}>Open</h2>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="lg"
                tooltip="Open a folder of decks"
                shortcut={SHELL_SHORTCUTS.openFolder}
                onClick={() => void chooseWorkspace()}
              >
                <FolderOpen data-icon="inline-start" />
                Open folder…
              </Button>
              <Button variant="outline" size="lg" onClick={() => void chooseDeck()}>
                <Presentation data-icon="inline-start" />
                Open deck…
              </Button>
              <Button variant="outline" size="lg" onClick={() => void openLibrary()}>
                <Library data-icon="inline-start" />
                SlopSlide library
              </Button>
              <ImportPptxButton job={pptx} size="lg" />
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
              <h2 className={SECTION_HEADING}>Recent decks</h2>
              <ul aria-label="Recent decks" className={recentList}>
                {decks.map((deck) => (
                  <RecentRow
                    key={deck.path}
                    icon={<Presentation className="text-primary" />}
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
              <h2 className={SECTION_HEADING}>Recent folders</h2>
              <ul aria-label="Recent folders" className={recentList}>
                {folders.map((workspace) => (
                  <RecentRow
                    key={workspace.path}
                    icon={<Folder className="text-muted-foreground" />}
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
      <Item
        size="sm"
        render={<button type="button" onClick={props.onOpen} />}
        className="min-w-0 flex-1 flex-nowrap rounded-none border-0 px-3 py-2 text-left hover:bg-muted"
      >
        <ItemMedia variant="icon" className="translate-y-0! self-center!">
          {props.icon}
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0">
          <ItemTitle className="block w-full truncate">{props.name}</ItemTitle>
          <ItemDescription className="line-clamp-none truncate text-xs">{props.detail}</ItemDescription>
        </ItemContent>
        <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(props.openedMs)}</span>
      </Item>
      <Button
        variant="tool"
        size="icon-xs"
        aria-label={props.removeLabel}
        tooltip="Remove from this list"
        onClick={props.onRemove}
        className="mr-1.5 opacity-40 focus-visible:opacity-100 group-hover:opacity-100"
      >
        <X />
      </Button>
    </li>
  );
}

/** The box around a list of recent decks or folders, a line between its rows. */
const recentList = "flex flex-col divide-y overflow-hidden rounded-lg border bg-card";

/**
 * Title and style for a new deck, created in the open workspace. With `chooseLocation` (the
 * start screen, where no workspace is open) the form also says where the deck goes, the library
 * unless another folder is chosen, and opens that folder first; the deck is not created when it
 * does not open. While the deck is being created, or while
 * `disabled`, the form takes no input, so it is not sent twice. Only the start screen's form
 * takes the focus as it shows (`autoFocus`): in a workspace, the focus stays where it is, in the
 * chat, say.
 */
export function NewDeckForm(props: {
  heading: string;
  hint?: string;
  chooseLocation?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Set at once, where the state only shows on the next render. */
  const busy = useRef(false);
  const titleId = useId();
  const styleId = useId();
  const defaultId = useId();
  const location = useDeckLocation(!!props.chooseLocation);
  const off = creating || props.disabled;

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy.current || props.disabled) return;
    busy.current = true;
    setCreating(true);
    try {
      if (props.chooseLocation && !(await location.open())) return;
      await useApp.getState().createDeck(title.trim() || "Untitled deck", template);
    } finally {
      busy.current = false;
      setCreating(false);
    }
  };

  return (
    <form onSubmit={create} aria-busy={creating || undefined} className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{props.heading}</h1>
      <fieldset disabled={off} className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 items-end gap-2">
          <Field className="min-w-0 flex-1 gap-1">
            <FieldLabel htmlFor={titleId} className={fieldLabel}>
              Title
            </FieldLabel>
            <Input
              id={titleId}
              autoFocus={props.autoFocus}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Deck title, e.g. Series A pitch"
              className="h-10 bg-card px-3"
            />
          </Field>
          <Field className="w-auto gap-1">
            <FieldLabel htmlFor={styleId} className={fieldLabel}>
              Style
            </FieldLabel>
            <TemplateSelect id={styleId} value={template} onChange={setTemplate} disabled={off} />
          </Field>
          <Button type="submit" size="xl" disabled={creating} aria-busy={creating || undefined}>
            {creating ? (
              <>
                <Spinner aria-hidden="true" data-icon="inline-start" />
                Creating…
              </>
            ) : (
              <>
                <Plus data-icon="inline-start" />
                Create deck
              </>
            )}
          </Button>
        </div>
        {props.chooseLocation && (
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn(fieldLabel, "shrink-0")}>Location</span>
              <span
                data-testid="deck-location"
                title={location.path ?? undefined}
                className="selectable min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1 font-mono text-xs"
              >
                {location.path ?? "SlopSlide library"}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                tooltip="Choose another folder for this deck"
                onClick={() => void location.change()}
              >
                <FolderOpen data-icon="inline-start" />
                Change…
              </Button>
            </div>
            {location.custom && (
              <Field orientation="horizontal" className="w-auto gap-1.5">
                <Checkbox
                  id={defaultId}
                  checked={location.asDefault}
                  disabled={off}
                  onCheckedChange={(checked) => location.setAsDefault(checked === true)}
                />
                <FieldLabel htmlFor={defaultId} className="text-xs font-normal">
                  Use this folder for all new decks
                </FieldLabel>
              </Field>
            )}
          </div>
        )}
      </fieldset>
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
    </form>
  );
}
