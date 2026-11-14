import { CaseSensitive, ChevronDown, ChevronUp, Replace, Search, Undo2, WholeWord, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ReplacedText, Slide } from "../lib/api";
import { formatKeys, isMod } from "../lib/keys";
import { memoizeLast } from "../lib/memo";
import { plural } from "../lib/utils";
import { activeMatch, useApp } from "../store";
import { Button, ToolButton } from "./Button";
import { Popover } from "./Popover";

/** How long typing settles before it searches. */
const SEARCH_DELAY_MS = 150;

/**
 * Find, the one way to search the deck: a bar over the top of the stage, the same in View and in
 * Edit, once it is asked for (⌘F, or the Find button under the slide). It holds the field, the
 * steps through the matches and the replacing. Closing it ends the search.
 *
 * The search itself is the store's (see ../store/search.ts): it finds the text on the deck's
 * slides and in their notes (src-tauri/src/find.rs). While it holds a query the slide shown
 * highlights its matches (see `searchHighlight`) and the slide list marks the slides that have
 * some; every slide stays listed, and the arrow keys outside the bar go through them all.
 *
 * The stage places the bar (see `StageOverlay` in ./Stage.tsx), beside what else floats there;
 * it gives way in width before it would cover it.
 */
export function FindBar() {
  const shown = useApp((s) => s.search.open || s.search.query !== "");
  if (!shown) return null;
  return (
    <search
      aria-label="Find in the slides"
      className="pointer-events-auto ml-auto flex min-w-0 max-w-full items-center gap-1 rounded-lg border bg-background p-1 shadow-md"
    >
      <SearchField />
      <SearchSteps />
      <ToolButton label="Close Find" shortcut="escape" onClick={() => useApp.getState().clearSearch()}>
        <X />
      </ToolButton>
    </search>
  );
}

/**
 * The field the query is typed in, with how many matches there are, or that the search failed,
 * and the options. Enter and ⇧Enter go through the matches; Escape ends the search.
 */
function SearchField() {
  const query = useApp((s) => s.search.query);
  const options = useApp((s) => s.search.options);
  const matches = useApp((s) => s.search.matches);
  const failed = useApp((s) => s.search.failed);
  const focusAsked = useApp((s) => s.search.focusAsked);
  const active = useApp(activeMatch);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusAsked) return;
    input.current?.focus();
    input.current?.select();
    useApp.getState().findFocused();
  }, [focusAsked]);

  const { setSearch, stepSearch, clearSearch } = useApp.getState();
  const found = matches?.length ?? 0;
  const slideCount = new Set(matches?.map((m) => m.slide)).size;

  return (
    <div className="flex h-6 w-64 min-w-20 shrink items-center gap-1 rounded-md border pl-2 pr-0.5 focus-within:ring-1 focus-within:ring-ring">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={input}
        aria-label="Text to find"
        placeholder="Find in slides and notes"
        title={`Find text on the slides and in their notes (${formatKeys("mod+f")})`}
        value={query}
        onChange={(event) => setSearch({ query: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            stepSearch(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            clearSearch();
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none"
      />
      {failed !== null ? (
        <span role="alert" title={failed} className="shrink-0 text-2xs text-destructive">
          Could not search
        </span>
      ) : (
        matches && (
          <span
            role="status"
            title={`${plural(found, "match", "matches")} on ${plural(slideCount, "slide")}`}
            className="shrink-0 text-2xs tabular-nums text-muted-foreground"
          >
            {active >= 0 ? `${active + 1} / ${found}` : found === 0 ? "No matches" : found}
            {active >= 0 && matches[active]?.notes && " in notes"}
          </span>
        )
      )}
      {query && (
        <ToolButton
          size="xs"
          label="Clear the text"
          shortcut="escape"
          onClick={() => {
            setSearch({ query: "" });
            input.current?.focus();
          }}
        >
          <X className="size-3.5" />
        </ToolButton>
      )}
      <ToolButton
        size="xs"
        label="Match case"
        active={options.matchCase}
        onClick={() => setSearch({ options: { ...options, matchCase: !options.matchCase } })}
      >
        <CaseSensitive />
      </ToolButton>
      <ToolButton
        size="xs"
        label="Whole words"
        active={options.wholeWord}
        onClick={() => setSearch({ options: { ...options, wholeWord: !options.wholeWord } })}
      >
        <WholeWord />
      </ToolButton>
    </div>
  );
}

/**
 * The steps to the match before and after the one in focus, and the way to replace them. Past
 * the last match the next one is the first again, and the other way round.
 */
function SearchSteps() {
  const found = useApp((s) => s.search.matches?.length ?? 0);
  const { stepSearch } = useApp.getState();
  return (
    <>
      <ToolButton label="Previous match" shortcut="shift+enter" disabled={found === 0} onClick={() => stepSearch(-1)}>
        <ChevronUp />
      </ToolButton>
      <ToolButton label="Next match" shortcut="enter" disabled={found === 0} onClick={() => stepSearch(1)}>
        <ChevronDown />
      </ToolButton>
      <ReplaceButton />
    </>
  );
}

const isFind = (key: string, mod: boolean, shift: boolean, alt = false) =>
  mod && !shift && !alt && key.toLowerCase() === "f";

/**
 * ⌘F, in the app or in the slide (whose preview forwards the keys pressed in it), brings Find
 * up, in View and in Edit. Pressed in the Code tab's editor it is that editor's own search.
 */
export function useFindShortcut() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isFind(event.key, isMod(event), event.shiftKey, event.altKey)) return;
      if ((event.target as Element | null)?.closest?.(".cm-editor")) return;
      event.preventDefault();
      useApp.getState().openFind();
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "slop:key" && isFind(String(data.key), !!data.mod, !!data.shift)) {
        useApp.getState().openFind();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);
}

/** What the deck's slides hold, as one key: worked out once per list of slides, however often it is asked for. */
const slidesVersion = memoizeLast((slides: Slide[] | undefined) => slides?.map((slide) => slide.hash).join(",") ?? "");

/**
 * Searches the deck for the query in the store once typing settles, and again whenever a slide
 * changes, as after a replace. Leaving the stage (for the deck's settings, say) ends the search.
 */
export function useDeckSearch() {
  const deckId = useApp((s) => s.deck?.id ?? "");
  const version = useApp((s) => slidesVersion(s.deck?.slides));
  const query = useApp((s) => s.search.query);
  const options = useApp((s) => s.search.options);
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are what a search depends on
  useEffect(() => {
    if (!deckId || !query.trim()) return;
    const timer = setTimeout(() => void useApp.getState().runSearch(), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [deckId, query, options, version]);
  useEffect(() => () => useApp.getState().clearSearch(), []);
}

/** Opens the replacing of what Find found, in View and in Edit alike: each replace is one step to undo. */
function ReplaceButton() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <ToolButton
        ref={anchor}
        label="Replace…"
        title="Replace what Find found"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <Replace />
      </ToolButton>
      {open && (
        <Popover
          anchor={anchor}
          placement="below"
          align="end"
          width={380}
          label="Replace"
          onClose={() => setOpen(false)}
        >
          <ReplacePanel />
        </Popover>
      )}
    </>
  );
}

/**
 * What to replace the matches with, and which of them: the one in focus (then on to the next),
 * those on the slide shown, or all. Locked slides keep theirs, which it says.
 */
function ReplacePanel() {
  const current = useApp((s) => s.selected);
  const query = useApp((s) => s.search.query);
  const options = useApp((s) => s.search.options);
  const matches = useApp((s) => s.search.matches) ?? [];
  const active = useApp(activeMatch);
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ReplacedText | null>(null);

  const replaceable = matches.filter((m) => !m.locked);
  const locked = matches.length - replaceable.length;
  const here = replaceable.filter((m) => m.slide === current);
  const inFocus = matches[active];
  const canReplaceOne = !!inFocus && !inFocus.locked;

  const run = async (replace: () => Promise<ReplacedText | null>) => {
    if (busy) return;
    setBusy(true);
    const replaced = await replace();
    setBusy(false);
    if (replaced) setDone(replaced);
  };
  const { replaceInDeck, replaceMatch, undoReplace } = useApp.getState();
  const replaceOne = () => canReplaceOne && void run(() => replaceMatch(replacement));
  const replaceHere = () =>
    current && here.length > 0 && void run(() => replaceInDeck(query, replacement, options, [current]));
  const replaceAll = () => replaceable.length > 0 && void run(() => replaceInDeck(query, replacement, options, null));
  const undo = async () => {
    if (!done) return;
    setBusy(true);
    if (await undoReplace(done)) setDone(null);
    setBusy(false);
  };

  return (
    <div className="flex min-h-0 flex-col gap-2 p-3 text-xs">
      <input
        autoFocus
        aria-label="Replace with"
        placeholder="Replace with"
        title={`${formatKeys("enter")} replaces this match, ${formatKeys("mod+enter")} all of them`}
        value={replacement}
        onChange={(event) => setReplacement(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          if (isMod(event)) replaceAll();
          else replaceOne();
        }}
        className="h-7 min-w-0 rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          disabled={busy || !canReplaceOne}
          title={
            canReplaceOne
              ? `Replace this match and go to the next (${formatKeys("enter")})`
              : inFocus
                ? "This match is on a locked slide"
                : "Go to a match first"
          }
          onClick={replaceOne}
        >
          Replace
        </Button>
        <Button disabled={busy || here.length === 0} onClick={replaceHere}>
          Replace on this slide ({here.length})
        </Button>
        <Button
          variant="primary"
          disabled={busy || replaceable.length === 0}
          title={`Replace every match (${formatKeys("mod+enter")})`}
          onClick={replaceAll}
        >
          Replace all ({replaceable.length})
        </Button>
      </div>
      {locked > 0 && (
        <p data-testid="locked-matches" className="text-2xs text-muted-foreground">
          {plural(locked, "match is", "matches are")} on locked slides, which stay as they are.
        </p>
      )}
      {done && (
        <div data-testid="replaced" className="flex items-center gap-2 rounded-md bg-accent px-2 py-1.5">
          <span className="flex-1">
            Replaced {plural(done.count, "match", "matches")} on {plural(done.slides.length, "slide")}.
            {done.skipped.length > 0 &&
              ` ${plural(done.skipped.length, "locked slide was", "locked slides were")} left as ${done.skipped.length === 1 ? "it was" : "they were"}.`}
          </span>
          {done.count > 0 && (
            <Button variant="ghost" size="xs" disabled={busy} onClick={() => void undo()}>
              <Undo2 />
              Undo
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
