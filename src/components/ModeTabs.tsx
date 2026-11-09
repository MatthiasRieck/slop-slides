import { Eye, GitCompare, Pencil, Play } from "lucide-react";
import { useEffect } from "react";

import { useChanges } from "../changesStore";
import { cn } from "../lib/utils";
import { type DeckMode, deckMode, useApp } from "../store";

/** The modes with a tab. Settings opens from the file menu instead (TopBar). */
type TabMode = Exclude<DeckMode, "settings">;

const MODES: { id: TabMode; label: string; icon: typeof Eye }[] = [
  { id: "view", label: "View", icon: Eye },
  { id: "edit", label: "Edit", icon: Pencil },
  { id: "play", label: "Play", icon: Play },
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
 * to the row under it. The slide's narration and notes and the deck's HTML are tabs of the sidebar.
 */
export function ModeTabs() {
  const mode = useApp(deckMode);
  const hasSlide = useApp((s) => s.deck?.slides.some((slide) => slide.id === s.selected) ?? false);
  const locked = useApp((s) => !!s.deck?.slides.find((slide) => slide.id === s.selected)?.locked);
  const inRepository = useInRepository();

  const titles: Record<TabMode, string> = {
    view: "Show the slide, mark it up and comment on it; marks and comments go to the agent with your next message",
    edit: locked
      ? "This slide is locked; unlock it in the slide list to edit it"
      : "Edit the slide: click to select, drag to move, drag the handles to resize or rotate, double-click to edit text, drop images onto it to add them",
    play: "Play the deck on its timeline, as a video or a self-running show does, and set how long each slide shows and when its narration starts",
    git: "See what changed since the last commit, and compare each slide before and after",
  };
  const modes = MODES.filter(({ id }) => id !== "git" || inRepository);

  return (
    <div role="tablist" aria-label="Mode" className="flex items-center gap-1 self-stretch">
      {modes.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          title={titles[id]}
          disabled={(id === "edit" && (!hasSlide || locked)) || (id === "play" && !hasSlide)}
          onClick={() => useApp.getState().setMode(id)}
          className={cn(
            "flex min-w-14 flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
            mode === id && "text-primary hover:text-primary",
          )}
        >
          <Icon className="size-5" strokeWidth={1.75} />
          {label}
        </button>
      ))}
    </div>
  );
}
