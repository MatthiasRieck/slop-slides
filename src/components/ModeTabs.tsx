import { Eye, GitCompare, Pencil } from "lucide-react";
import { useEffect } from "react";

import { Kbd } from "@/components/ui/kbd";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { keepFocus } from "@/lib/focus";
import { useChanges } from "../changesStore";
import { formatKeys } from "../lib/keys";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { type DeckMode, deckMode, useApp } from "../store";
import { selectedSlideLocked } from "../store/chrome";

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
 * their order and their timing. The deck's timeline opens under the slide in either, from the row under it, and the
 * slide's narration and notes and the deck's HTML are tabs of the sidebar. The tab of the mode
 * the deck is in is filled; with the deck's settings open, none is. The arrows go from tab to
 * tab; a click, Enter or Space takes the mode.
 */
export function ModeTabs() {
  const mode = useApp(deckMode);
  const locked = useApp(selectedSlideLocked);
  const inRepository = useInRepository();

  /** One line each: what the mode is for. Its keys follow it in the tooltip. */
  const hints: Record<TabMode, string> = {
    view: "View: present, play and comment",
    edit: locked ? "Edit: this slide is locked; unlock it to change it" : "Edit: change slides, their order and timing",
    git: "Git: see what changed since the last commit",
  };
  const modes = MODES.filter(({ id }) => id !== "git" || inRepository);

  return (
    <Tabs
      value={mode === "settings" ? null : mode}
      onValueChange={(value) => useApp.getState().setMode(value as TabMode)}
      className="justify-center self-stretch"
    >
      <TabsList aria-label="Mode" className="gap-1 bg-transparent p-0 group-data-horizontal/tabs:h-auto">
        {modes.map(({ id, label, icon: Icon }) => (
          <Tooltip key={id}>
            <TooltipTrigger
              render={
                <TabsTrigger
                  value={id}
                  // A press leaves the focus where it is (in the slide, say), as its keys go on working there.
                  onMouseDown={keepFocus}
                  className="h-auto min-w-14 flex-none flex-col gap-0.5 px-2 py-1 text-xs font-normal text-muted-foreground hover:bg-muted data-active:bg-primary/10 data-active:font-medium data-active:text-primary data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-primary/10 dark:data-active:text-primary [&_svg:not([class*='size-'])]:size-5"
                />
              }
            >
              <Icon strokeWidth={1.75} />
              {label}
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {hints[id]}
              <Kbd>{formatKeys(SHELL_SHORTCUTS[id])}</Kbd>
            </TooltipContent>
          </Tooltip>
        ))}
      </TabsList>
    </Tabs>
  );
}
