import { AudioLines, Code2, Eye, Pencil, StickyNote } from "lucide-react";

import { basename, cn } from "../lib/utils";
import { type DeckMode, deckMode, useApp } from "../store";

const MODES: { id: DeckMode; label: string; icon: typeof Eye }[] = [
  { id: "view", label: "View", icon: Eye },
  { id: "edit", label: "Edit", icon: Pencil },
  { id: "narration", label: "Narration", icon: AudioLines },
  { id: "notes", label: "Notes", icon: StickyNote },
  { id: "code", label: "HTML", icon: Code2 },
];

/** The deck's modes, in the top bar. Each brings its own tools to the row under it. */
export function ModeTabs() {
  const mode = useApp(deckMode);
  const hasSlide = useApp((s) => s.deck?.slides.some((slide) => slide.id === s.selected) ?? false);
  const locked = useApp((s) => !!s.deck?.slides.find((slide) => slide.id === s.selected)?.locked);
  const narrated = useApp((s) => !!s.deck?.slides.find((slide) => slide.id === s.selected)?.narration);
  const codeDirty = useApp((s) => s.codeDirty);
  const file = useApp((s) => basename(s.deck?.id ?? ""));

  const titles: Record<DeckMode, string> = {
    view: "Show the slide, mark it up and comment on it; marks and comments go to the agent with your next message",
    edit: locked
      ? "This slide is locked; unlock it in the slide list to edit it"
      : "Edit the slide: click to select, drag to move, drag the handles to resize or rotate, double-click to edit text, drop images onto it to add them",
    narration: narrated ? "Show this slide's narration" : "Write narration for this slide",
    notes: "Write speaker notes for this slide; only the presenter sees them",
    code: `Show ${file}, scrolled to the selected slide`,
  };
  const needsSlide = (id: DeckMode) => id === "edit" || id === "narration" || id === "notes";

  return (
    <div role="tablist" aria-label="Mode" className="flex items-center rounded-md border bg-muted p-0.5">
      {MODES.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          title={titles[id]}
          disabled={(needsSlide(id) && !hasSlide) || (id === "edit" && locked)}
          onClick={() => useApp.getState().setMode(id)}
          className={cn(
            "flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
            mode === id && "bg-background text-foreground shadow-sm ring-1 ring-border",
          )}
        >
          <Icon className="size-3.5" />
          {label}
          {id === "narration" && narrated && (
            <span data-testid="has-narration" className="size-1.5 rounded-full bg-primary" aria-hidden />
          )}
          {id === "code" && codeDirty && <span title="Unsaved changes" className="size-1.5 rounded-full bg-primary" />}
        </button>
      ))}
    </div>
  );
}
