import { Eye, GitCompare, Pencil } from "lucide-react";
import { useEffect } from "react";

import { useChanges } from "../changesStore";
import { useRovingTabs } from "../hooks/useRovingTabs";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { cn } from "../lib/utils";
import { type DeckMode, deckMode, useApp } from "../store";
import { selectedSlideLocked } from "../store/chrome";
import { keepFocus, withShortcut } from "./Button";

/** The modes with a tab. The deck's settings open from the file menu instead (TopBar). */
type TabMode = Exclude<DeckMode, "settings">;

const MODES: { id: TabMode; label: string; icon: typeof Eye }[] = [
  { id: "view", label: "View", icon: Eye },
  { id: "edit", label: "Edit", icon: Pencil },
  { id: "git", label: "Git", icon: GitCompare },
];

/**
 * Whether the deck is in a git repository, and so has a Git mode. A `git init` shows up on coming
 * back to the window or after the agent's turn, and with the repository gone the mode closes.
 */
function useInRepository() {
  const deck = useApp((s) => s.deck?.id ?? null);
  const running = useApp((s) => s.running);
  const inGitMode = useApp((s) => deckMode(s) === "git");
  const inRepository = useChanges((s) => deck !== null && s.repository === deck);
  // biome-ignore lint/correctness/useExhaustiveDependencies: look again whenever a turn starts or ends
  useEffect(() => {
    if (!deck) return;
    const check = () => void useChanges.getState().checkRepository(deck);
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [deck, running]);
  useEffect(() => {
    if (inGitMode && !inRepository) useApp.getState().setMode("view");
  }, [inGitMode, inRepository]);
  return inRepository;
}

/**
 * The deck's modes, in the top bar: what the stage does with the slide. Each brings its own tools
 * to the row under it. View changes nothing in the deck but its review; Edit changes the slides,
 * their order and their timing. The deck's timeline opens under the slide in either, and the
 * slide's narration and notes and the deck's HTML are tabs of the sidebar. The tab of the mode
 * the deck is in is filled; with the deck's settings open, none is.
 */
export function ModeTabs() {
  const mode = useApp(deckMode);
  const locked = useApp(selectedSlideLocked);
  const inRepository = useInRepository();

  /** One line each: what the mode is for, then the keys that go to it. */
  const titles: Record<TabMode, string> = {
    view: "View: present, play and comment",
    edit: locked ? "Edit: this slide is locked; unlock it to change it" : "Edit: change slides, their order and timing",
    git: "Git: see what changed since the last commit",
  };
  const modes = MODES.filter(({ id }) => id !== "git" || inRepository);
  const tabs = useRovingTabs();

  return (
    <div role="tablist" aria-label="Mode" {...tabs} className="flex items-center gap-1 self-stretch">
      {modes.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          title={withShortcut(titles[id], SHELL_SHORTCUTS[id])}
          // A press leaves the focus where it is (in the slide, say), as its keys go on working there.
          onMouseDown={keepFocus}
          onClick={() => useApp.getState().setMode(id)}
          className={cn(
            "flex min-w-14 flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
            mode === id && "bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary",
          )}
        >
          <Icon className="size-5" strokeWidth={1.75} />
          {label}
        </button>
      ))}
    </div>
  );
}
