import { CaseSensitive, Lock, TextSearch, Undo2, WholeWord } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type FindMatch, type FindOptions, type ReplacedText } from "../lib/api";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { Popover } from "./Templates";

/** Matches the list shows; the count covers them all. */
const SHOWN = 200;
/** How long typing settles before it searches. */
const SEARCH_DELAY_MS = 150;

/**
 * Find and replace across the deck: the text on its slides and in their notes (see
 * src-tauri/src/find.rs). ⌘F opens it, in the app or in the slide; the HTML view keeps its own
 * search.
 */
export function FindButton() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const isFind = (key: string, mod: boolean, shift: boolean, alt = false) =>
      mod && !shift && !alt && key.toLowerCase() === "f" && useApp.getState().view !== "code";
    const onKey = (event: KeyboardEvent) => {
      if (!isFind(event.key, event.metaKey || event.ctrlKey, event.shiftKey, event.altKey)) return;
      if ((event.target as Element | null)?.closest?.(".cm-editor")) return;
      event.preventDefault();
      setOpen(true);
    };
    // The slide preview forwards the keys pressed in it.
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === "slop:key" && isFind(String(data.key), !!data.mod, !!data.shift)) setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label="Find and replace"
        title="Find and replace in the slides' text (⌘F)"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4"
      >
        <TextSearch />
      </button>
      {open && (
        <Popover anchor={anchor} placement="below" width={400} label="Find and replace" onClose={() => setOpen(false)}>
          <FindPanel />
        </Popover>
      )}
    </>
  );
}

function FindPanel() {
  const deck = useApp((s) => s.deck);
  const current = useApp((s) => s.selected);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [options, setOptions] = useState<FindOptions>({ matchCase: false, wholeWord: false });
  const [matches, setMatches] = useState<FindMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ReplacedText | null>(null);
  const deckId = deck?.id ?? "";
  // Searches again whenever a slide changes, as after a replace.
  const version = deck?.slides.map((s) => s.hash).join(",") ?? "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` changes with the slides' text
  useEffect(() => {
    if (!deckId || !query.trim()) {
      setMatches([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api
        .findInDeck(deckId, query, options)
        .then((found) => live && setMatches(Array.isArray(found) ? found : []))
        .catch(() => live && setMatches([]));
    }, SEARCH_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [deckId, query, options, version]);

  if (!deck) return null;
  const replaceable = matches.filter((m) => !m.locked);
  const here = replaceable.filter((m) => m.slide === current);
  const slideCount = new Set(matches.map((m) => m.slide)).size;

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

  const field =
    "h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-ring";
  return (
    <div className="flex min-h-0 flex-col gap-2 p-3 text-xs">
      <div className="flex items-center gap-1">
        <input
          // biome-ignore lint/a11y/noAutofocus: the panel opens to type what to find
          autoFocus
          aria-label="Find"
          placeholder="Find in slides"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setDone(null);
          }}
          className={field}
        />
        <Toggle
          label="Match case"
          active={options.matchCase}
          onClick={() => setOptions({ ...options, matchCase: !options.matchCase })}
        >
          <CaseSensitive />
        </Toggle>
        <Toggle
          label="Whole words"
          active={options.wholeWord}
          onClick={() => setOptions({ ...options, wholeWord: !options.wholeWord })}
        >
          <WholeWord />
        </Toggle>
      </div>
      <input
        aria-label="Replace with"
        placeholder="Replace with"
        value={replacement}
        onChange={(event) => setReplacement(event.target.value)}
        className={field}
      />
      <div className="flex items-center gap-1">
        <span role="status" className="flex-1 text-muted-foreground">
          {!query.trim()
            ? "Searches the text on every slide and in its notes."
            : matches.length === 0
              ? "No matches"
              : `${plural(matches.length, "match", "matches")} on ${plural(slideCount, "slide", "slides")}`}
        </span>
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
      {matches.length > 0 && (
        <ul aria-label="Matches" className="-mx-1 max-h-72 overflow-y-auto">
          {matches.slice(0, SHOWN).map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: matches have no identity beyond their place
            <li key={i}>
              <button
                type="button"
                onClick={() => useApp.getState().select(m.slide)}
                className={cn(
                  "flex w-full items-baseline gap-2 rounded-md px-1 py-1 text-left hover:bg-accent",
                  m.slide === current && "bg-accent/60",
                )}
              >
                <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{m.index + 1}</span>
                <span className="min-w-0 flex-1 truncate">
                  {m.before}
                  <mark className="rounded-sm bg-amber-200 px-0.5 text-foreground dark:bg-amber-500/40">{m.text}</mark>
                  {m.after}
                </span>
                {m.locked && (
                  <Lock aria-label="Locked: it will not change" className="size-3 shrink-0 text-muted-foreground" />
                )}
              </button>
            </li>
          ))}
        </ul>
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
        "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4",
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
