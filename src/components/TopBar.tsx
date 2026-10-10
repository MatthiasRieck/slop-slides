import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, X } from "lucide-react";

import { basename, cn, isMac } from "../lib/utils";
import { useApp } from "../store";

/**
 * The workspace's bar: the slide rail toggle (for a deck), breadcrumbs from the workspace folder
 * to the open file, then revealing and closing the file (back to the workspace) and the sidebar toggle.
 * The deck's own tools live in the toolbar above the slides (DeckToolbar).
 */
export function TopBar() {
  const workspace = useApp((s) => s.workspace);
  const hasDeck = useApp((s) => s.deck !== null);
  const openedFile = useApp((s) => s.openedFile);
  if (!workspace) return null;

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-12 shrink-0 items-center gap-1 border-b bg-background pr-3",
        isMac ? "pl-[84px]" : "pl-3",
      )}
    >
      {hasDeck && <RailToggle />}
      <Breadcrumbs workspace={workspace.name} path={openedFile?.path ?? null} />
      <div data-tauri-drag-region className="flex-1 self-stretch" />
      {openedFile && (
        <>
          <RevealButton path={openedFile.absolute} />
          <button
            type="button"
            onClick={() => void useApp.getState().closeDeck()}
            title={`Close ${basename(openedFile.path)}`}
            aria-label={`Close ${basename(openedFile.path)}`}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </>
      )}
      <SidebarToggle />
    </header>
  );
}

/** The workspace folder, then each folder of the open file's path, then the file. */
function Breadcrumbs({ workspace, path }: { workspace: string; path: string | null }) {
  const crumbs = [workspace, ...(path ? path.split("/").filter(Boolean) : [])];
  return (
    <nav aria-label="Breadcrumbs" title={path ?? workspace} className="flex min-w-0 items-center gap-1 px-1.5 text-sm">
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={i} className={cn("flex items-center gap-1", last ? "min-w-0" : "shrink-0")}>
            {i > 0 && <span className="text-muted-foreground/40">/</span>}
            <span
              aria-current={last ? "page" : undefined}
              className={cn("truncate", last ? "font-medium text-foreground" : "max-w-40 text-muted-foreground")}
            >
              {crumb}
            </span>
          </span>
        );
      })}
    </nav>
  );
}

function RevealButton({ path }: { path: string }) {
  return (
    <button
      type="button"
      onClick={() => void revealItemInDir(path)}
      title={isMac ? "Show in Finder" : "Show in folder"}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <FolderOpen className="size-4" />
    </button>
  );
}

/** Shows or hides the slide rail on the left. */
function RailToggle() {
  const railOpen = useApp((s) => s.railOpen);
  const Icon = railOpen ? PanelLeftClose : PanelLeftOpen;
  const label = railOpen ? "Hide slides" : "Show slides";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={railOpen}
      onClick={() => useApp.getState().setRailOpen(!railOpen)}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-4" />
    </button>
  );
}

/** Shows or hides the sidebar (chat, files) on the right. */
function SidebarToggle() {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const Icon = sidebarOpen ? PanelRightClose : PanelRightOpen;
  const label = sidebarOpen ? "Hide sidebar" : "Show sidebar";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={sidebarOpen}
      onClick={() => useApp.getState().setSidebarOpen(!sidebarOpen)}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-4" />
    </button>
  );
}
