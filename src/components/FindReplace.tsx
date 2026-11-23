import { CaseSensitive, ChevronDown, ChevronUp, Replace, Search, Undo2, WholeWord, X } from "lucide-react";
import { type FocusEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ReplacedText, Slide } from "../lib/api";
import { formatKeys, isMod } from "../lib/keys";
import { memoizeLast } from "../lib/memo";
import { plural } from "../lib/utils";
import { activeMatch, useApp } from "../store";
import { EDIT_ONLY } from "./editOnly";
import { RibbonRow, useRibbonReveal } from "./Ribbon";

/**
 * Keeps a field's focus from the tooltip around it: a field shows its hint under the pointer
 * only, not for as long as it is typed in.
 */
const quietFocus = (event: FocusEvent) => event.stopPropagation();

/** How long typing settles before it searches. */
const SEARCH_DELAY_MS = 150;

/**
 * The search as View mode's ribbon has it, the two rows of its Find section: the field, and under
 * it the steps through the matches and the replacing (which is Edit mode's, so it is off here).
 *
 * The search itself is the store's (see ../store/search.ts): it finds the text on the deck's
 * slides and in their notes (src-tauri/src/find.rs), and while it holds a query the slide rail
 * lists only the slides with a match and the slide shown highlights them (see `searchHighlight`).
 * It stays as the mode changes between View and Edit, where `FindBar` shows it.
 */
export function SlideSearch() {
  return (
    <search className="flex min-w-0 flex-col gap-0.5">
      <SearchField />
      <RibbonRow>
        <SearchSteps />
      </RibbonRow>
    </search>
  );
}

/**
 * The search in Edit mode, floating over the top right of the stage once it is asked for (⌘F, or
 * the Find button under the slide) or holds a query from View. Closing it ends the search.
 */
export function FindBar() {
  const shown = useApp((s) => s.search.open || s.search.query !== "");
  if (!shown) return null;
  return (
    <search
      aria-label="Find in the slides"
      className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-lg border bg-background p-1 shadow-md"
    >
      <SearchField />
      <SearchSteps />
      <Button
        variant="tool"
        size="icon-xs"
        tooltip="Close the search"
        shortcut="escape"
        onClick={() => useApp.getState().clearSearch()}
      >
        <X />
      </Button>
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
  const reveal = useRibbonReveal();

  useEffect(() => {
    if (!focusAsked) return;
    reveal();
    input.current?.focus();
    input.current?.select();
    useApp.getState().findFocused();
  }, [focusAsked, reveal]);

  const { setSearch, stepSearch, clearSearch } = useApp.getState();
  const found = matches?.length ?? 0;
  const slideCount = new Set(matches?.map((m) => m.slide)).size;

  return (
    <InputGroup className="h-6 w-64 rounded-md">
      <InputGroupAddon className="py-0 pl-1.5">
        <Search className="size-3.5" />
      </InputGroupAddon>
      <Tooltip>
        <TooltipTrigger render={<span className="flex h-full min-w-0 flex-1" />}>
          <InputGroupInput
            ref={input}
            aria-label="Search slides"
            placeholder="Search slides"
            value={query}
            onChange={(event) => setSearch({ query: event.target.value })}
            onFocus={quietFocus}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepSearch(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                clearSearch();
              }
            }}
            className="h-full px-1.5 py-0 text-xs"
          />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Search the text on the slides and in their notes
          <Kbd>{formatKeys("mod+f")}</Kbd>
        </TooltipContent>
      </Tooltip>
      <InputGroupAddon align="inline-end" className="gap-0.5 py-0 pr-0.5 font-normal">
        {failed !== null ? (
          <span role="alert" title={failed} className="shrink-0 text-2xs text-destructive">
            Search failed
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
          <InputGroupButton
            size="icon-xs"
            aria-label="Clear search"
            tooltip="Clear search"
            shortcut="escape"
            onClick={() => {
              setSearch({ query: "" });
              input.current?.focus();
            }}
            className="size-5"
          >
            <X className="size-3.5" />
          </InputGroupButton>
        )}
        <InputGroupButton
          size="icon-xs"
          aria-label="Match case"
          tooltip="Match case"
          aria-pressed={options.matchCase}
          onClick={() => setSearch({ options: { ...options, matchCase: !options.matchCase } })}
          className="size-5"
        >
          <CaseSensitive />
        </InputGroupButton>
        <InputGroupButton
          size="icon-xs"
          aria-label="Whole words"
          tooltip="Whole words"
          aria-pressed={options.wholeWord}
          onClick={() => setSearch({ options: { ...options, wholeWord: !options.wholeWord } })}
          className="size-5"
        >
          <WholeWord />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

/** The steps to the match before and after the one in focus, and the way to replace them. */
function SearchSteps() {
  const found = useApp((s) => s.search.matches?.length ?? 0);
  const { stepSearch } = useApp.getState();
  return (
    <>
      <Button
        variant="tool"
        size="icon-xs"
        tooltip="Previous match"
        shortcut="shift+enter"
        disabled={found === 0}
        onClick={() => stepSearch(-1)}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="tool"
        size="icon-xs"
        tooltip="Next match"
        shortcut="enter"
        disabled={found === 0}
        onClick={() => stepSearch(1)}
      >
        <ChevronDown />
      </Button>
      <ReplaceButton />
    </>
  );
}

const isFind = (key: string, mod: boolean, shift: boolean, alt = false) =>
  mod && !shift && !alt && key.toLowerCase() === "f";

/**
 * ⌘F, in the app or in the slide (whose preview forwards the keys pressed in it), brings the
 * search up, in View and in Edit. Pressed in the HTML tab's editor it is that editor's own search.
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

/** Opens the replacing of what the search finds. It changes the slides, so it is Edit mode's. */
function ReplaceButton() {
  const editable = useApp((s) => s.editing);
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  if (!editable && open) setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="tool"
            size="icon-xs"
            aria-label="Replace…"
            tooltip={editable ? "Replace what the search finds" : EDIT_ONLY}
            disabled={!editable}
          />
        }
      >
        <Replace />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Replace"
        side="bottom"
        align="end"
        initialFocus={field}
        className="w-[380px] gap-2 p-3 text-xs"
      >
        <ReplacePanel field={field} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * What to replace the matches with, and which of them: the one in focus (then on to the next),
 * those on the slide shown, or all. Locked slides keep theirs, which it says.
 */
function ReplacePanel(props: { field: React.RefObject<HTMLInputElement | null> }) {
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
    <>
      <Tooltip>
        <TooltipTrigger render={<span className="flex" />}>
          <Input
            ref={props.field}
            size="sm"
            aria-label="Replace with"
            placeholder="Replace with"
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            onFocus={quietFocus}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (isMod(event)) replaceAll();
              else replaceOne();
            }}
          />
        </TooltipTrigger>
        <TooltipContent>
          <Kbd>{formatKeys("enter")}</Kbd> replaces this match, <Kbd>{formatKeys("mod+enter")}</Kbd> all of them
        </TooltipContent>
      </Tooltip>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Button
          variant="outline"
          size="xs"
          disabled={busy || !canReplaceOne}
          {...(canReplaceOne
            ? { tooltip: "Replace this match and go to the next", shortcut: "enter" }
            : { tooltip: inFocus ? "This match is on a locked slide" : "Go to a match first" })}
          onClick={replaceOne}
        >
          Replace
        </Button>
        <Button variant="outline" size="xs" disabled={busy || here.length === 0} onClick={replaceHere}>
          Replace on this slide ({here.length})
        </Button>
        <Button
          size="xs"
          disabled={busy || replaceable.length === 0}
          tooltip="Replace every match"
          shortcut="mod+enter"
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
            <Button
              variant="ghost"
              size="2xs"
              disabled={busy}
              onClick={() => void undo()}
              className="hover:bg-background"
            >
              <Undo2 data-icon="inline-start" />
              Undo
            </Button>
          )}
        </div>
      )}
    </>
  );
}
