import { CaseSensitive, ChevronDown, ChevronUp, Replace, Search, Undo2, WholeWord, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type ReplacedText } from "../lib/api";
import { cn } from "../lib/utils";
import { activeMatch, useApp } from "../store";
import { Popover } from "./Templates";

/** How long typing settles before it searches. */
const SEARCH_DELAY_MS = 150;

/**
 * Searches the text on the deck's slides and in their notes (see src-tauri/src/find.rs), right in
 * View mode's toolbar; ⌘F focuses it, in the app or in the slide. While it holds a query the slide
 * rail lists only the slides with a match and the slide shown highlights them (see
 * `searchHighlight`). The arrows and Enter go through the matches; leaving View ends the search.
 */
export function SlideSearch() {
  const deckId = useApp((s) => s.deck?.id ?? "");
  // Searches again whenever a slide changes, as after a replace.
  const version = useApp((s) => s.deck?.slides.map((slide) => slide.hash).join(",") ?? "");
  const query = useApp((s) => s.search.query);
  const options = useApp((s) => s.search.options);
  const matches = useApp((s) => s.search.matches);
  const active = useApp(activeMatch);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => {
      input.current?.focus();
      input.current?.select();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!isFind(event.key, event.metaKey || event.ctrlKey, event.shiftKey, event.altKey)) return;
      event.preventDefault();
      focus();
    };
    // The slide preview forwards the keys pressed in it.
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "slop:key" && isFind(String(data.key), !!data.mod, !!data.shift)) focus();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  useEffect(() => useApp.getState().clearSearch, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` changes with the slides' text
  useEffect(() => {
    if (!deckId || !query.trim()) return;
    const { setSearchMatches } = useApp.getState();
    let live = true;
    const timer = setTimeout(() => {
      api
        .findInDeck(deckId, query, options)
        .then((found) => live && setSearchMatches(Array.isArray(found) ? found : []))
        .catch(() => live && setSearchMatches([]));
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [deckId, query, options, version]);

  const { setSearch, stepSearch } = useApp.getState();
  const found = matches?.length ?? 0;
  const slideCount = new Set(matches?.map((m) => m.slide)).size;
  const step = "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30";

  return (
    <search className="flex min-w-0 items-center gap-0.5">
      <div className="flex h-7 w-72 min-w-0 items-center gap-1 rounded-md border pl-2 pr-0.5 focus-within:ring-1 focus-within:ring-ring">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={input}
          aria-label="Search slides"
          placeholder="Search slides"
          title="Search the text on the slides and in their notes (⌘F)"
          value={query}
          onChange={(event) => setSearch({ query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              stepSearch(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              setSearch({ query: "" });
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
        {matches && (
          <span
            role="status"
            title={`${plural(found, "match", "matches")} on ${plural(slideCount, "slide", "slides")}`}
            className="shrink-0 text-2xs tabular-nums text-muted-foreground"
          >
            {active >= 0 ? `${active + 1} / ${found}` : found === 0 ? "No matches" : found}
            {active >= 0 && matches[active]?.notes && " in notes"}
          </span>
        )}
        {query && (
          <button
            type="button"
            aria-label="Clear search"
            title="Clear search (Esc)"
            onClick={() => {
              setSearch({ query: "" });
              input.current?.focus();
            }}
            className="rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
          >
            <X />
          </button>
        )}
        <Toggle
          label="Match case"
          active={options.matchCase}
          onClick={() => setSearch({ options: { ...options, matchCase: !options.matchCase } })}
        >
          <CaseSensitive />
        </Toggle>
        <Toggle
          label="Whole words"
          active={options.wholeWord}
          onClick={() => setSearch({ options: { ...options, wholeWord: !options.wholeWord } })}
        >
          <WholeWord />
        </Toggle>
      </div>
      <button
        type="button"
        aria-label="Previous match"
        title="Previous match (⇧Enter)"
        disabled={found === 0}
        onClick={() => stepSearch(-1)}
        className={step}
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={found === 0}
        onClick={() => stepSearch(1)}
        className={step}
      >
        <ChevronDown className="size-4" />
      </button>
      <ReplaceButton />
    </search>
  );
}

const isFind = (key: string, mod: boolean, shift: boolean, alt = false) =>
  mod && !shift && !alt && key.toLowerCase() === "f";

/** Opens the replacing of what the search finds. */
function ReplaceButton() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label="Replace"
        title="Replace what the search finds"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4"
      >
        <Replace />
      </button>
      {open && (
        <Popover anchor={anchor} placement="below" width={360} label="Replace" onClose={() => setOpen(false)}>
          <ReplacePanel />
        </Popover>
      )}
    </>
  );
}

function ReplacePanel() {
  const current = useApp((s) => s.selected);
  const query = useApp((s) => s.search.query);
  const options = useApp((s) => s.search.options);
  const matches = useApp((s) => s.search.matches) ?? [];
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ReplacedText | null>(null);

  const replaceable = matches.filter((m) => !m.locked);
  const here = replaceable.filter((m) => m.slide === current);

  const replace = async (slides: string[] | null) => {
    setBusy(true);
    const replaced = await useApp.getState().replaceInDeck(query, replacement, options, slides);
    setBusy(false);
    if (replaced) setDone(replaced);
  };
  const undo = async () => {
    if (!done) return;
    setBusy(true);
    if (await useApp.getState().undoReplace(done)) setDone(null);
    setBusy(false);
  };

  return (
    <div className="flex min-h-0 flex-col gap-2 p-3 text-xs">
      <input
        autoFocus
        aria-label="Replace with"
        placeholder="Replace with"
        value={replacement}
        onChange={(event) => setReplacement(event.target.value)}
        className="h-7 min-w-0 rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
      />
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          disabled={busy || here.length === 0 || !current}
          onClick={() => void replace(current ? [current] : [])}
          className="rounded-md border px-2 py-1 hover:bg-accent disabled:opacity-40"
        >
          Replace on this slide
        </button>
        <button
          type="button"
          disabled={busy || replaceable.length === 0}
          onClick={() => void replace(null)}
          className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
        >
          Replace all
        </button>
      </div>
      {done && (
        <div className="flex items-center gap-2 rounded-md bg-accent px-2 py-1.5">
          <span className="flex-1">
            Replaced {plural(done.count, "match", "matches")} on {plural(done.slides.length, "slide", "slides")}.
            {done.skipped.length > 0 &&
              ` ${plural(done.skipped.length, "locked slide was", "locked slides were")} left as ${done.skipped.length === 1 ? "it was" : "they were"}.`}
          </span>
          {done.count > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void undo()}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-background disabled:opacity-40 [&_svg]:size-3.5"
            >
              <Undo2 />
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Toggle(props: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        "rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4",
        props.active && "bg-accent text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}
