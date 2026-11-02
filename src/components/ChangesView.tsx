import {
  ArrowUpDown,
  Check,
  GitCompare,
  ListFilter,
  type LucideIcon,
  Minus,
  Paintbrush,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useChanges, visibleRows } from "../changesStore";
import type { Change, Deck, DeckChanges, Slide, SlideChange, SlideStatus } from "../lib/api";
import { MAX_FEATHER, normalAngle } from "../lib/compare";
import { type Pixels, pixelsOf } from "../lib/slideSize";
import { cn, headSlideUrl } from "../lib/utils";
import { useApp } from "../store";
import { ToolButton } from "./Button";
import { SectionLabel } from "./SectionLabel";
import { SlideComparison } from "./SlideComparison";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

type Mark = { label: string; icon: LucideIcon; color: string; ring: string };

/** What each kind of change looks like, everywhere in this mode. */
const MARKS: Record<Exclude<SlideStatus, "unchanged">, Mark> = {
  added: { label: "Added", icon: Plus, color: "bg-success text-success-foreground", ring: "ring-success" },
  modified: { label: "Modified", icon: Pencil, color: "bg-warning text-warning-foreground", ring: "ring-warning" },
  removed: {
    label: "Removed",
    icon: Trash2,
    color: "bg-destructive text-destructive-foreground",
    ring: "ring-destructive",
  },
  moved: { label: "Moved", icon: ArrowUpDown, color: "bg-info text-info-foreground", ring: "ring-info" },
};

/** What the slides share (styles, fonts, scripts), which is no slide's change. */
const STYLES: Mark = { label: "Styles", icon: Paintbrush, color: MARKS.modified.color, ring: MARKS.modified.ring };

/** The marks of a row: a slide can have changed and moved. */
function marksOf(row: SlideChange): Mark[] {
  const marks = row.status === "unchanged" ? [] : [MARKS[row.status]];
  return row.moved && row.status !== "moved" ? [...marks, MARKS.moved] : marks;
}

/** The mark on the slide's picture: what changed in it, which a move is not. */
function contentMarkOf(row: SlideChange): Mark | null {
  return row.status === "unchanged" || row.status === "moved" ? null : MARKS[row.status];
}

/** The change a mark of a row stands for, to stage or restore it. */
function actionsOf(row: SlideChange, mark: Mark): { change: Change; noun: string; staged: boolean } | null {
  const { id, oldId } = row;
  if (mark !== MARKS.moved) return { change: { kind: "slide", id, oldId }, noun: "this slide", staged: row.staged };
  return id && oldId ? { change: { kind: "move", id, oldId }, noun: "this move", staged: row.moveStaged } : null;
}

const describe = (row: SlideChange) =>
  marksOf(row)
    .map((mark) => mark.label.toLowerCase())
    .join(" and ");

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
  const count = (status: keyof typeof MARKS) =>
    slides.filter((row) => (status === "moved" ? row.moved : row.status === status)).length;
  const counts = (["modified", "added", "removed", "moved"] as const).filter((status) => count(status) > 0);
  const stylesChanged = !!changes?.stylesChanged;
  const canStage = !!changes && changes.tracking !== "noRepository";

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-1">
          {counts.length === 0 && !stylesChanged && <SectionLabel className="truncate">Changes</SectionLabel>}
          {stylesChanged && (
            <span
              title="The shared styles changed"
              className={cn("flex items-center gap-0.5 rounded px-1 text-2xs font-medium", STYLES.color)}
            >
              <STYLES.icon className="size-2.5" />
            </span>
          )}
          {counts.map((status) => {
            const { icon: Icon, color, label } = MARKS[status];
            return (
              <span
                key={status}
                title={`${count(status)} ${label.toLowerCase()}`}
                className={cn("flex items-center gap-0.5 rounded px-1 text-2xs font-medium tabular-nums", color)}
              >
                <Icon className="size-2.5" />
                {count(status)}
              </span>
            );
          })}
        </div>
        <ToolButton
          variant="panel"
          title={onlyChanges ? "Show every slide" : "Show only the slides that changed"}
          active={onlyChanges}
          onClick={() => useChanges.getState().setOnlyChanges(!onlyChanges)}
        >
          <ListFilter className="size-4" />
        </ToolButton>
      </div>
      {changes && changes.tracking !== "noRepository" && <CommitBox deck={deck.id} changes={changes} />}
      <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4 pt-1.5">
        {changes && stylesChanged && <StylesRow deck={deck.id} changes={changes} canStage={canStage} />}
        {rows.map((row) => (
          <ChangeRow
            key={row.key}
            deck={deck}
            row={row}
            number={numbers.get(row.key)}
            commit={changes?.commit?.hash}
            canStage={canStage}
          />
        ))}
        {changes && rows.length === 0 && slides.length > 0 && (
          <li className="px-1 pt-2 text-xs leading-relaxed text-muted-foreground">
            {stylesChanged ? "No slide changed, only the shared styles." : "No slide changed."}
          </li>
        )}
      </ol>
    </div>
  );
}

/** The message of the next commit, the button that makes it, and staging everything at once. */
function CommitBox({ deck, changes }: { deck: string; changes: DeckChanges }) {
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const { stagedFiles, stagedElsewhere, hasUnstaged } = changes;
  const ready = stagedFiles > 0 && message.trim() !== "" && !committing;

  const commit = async () => {
    if (!ready) return;
    setCommitting(true);
    if (await useChanges.getState().commit(deck, message)) setMessage("");
    setCommitting(false);
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 pb-3">
      <textarea
        aria-label="Commit message"
        placeholder="Commit message"
        rows={2}
        value={message}
        onChange={(event) => setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void commit();
        }}
        className="w-full resize-none rounded border border-input bg-background px-1.5 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={!ready}
          title={stagedFiles === 0 ? "Stage something to commit it" : "Commit what is staged (⌘Enter)"}
          onClick={() => void commit()}
          className="min-w-0 flex-1 truncate rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-40"
        >
          Commit{stagedFiles > 0 ? ` ${stagedFiles} ${stagedFiles === 1 ? "file" : "files"}` : ""}
        </button>
        <ToolButton
          variant="panel"
          title="Stage everything in this deck"
          disabled={!hasUnstaged}
          onClick={() => void useChanges.getState().stageAll(deck)}
        >
          <Plus className="size-3.5" />
        </ToolButton>
        <ToolButton
          variant="panel"
          title="Unstage everything in this deck's folder"
          disabled={stagedFiles === stagedElsewhere}
          onClick={() => void useChanges.getState().unstageAll(deck)}
        >
          <Minus className="size-3.5" />
        </ToolButton>
      </div>
      {stagedElsewhere > 0 && (
        <p className="text-2xs leading-snug text-muted-foreground">
          Also commits {stagedElsewhere} staged {stagedElsewhere === 1 ? "file" : "files"} outside this deck's folder.
        </p>
      )}
    </div>
  );
}

function ChangeRow(props: { deck: Deck; row: SlideChange; number?: number; commit?: string; canStage: boolean }) {
  const { deck, row, number, commit, canStage } = props;
  const picked = useChanges((s) => s.picked === row.key);
  const slide = deck.slides.find((s) => s.id === row.id);
  const marks = marksOf(row);
  const content = contentMarkOf(row);
  const itemRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (picked) itemRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [picked]);

  return (
    <li ref={itemRef} data-testid="change-row" data-status={row.status} data-moved={row.moved} className="flex gap-2">
      <span className="w-4 shrink-0 pt-0.5 text-right text-2xs tabular-nums text-muted-foreground">
        {number ?? "–"}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="relative">
          <button
            type="button"
            aria-pressed={picked}
            aria-label={[number ? `Slide ${number}` : "Slide", describe(row), content && row.staged && "staged"]
              .filter(Boolean)
              .join(", ")}
            onClick={() => useChanges.getState().pick(row.key)}
            className={cn(
              "block w-full overflow-hidden rounded-md transition-shadow",
              picked
                ? "ring-2 ring-primary ring-offset-2 ring-offset-sidebar"
                : marks[0]
                  ? `ring-2 ${marks[0].ring}`
                  : "hover:ring-1 hover:ring-input",
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
          {content && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <MarkRow
                mark={content}
                deck={deck.id}
                actions={canStage ? actionsOf(row, content) : null}
                locked={!!slide?.locked}
              />
            </div>
          )}
          {content && row.staged && <StagedMark />}
        </div>
        {row.moved && <MoveRow row={row} deck={deck.id} actions={canStage ? actionsOf(row, MARKS.moved) : null} />}
      </div>
    </li>
  );
}

/** The field under a slide that moved: its own change, staged and restored apart from the slide. */
function MoveRow({ row, deck, actions }: { row: SlideChange; deck: string; actions: ReturnType<typeof actionsOf> }) {
  const from = row.oldNumber === null ? "Moved" : `Was slide ${row.oldNumber}`;
  return (
    <div
      data-testid="move-row"
      className="flex items-center justify-between gap-1.5 rounded-md border border-dashed border-info px-1.5 py-1 text-xs text-muted-foreground"
    >
      <span className="flex min-w-0 items-center gap-1" title={`Moved from slide ${row.oldNumber ?? "?"}`}>
        {row.moveStaged && (
          <span
            data-testid="staged-mark"
            title="Staged"
            className="shrink-0 rounded-full bg-overlay p-0.5 text-overlay-foreground"
          >
            <Check className="size-2.5" />
          </span>
        )}
        <span className="truncate tabular-nums">{from}</span>
      </span>
      <MarkRow mark={MARKS.moved} deck={deck} actions={actions} locked={false} small />
    </div>
  );
}

/** The check in the corner of what is staged. */
function StagedMark() {
  return (
    <span
      data-testid="staged-mark"
      title="Staged"
      className="pointer-events-none absolute right-1 top-1 rounded-full bg-overlay p-0.5 text-overlay-foreground"
    >
      <Check className="size-3" />
    </span>
  );
}

/** The row above the slides for what they share, once that changed: a styles mark with its buttons. */
function StylesRow({ deck, changes, canStage }: { deck: string; changes: DeckChanges; canStage: boolean }) {
  const actions = canStage
    ? { change: { kind: "styles" } as const, noun: "the shared styles", staged: changes.stylesStaged }
    : null;
  return (
    <li data-testid="styles-row" className="flex gap-2">
      <span className="w-4 shrink-0" />
      <div className="relative flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">
        <span className="truncate">Shared styles</span>
        <MarkRow mark={STYLES} deck={deck} actions={actions} locked={false} />
        {changes.stylesStaged && <StagedMark />}
      </div>
    </li>
  );
}

/** A status icon, with staging on its left and restoring on its right. */
function MarkRow(props: {
  mark: Mark;
  deck: string;
  actions: ReturnType<typeof actionsOf>;
  locked: boolean;
  /** Fits a row of text instead of a slide's picture. */
  small?: boolean;
}) {
  const { mark, deck, actions, locked, small } = props;
  const { label, icon: Icon, color } = mark;
  const { stage, unstage, restore } = useChanges.getState();
  return (
    <fieldset aria-label={label} className={cn("flex shrink-0 items-center", small ? "gap-1" : "gap-1.5")}>
      {actions && (
        <MarkButton
          small={small}
          label={actions.staged ? "Unstage" : "Stage"}
          title={
            actions.staged ? `Take ${actions.noun} out of the next commit` : `Add ${actions.noun} to the next commit`
          }
          onClick={() => void (actions.staged ? unstage : stage)(deck, actions.change)}
        >
          {actions.staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
        </MarkButton>
      )}
      <span
        data-testid="change-mark"
        title={label}
        className={cn("flex items-center justify-center rounded-full shadow-md", small ? "size-5" : "size-7", color)}
      >
        <Icon className={small ? "size-3" : "size-4"} />
      </span>
      {actions && (
        <MarkButton
          small={small}
          label="Restore"
          title={
            locked
              ? "This slide is locked; unlock it to restore it"
              : `Put ${actions.noun} back as committed, or staged (⌘Z undoes it)`
          }
          disabled={locked}
          onClick={() => void restore(deck, actions.change)}
        >
          <Undo2 className="size-3.5" />
        </MarkButton>
      )}
    </fieldset>
  );
}

function MarkButton(props: {
  label: string;
  title: string;
  disabled?: boolean;
  small?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "pointer-events-auto flex items-center justify-center rounded-full bg-handle text-handle-foreground shadow-md ring-1 ring-scrim/40 hover:opacity-90 disabled:pointer-events-none disabled:opacity-40",
        props.small ? "size-5" : "size-6",
      )}
    >
      {props.children}
    </button>
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
      if (useApp.getState().presenting || event.altKey) return;
      if ((event.target as Element | null)?.closest?.("input, textarea, [contenteditable], [role=slider]")) return;
      // A restore is a slide list change: the same keys take it back as anywhere else.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? useApp.getState().redoDeckEdit() : useApp.getState().undoDeckEdit());
        return;
      }
      if (event.metaKey || event.ctrlKey) return;
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

  // Without a repository the mode is about to close; see ModeTabs.tsx.
  if (!changes || changes.tracking === "noRepository") return <div className="h-full bg-canvas" />;
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
      <ToolButton
        variant="panel"
        title="Put the divider back in the middle, without a feather"
        disabled={!enabled}
        onClick={resetDivider}
      >
        <RotateCcw className="size-3.5" />
      </ToolButton>
      <ToolButton variant="plain" title="Compare again" onClick={() => void useChanges.getState().refresh(deck)}>
        <RefreshCw className="size-3.5" />
      </ToolButton>
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
      <ChangeActions deck={deck} changes={changes} />
      <div className="min-h-0 flex-1 p-6">
        <div ref={area} className="flex size-full items-center justify-center">
          {scale > 0 &&
            (comparable(row, changes) ? (
              <SlideComparison box={box} scale={scale} before={before} after={after} />
            ) : (
              <div className="flex items-center overflow-hidden bg-stage" style={box}>
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

/** Stage and restore for what the slides share, which no slide's marks stand for. */
function ChangeActions({ deck, changes }: { deck: Deck; changes: DeckChanges }) {
  if (changes.tracking !== "committed" || !changes.stylesChanged) return null;
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 px-3 pt-2">
      <ActionGroup
        label="Shared styles"
        noun="the shared styles"
        deck={deck.id}
        change={{ kind: "styles" }}
        staged={changes.stylesStaged}
        locked={false}
      />
    </div>
  );
}

function ActionGroup(props: {
  label: string;
  /** What the buttons' tooltips call the change. */
  noun: string;
  deck: string;
  change: Change;
  staged: boolean;
  locked: boolean;
}) {
  const { label, noun, deck, change, staged, locked } = props;
  const { stage, unstage, restore } = useChanges.getState();
  return (
    <fieldset aria-label={label} className="flex items-center gap-1 text-xs text-muted-foreground">
      <span className="mr-1">{label}</span>
      <ActionButton
        title={staged ? `Take ${noun} out of the next commit` : `Add ${noun} to the next commit`}
        onClick={() => void (staged ? unstage(deck, change) : stage(deck, change))}
      >
        {staged ? <Minus className="size-3.5" /> : <Plus className="size-3.5" />}
        {staged ? "Unstage" : "Stage"}
      </ActionButton>
      <ActionButton
        title={
          locked ? "This slide is locked; unlock it to restore it" : `Put ${noun} back as committed (⌘Z undoes it)`
        }
        disabled={locked}
        onClick={() => void restore(deck, change)}
      >
        <Undo2 className="size-3.5" />
        Restore
      </ActionButton>
    </fieldset>
  );
}

function ActionButton(props: { title: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex items-center gap-1 rounded-md border bg-background px-2 py-1 font-medium text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
    >
      {props.children}
    </button>
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
  const place = row.moved ? ` It moved from slide ${row.oldNumber}.` : "";
  const styles = changes.stylesChanged ? " The deck's shared styles changed, so it may still look different." : "";
  const also = row.details.length > 0 ? ` Changed: ${row.details.join(", ")}.` : "";
  if (changes.tracking === "notCommitted")
    return `Not committed yet, so every slide is new; restoring takes it out.${styles}`;
  switch (row.status) {
    case "added":
      return "New since the last commit.";
    case "removed":
      return "Removed since the last commit; this is how it looked.";
    case "modified":
      return `Modified since the last commit.${also}${place}`;
    case "moved":
      return `The same slide, moved from slide ${row.oldNumber}.${styles}`;
    case "unchanged":
      return `No changes to this slide.${styles}`;
  }
}
