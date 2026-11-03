import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, X } from "lucide-react";

import { basename, cn, isMac } from "../lib/utils";
import { useApp } from "../store";
import { ToolButton } from "./Button";
import { DeckActions } from "./DeckActions";
import { LintStatus } from "./LintStatus";
import { ModeTabs } from "./ModeTabs";

/**
 * The workspace's bar. On the left, the slide rail toggle (for a deck), closing the open file (back
 * to the workspace), its path from the workspace folder with the deck's title under it, and
 * revealing it in the file manager; for a deck, its mode tabs in the middle, then lint, export and
 * present; then the sidebar toggle. The tools of each mode live above the slide (DeckToolbar, Stage).
 */
export function TopBar() {
  const workspace = useApp((s) => s.workspace);
  const hasDeck = useApp((s) => s.deck !== null);
  const deckTitle = useApp((s) => s.deck?.title ?? null);
  const openedFile = useApp((s) => s.openedFile);
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
        {openedFile && (
          <ToolButton
            variant="panel"
            size="md"
            onClick={() => void useApp.getState().closeDeck()}
            title={`Close ${basename(openedFile.path)}`}
            aria-label={`Close ${basename(openedFile.path)}`}
          >
            <X className="size-4" />
          </ToolButton>
        )}
        <div data-tauri-drag-region className="flex min-w-0 flex-col justify-center">
          <Breadcrumbs workspace={workspace.name} path={openedFile?.path ?? null} small={deckTitle !== null} />
          {deckTitle !== null && (
            <h1 data-tauri-drag-region title={deckTitle} className="truncate px-1.5 text-sm font-medium leading-5">
              {deckTitle || "Untitled"}
            </h1>
          )}
        </div>
        {openedFile && <RevealButton path={openedFile.absolute} />}
      </div>
      {hasDeck ? <ModeTabs /> : <div />}
      <div data-tauri-drag-region className="flex items-center justify-end gap-1 self-stretch">
        {hasDeck && (
          <div className="mr-2 flex items-center gap-1">
            <LintStatus />
            <DeckActions />
          </div>
        )}
        <SidebarToggle />
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
    <nav
      aria-label="Breadcrumbs"
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
    </nav>
  );
}

function RevealButton({ path }: { path: string }) {
  return (
    <ToolButton
      variant="panel"
      size="md"
      onClick={() => void revealItemInDir(path)}
      title={isMac ? "Show in Finder" : "Show in folder"}
    >
      <FolderOpen className="size-4" />
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
function SidebarToggle() {
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
