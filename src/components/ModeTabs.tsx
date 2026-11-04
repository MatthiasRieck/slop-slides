import { AudioLines, Code2, Eye, GitCompare, Pencil, Settings2, StickyNote } from "lucide-react";
import { useEffect } from "react";

import { useChanges } from "../changesStore";
import { basename, cn } from "../lib/utils";
import { type DeckMode, deckMode, useApp } from "../store";

const MODES: { id: DeckMode; label: string; icon: typeof Eye }[] = [
  { id: "view", label: "View", icon: Eye },
  { id: "edit", label: "Edit", icon: Pencil },
  { id: "narration", label: "Narration", icon: AudioLines },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "git", label: "Git", icon: GitCompare },
  { id: "code", label: "HTML", icon: Code2 },
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

/** The deck's modes, in the top bar. Each brings its own tools to the row under it. */
export function ModeTabs() {
  const mode = useApp(deckMode);
  const hasSlide = useApp((s) => s.deck?.slides.some((slide) => slide.id === s.selected) ?? false);
  const locked = useApp((s) => !!s.deck?.slides.find((slide) => slide.id === s.selected)?.locked);
  const narrated = useApp((s) => !!s.deck?.slides.find((slide) => slide.id === s.selected)?.narration);
  const codeDirty = useApp((s) => s.codeDirty);
  const file = useApp((s) => basename(s.deck?.id ?? ""));
  const inRepository = useInRepository();

  const titles: Record<DeckMode, string> = {
    view: "Show the slide, mark it up and comment on it; marks and comments go to the agent with your next message",
    edit: locked
      ? "This slide is locked; unlock it in the slide list to edit it"
      : "Edit the slide: click to select, drag to move, drag the handles to resize or rotate, double-click to edit text, drop images onto it to add them",
    narration: narrated ? "Show this slide's narration" : "Write narration for this slide",
    notes: "Write speaker notes for this slide; only the presenter sees them",
    settings: "Change the slide size and the deck's style",
    git: "See what changed since the last commit, and compare each slide before and after",
    code: `Show ${file}, scrolled to the selected slide`,
  };
  const needsSlide = (id: DeckMode) => id === "edit" || id === "narration" || id === "notes";
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
          disabled={(needsSlide(id) && !hasSlide) || (id === "edit" && locked)}
          onClick={() => useApp.getState().setMode(id)}
          className={cn(
            "flex min-w-14 flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
            mode === id && "text-primary hover:text-primary",
          )}
        >
          <span className="relative">
            <Icon className="size-5" strokeWidth={1.75} />
            {id === "narration" && narrated && (
              <span
                data-testid="has-narration"
                className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-primary"
                aria-hidden
              />
            )}
            {id === "code" && codeDirty && (
              <span title="Unsaved changes" className="absolute -top-0.5 -right-1 size-1.5 rounded-full bg-primary" />
            )}
          </span>
          {label}
        </button>
      ))}
    </div>
  );
}
