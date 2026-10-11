import { open } from "@tauri-apps/plugin-dialog";
import { Folder, FolderOpen, Library, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { api, errorMessage, type RecentWorkspace } from "../lib/api";
import { cn, isMac, relativeTime } from "../lib/utils";
import { useApp } from "../store";
import { TemplateSelect } from "./Templates";

/** Asks for a folder and opens it as the workspace. */
export async function chooseWorkspace() {
  const path = await open({ directory: true, title: "Open a folder" });
  if (path && !Array.isArray(path)) await useApp.getState().openWorkspace(path);
}

/** The start screen: open a folder (or one opened before), or start a deck in the library. */
export function Home() {
  const [recent, setRecent] = useState<RecentWorkspace[] | null>(null);

  const refresh = () =>
    api
      .recentWorkspaces()
      .then((list) => setRecent(Array.isArray(list) ? list : []))
      .catch((error) => useApp.getState().setError(errorMessage(error)));

  useEffect(() => {
    void refresh();
  }, []);

  const openLibrary = async () => {
    try {
      await useApp.getState().openWorkspace(await api.libraryFolder());
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  const forget = async (workspace: RecentWorkspace) => {
    try {
      await api.forgetWorkspace(workspace.path);
      await refresh();
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header data-tauri-drag-region className={cn("flex h-12 shrink-0 items-center", isMac ? "pl-[84px]" : "pl-4")}>
        <span data-tauri-drag-region className="text-sm font-semibold tracking-tight">
          SlopSlide
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-10">
          <NewDeckForm
            heading="What are you presenting?"
            hint="New decks start in your SlopSlide library. Open a folder to work on the decks in it."
            beforeCreate={async () => {
              await openLibrary();
              return useApp.getState().workspace !== null;
            }}
          />

          <section className="flex flex-col gap-2">
            <h2 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Open</h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void chooseWorkspace()}
                className="flex h-9 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm font-medium hover:bg-accent"
              >
                <FolderOpen className="size-4" />
                Open folder…
              </button>
              <button
                type="button"
                onClick={() => void openLibrary()}
                className="flex h-9 items-center gap-1.5 rounded-lg border bg-card px-3 text-sm font-medium hover:bg-accent"
              >
                <Library className="size-4" />
                SlopSlide library
              </button>
            </div>
          </section>

          {recent && recent.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Recent folders</h2>
              <ul className="flex flex-col divide-y rounded-lg border bg-card">
                {recent.map((workspace) => (
                  <li key={workspace.path} className="group flex items-center">
                    <button
                      type="button"
                      onClick={() => void useApp.getState().openWorkspace(workspace.path)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left hover:bg-accent"
                    >
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-sm font-medium">{workspace.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{workspace.path}</span>
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{relativeTime(workspace.openedMs)}</span>
                    </button>
                    <button
                      type="button"
                      title="Remove from recent folders"
                      aria-label={`Remove ${workspace.name} from recent folders`}
                      onClick={() => void forget(workspace)}
                      className="mr-1.5 rounded-md p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus:opacity-100 group-hover:opacity-100"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * Title and template for a new deck, created in the open workspace. `beforeCreate` gets a
 * workspace open first (false stops the creation).
 */
export function NewDeckForm(props: { heading: string; hint?: string; beforeCreate?: () => Promise<boolean> }) {
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState<string | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (props.beforeCreate && !(await props.beforeCreate())) return;
    await useApp.getState().createDeck(title.trim() || "Untitled deck", template);
  };

  return (
    <form onSubmit={create} className="flex flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{props.heading}</h1>
      <div className="flex gap-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Deck title, e.g. Series A pitch"
          className="h-10 flex-1 rounded-lg border bg-card px-3 text-sm outline-none focus:border-input focus:ring-2 focus:ring-primary/20"
        />
        <TemplateSelect value={template} onChange={setTemplate} />
        <button
          type="submit"
          className="flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="size-4" />
          New deck
        </button>
      </div>
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
    </form>
  );
}
