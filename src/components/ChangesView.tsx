import { GitCompare, ListFilter, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useChanges, visibleRows } from "../changesStore";
import type { Deck, DeckChanges, Slide, SlideChange, SlideStatus } from "../lib/api";
import { MAX_FEATHER, normalAngle } from "../lib/compare";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { cn, headSlideUrl } from "../lib/utils";
import { useApp } from "../store";
import { SlideComparison } from "./SlideComparison";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

const STATUS: Record<SlideStatus, { label: string; className: string } | null> = {
  added: { label: "Added", className: "bg-emerald-600" },
  modified: { label: "Modified", className: "bg-amber-600" },
  removed: { label: "Removed", className: "bg-red-600" },
  moved: { label: "Moved", className: "bg-sky-600" },
  unchanged: null,
};

/** Whether the two versions of a slide can differ to the eye. */
function comparable(row: SlideChange, changes: DeckChanges) {
  if (!row.id || !row.oldId) return false;
  return row.status === "modified" || changes.stylesChanged;
}

/** Each row's number in the deck; removed slides have none. */
function slideNumbers(rows: SlideChange[]) {
  const numbers = new Map<string, number>();
  for (const row of rows) if (row.id) numbers.set(row.key, numbers.size + 1);
  return numbers;
}

/** The left of Git mode: the slides, with the removed ones in between, marked by what changed. */
export function ChangesRail() {
  const deck = useApp((s) => s.deck);
  const changes = useChanges((s) => (s.deck === deck?.id ? s.changes : null));
  const onlyChanges = useChanges((s) => s.onlyChanges);
  if (!deck) return null;
  const slides = changes?.slides ?? [];
  const numbers = slideNumbers(slides);
  const rows = visibleRows({ changes, onlyChanges });
  const count = (status: SlideStatus) => slides.filter((row) => row.status === status).length;
  const counts = (["modified", "added", "removed", "moved"] as const).filter((status) => count(status) > 0);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <span className="truncate text-2xs font-medium uppercase tracking-wide text-muted-foreground">Changes</span>
        <div className="flex items-center gap-1">
          {counts.map((status) => (
            <span
              key={status}
              title={`${count(status)} ${STATUS[status]?.label.toLowerCase()}`}
              className={cn("rounded px-1 text-2xs font-medium tabular-nums text-white", STATUS[status]?.className)}
            >
              {count(status)}
            </span>
          ))}
          <button
            type="button"
            title={onlyChanges ? "Show every slide" : "Show only the slides that changed"}
            aria-pressed={onlyChanges}
            onClick={() => useChanges.getState().setOnlyChanges(!onlyChanges)}
            className={cn(
              "rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground",
              onlyChanges && "bg-accent text-foreground",
            )}
          >
            <ListFilter className="size-4" />
          </button>
        </div>
      </div>
      <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4 pt-1.5">
        {rows.map((row) => (
          <ChangeRow key={row.key} deck={deck} row={row} number={numbers.get(row.key)} commit={changes?.commit?.hash} />
        ))}
        {changes && rows.length === 0 && slides.length > 0 && (
          <li className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">No slide changed.</li>
        )}
      </ol>
    </div>
  );
}

function ChangeRow(props: { deck: Deck; row: SlideChange; number?: number; commit?: string }) {
  const { deck, row, number, commit } = props;
  const picked = useChanges((s) => s.picked === row.key);
  const slide = deck.slides.find((s) => s.id === row.id);
  const status = STATUS[row.status];
  const itemRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (picked) itemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [picked]);

  return (
    <li ref={itemRef} data-testid="change-row" data-status={row.status} className="flex gap-2">
      <span className="w-4 shrink-0 pt-0.5 text-right text-2xs tabular-nums text-muted-foreground">
        {number ?? "–"}
      </span>
      <div className="relative min-w-0 flex-1">
        <button
          type="button"
          aria-pressed={picked}
          aria-label={`${number ? `Slide ${number}` : "Slide"}${status ? `, ${status.label.toLowerCase()}` : ""}`}
          onClick={() => useChanges.getState().pick(row.key)}
          className={cn(
            "block w-full overflow-hidden rounded-md transition-shadow",
            picked ? "ring-2 ring-primary ring-offset-2 ring-offset-sidebar" : "hover:ring-1 hover:ring-input",
          )}
        >
          {slide ? (
            <LiveThumbnail deck={deck} slide={slide} faded={row.status === "unchanged"} />
          ) : row.oldId && commit ? (
            <SlideFrame
              deckId={deck.id}
              slideId={row.oldId}
              version={commit}
              url={headSlideUrl(deck.id, row.oldId, commit)}
              size={pixelsOf({ size: deck.size })}
              thumbnail
              className="opacity-60 grayscale"
            />
          ) : null}
        </button>
        {status && (
          <span
            className={cn(
              "pointer-events-none absolute bottom-1 left-1 rounded px-1 py-px text-2xs font-medium text-white",
              status.className,
            )}
          >
            {status.label}
          </span>
        )}
      </div>
    </li>
  );
}

function LiveThumbnail({ deck, slide, faded }: { deck: Deck; slide: Slide; faded: boolean }) {
  const version = useSlideVersion(slide);
  return (
    <SlideFrame
      deckId={deck.id}
      slideId={slide.id}
      version={version}
      size={pixelsOf({ size: deck.size })}
      thumbnail
      className={cn(faded && "opacity-50")}
    />
  );
}

/** Reads the changes when the deck does, and on coming back to the window after a commit elsewhere. */
function useRefreshChanges(deck: string) {
  const content = useApp((s) =>
    [s.assetsRev, s.deck?.shellHash, ...(s.deck?.slides ?? []).map((x) => `${x.id}:${x.hash}`)].join("|"),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: read again whenever the deck's content changes
  useEffect(() => {
    void useChanges.getState().refresh(deck);
  }, [deck, content]);
  useEffect(() => {
    const onFocus = () => void useChanges.getState().refresh(deck);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [deck]);
}

/** Arrow keys go through the list, as they go through the slides on the stage. */
function useChangesKeyboard() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (useApp.getState().presenting || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as Element | null)?.closest?.("input, textarea, [contenteditable], [role=slider]")) return;
      const forward = ["ArrowDown", "ArrowRight", "PageDown"].includes(event.key);
      if (!forward && !["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key)) return;
      event.preventDefault();
      useChanges.getState().step(forward ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** The middle of Git mode: the slide picked in the list, as it was and as it is. */
export function ChangesView() {
  const deck = useApp((s) => s.deck);
  if (!deck) return null;
  return <Changes deck={deck} />;
}

function Changes({ deck }: { deck: Deck }) {
  const changes = useChanges((s) => (s.deck === deck.id ? s.changes : null));
  const row = useChanges((s) => s.changes?.slides.find((r) => r.key === s.picked));
  useRefreshChanges(deck.id);
  useChangesKeyboard();

  if (!changes) return <div className="h-full bg-canvas" />;
  if (changes.tracking === "noRepository") {
    return (
      <Message title="This deck is not in a git repository">
        Put its folder under version control (<code>git init</code>) and commit it to compare the slides with that
        version.
      </Message>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <ComparisonBar changes={changes} deck={deck.id} enabled={!!row && comparable(row, changes)} />
      {row ? (
        <SlideArea deck={deck} changes={changes} row={row} />
      ) : (
        <Message title="No slides">This deck has no slides, and the last commit had none either.</Message>
      )}
    </div>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 bg-canvas p-6 text-center">
      <GitCompare className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/** What is compared with, and the divider's angle and feather. */
function ComparisonBar({ changes, deck, enabled }: { changes: DeckChanges; deck: string; enabled: boolean }) {
  const divider = useChanges((s) => s.divider);
  const { setDivider, resetDivider } = useChanges.getState();
  const { commit } = changes;
  return (
    <div className="relative z-20 flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-1 text-xs text-muted-foreground">
      <span className="min-w-24 flex-1 truncate" title={commit ? `${commit.hash} ${commit.subject}` : undefined}>
        {commit ? (
          <>
            Since <code>{commit.hash}</code> {commit.subject}
          </>
        ) : (
          "Not committed yet"
        )}
      </span>
      <ValueSlider
        label="Angle"
        unit="°"
        min={-180}
        max={180}
        value={divider.angle}
        disabled={!enabled}
        onChange={(angle) => setDivider({ angle: normalAngle(angle) })}
      />
      <ValueSlider
        label="Feather"
        unit="px"
        min={0}
        max={MAX_FEATHER}
        value={divider.feather}
        disabled={!enabled}
        onChange={(feather) => setDivider({ feather })}
      />
      <button
        type="button"
        title="Put the divider back in the middle, without a feather"
        disabled={!enabled}
        onClick={resetDivider}
        className="rounded-md p-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      >
        <RotateCcw className="size-3.5" />
      </button>
      <button
        type="button"
        title="Compare again"
        onClick={() => void useChanges.getState().refresh(deck)}
        className="rounded-md p-1 hover:bg-accent hover:text-foreground"
      >
        <RefreshCw className="size-3.5" />
      </button>
    </div>
  );
}

/** A slider with the same value in a field beside it, to type an exact one. */
function ValueSlider(props: {
  label: string;
  unit: string;
  min: number;
  max: number;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const { label, unit, min, max, value, disabled, onChange } = props;
  // What is being typed, which may not be a number yet.
  const [draft, setDraft] = useState<string | null>(null);
  const clamped = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="range"
        aria-label={label}
        title={label}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1 w-20 accent-primary disabled:opacity-40"
      />
      <span className={cn(disabled && "opacity-40")}>{label}</span>
      <input
        type="number"
        aria-label={`${label} in ${unit === "°" ? "degrees" : "pixels"}`}
        min={min}
        max={max}
        value={draft ?? value}
        disabled={disabled}
        onChange={(event) => {
          const text = event.currentTarget.value;
          setDraft(text);
          if (text !== "" && Number.isFinite(Number(text))) onChange(clamped(Number(text)));
        }}
        onBlur={() => setDraft(null)}
        className="h-6 w-14 rounded border border-input bg-background px-1 text-right tabular-nums text-foreground outline-none focus:ring-1 focus:ring-primary disabled:opacity-40"
      />
      <span className={cn(disabled && "opacity-40")}>{unit}</span>
    </div>
  );
}

/** The picked slide as large as fits, and what the list says about it under it. */
function SlideArea({ deck, changes, row }: { deck: Deck; changes: DeckChanges; row: SlideChange }) {
  const area = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<Pixels | null>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRoom({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const canvas = pixelsOf({ size: deck.size });
  const oldCanvas = pixelsOf({ size: changes.oldSize });
  const scale = room ? Math.max(0, Math.min(room.width / canvas.width, room.height / canvas.height)) : 0;
  const box = { width: canvas.width * scale, height: canvas.height * scale };
  const commit = changes.commit?.hash;
  const slide = deck.slides.find((s) => s.id === row.id);

  const before =
    row.oldId && commit ? (
      <SlideFrame
        deckId={deck.id}
        slideId={row.oldId}
        version={commit}
        url={headSlideUrl(deck.id, row.oldId, commit)}
        size={oldCanvas}
        thumbnail
        className="w-full"
      />
    ) : null;
  const after = slide ? <LiveSlide deck={deck} slide={slide} /> : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <div className="min-h-0 flex-1 p-6">
        <div ref={area} className="flex size-full items-center justify-center">
          {scale > 0 &&
            (comparable(row, changes) ? (
              <SlideComparison box={box} scale={scale} before={before} after={after} />
            ) : (
              <div className="flex items-center overflow-hidden bg-black" style={box}>
                {after ?? before}
              </div>
            ))}
        </div>
      </div>
      <p className="flex min-h-10 shrink-0 items-center justify-center px-3 text-center text-xs text-muted-foreground">
        {caption(row, changes)}
      </p>
    </div>
  );
}

function LiveSlide({ deck, slide }: { deck: Deck; slide: Slide }) {
  const version = useSlideVersion(slide);
  return (
    <SlideFrame
      deckId={deck.id}
      slideId={slide.id}
      version={version}
      size={pixelsOf({ size: deck.size })}
      thumbnail
      className="w-full"
    />
  );
}

/** What the slide shown is, in words. */
function caption(row: SlideChange, changes: DeckChanges): string {
  const styles = changes.stylesChanged ? " The deck's shared styles changed, so it may still look different." : "";
  const also = row.details.length > 0 ? ` Changed: ${row.details.join(", ")}.` : "";
  if (changes.tracking === "notCommitted") return "Not committed yet, so every slide is new.";
  switch (row.status) {
    case "added":
      return "New since the last commit.";
    case "removed":
      return "Removed since the last commit; this is how it looked.";
    case "modified":
      return `Modified since the last commit.${also}`;
    case "moved":
      return `The same slide, in another place in the deck.${styles}`;
    case "unchanged":
      return `No changes to this slide.${styles}`;
  }
}
