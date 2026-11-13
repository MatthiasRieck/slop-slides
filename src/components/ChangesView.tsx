import {
  AlertTriangle,
  Check,
  GitBranch,
  GitCompare,
  ListFilter,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { type CompareView, useChanges, visibleRows } from "../changesStore";
import { useContentSize } from "../hooks/useContentSize";
import type { Deck, DeckChanges, Slide, SlideChange } from "../lib/api";
import { MAX_FEATHER, normalAngle } from "../lib/compare";
import { formatKeys, keepsKey } from "../lib/keys";
import { scrollBehavior } from "../lib/motion";
import { pixelsOf } from "../lib/slideSize";
import { cn, headSlideUrl, plural } from "../lib/utils";
import { useApp } from "../store";
import { Button, ToolButton } from "./Button";
import {
  actionsOf,
  branchLabel,
  canDiscardAll,
  caption,
  changeCounts,
  comparable,
  contentMarkOf,
  describeRow,
  isClean,
  MARKS,
  type Mark,
  type MarkActions,
  marksOf,
  STYLES,
  slideNumbers,
  stageTitle,
  stylesActions,
} from "./changes/changeRows";
import { Dialog } from "./Dialog";
import { Popover } from "./Popover";
import { SectionLabel } from "./SectionLabel";
import { SlideComparison } from "./SlideComparison";
import { SlideFrame, useSlideVersion } from "./SlideFrame";

/** A kind of change in the header, with how many slides have it. Every badge has the same height and icon box. */
function CountBadge(props: { mark: Mark; title: string; count?: number }) {
  const { icon: Icon, color } = props.mark;
  return (
    <span
      data-testid="count-badge"
      title={props.title}
      className={cn(
        "flex h-4 shrink-0 items-center gap-0.5 rounded px-1 text-2xs font-medium leading-none tabular-nums",
        color,
      )}
    >
      <Icon className="size-3 shrink-0" />
      {props.count}
    </span>
  );
}

/** Where the next commit goes: the branch checked out, or a warning that none is. */
function Branch({ changes, className }: { changes: DeckChanges; className?: string }) {
  const label = branchLabel(changes);
  if (!label) return null;
  return (
    <span
      data-testid="branch"
      title={
        changes.detached
          ? "A commit is checked out, not a branch: a commit made now is on no branch"
          : `On branch ${label}: commits go here`
      }
      className={cn(
        "flex min-w-0 items-center gap-1",
        changes.detached ? "font-medium text-warning" : "text-muted-foreground",
        className,
      )}
    >
      {changes.detached ? <AlertTriangle className="size-3 shrink-0" /> : <GitBranch className="size-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
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
  const counts = changeCounts(slides);
  const stylesChanged = !!changes?.stylesChanged;
  const canStage = !!changes && changes.tracking !== "noRepository";
  const clean = !!changes && isClean(changes);

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-1">
          {counts.length === 0 && !stylesChanged && <SectionLabel className="truncate">Changes</SectionLabel>}
          {stylesChanged && <CountBadge mark={STYLES} title="The shared styles changed" />}
          {counts.map(({ status, count }) => {
            const mark = MARKS[status];
            return <CountBadge key={status} mark={mark} title={`${count} ${mark.label.toLowerCase()}`} count={count} />;
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
      {!changes && (
        <p role="status" className="flex items-center gap-1.5 px-3 pb-3 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          Reading changes…
        </p>
      )}
      {changes && clean && (
        <div data-testid="no-changes" className="flex shrink-0 flex-col gap-1 border-b px-3 pb-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium">
            <Check className="size-3.5 shrink-0 text-success" />
            <span>
              No changes since <code>{changes.commit?.hash}</code>
            </span>
          </p>
          <Branch changes={changes} />
        </div>
      )}
      {changes && !clean && changes.tracking !== "noRepository" && <CommitBox deck={deck} changes={changes} />}
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

/**
 * The message of the next commit and the button that makes it, on which branch, and everything
 * at once: staging, unstaging and discarding. With nothing staged the button commits all there
 * is; while it cannot commit, its tooltip says what it waits for.
 */
function CommitBox({ deck, changes }: { deck: Deck; changes: DeckChanges }) {
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const { stagedFiles, stagedElsewhere, hasUnstaged } = changes;
  // Nothing picked for the commit: it takes everything there is.
  const all = stagedFiles === 0 && hasUnstaged;
  const waitsFor =
    stagedFiles === 0 && !hasUnstaged
      ? "Nothing to commit"
      : message.trim() === ""
        ? "Write a message to commit"
        : null;
  const locked = lockedChange(deck, changes);

  const commit = async () => {
    if (waitsFor || committing) return;
    setCommitting(true);
    const { commit, commitAll } = useChanges.getState();
    if (await (all ? commitAll : commit)(deck.id, message)) setMessage("");
    setCommitting(false);
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b px-3 pb-3">
      <Branch changes={changes} className="text-2xs" />
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
      <Button
        variant="primary"
        busy={committing}
        disabled={waitsFor !== null}
        title={
          waitsFor ??
          `${all ? "Stage everything in this deck and commit it" : "Commit what is staged"} (${formatKeys("mod+enter")})`
        }
        onClick={() => void commit()}
        className="justify-center"
      >
        <span className="truncate">
          {all ? "Commit all" : `Commit${stagedFiles > 0 ? ` ${plural(stagedFiles, "file")}` : ""}`}
        </span>
      </Button>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          size="sm"
          title="Stage everything in this deck"
          disabled={!hasUnstaged}
          onClick={() => void useChanges.getState().stageAll(deck.id)}
        >
          Stage all
        </Button>
        <Button
          size="sm"
          title="Unstage everything in this deck's folder"
          disabled={stagedFiles === stagedElsewhere}
          onClick={() => void useChanges.getState().unstageAll(deck.id)}
        >
          Unstage all
        </Button>
        {canDiscardAll(changes) && (
          <Button
            size="sm"
            variant="destructive"
            disabled={locked !== null}
            title={
              locked !== null
                ? `Slide ${locked} is locked; unlock it to discard its changes`
                : "Put the whole deck back as it was committed"
            }
            onClick={() => setDiscarding(true)}
          >
            Discard all…
          </Button>
        )}
      </div>
      {stagedElsewhere > 0 && (
        <p className="text-2xs leading-snug text-muted-foreground">
          Also commits {stagedElsewhere} staged {stagedElsewhere === 1 ? "file" : "files"} outside this deck's folder.
        </p>
      )}
      {discarding && (
        <DiscardAllDialog
          changes={changes}
          onClose={() => setDiscarding(false)}
          onDiscard={() => {
            setDiscarding(false);
            void useChanges.getState().restoreAll(deck.id);
          }}
        />
      )}
    </div>
  );
}

/** The number of the first slide that changed and is locked, which keeps it from being discarded; null without one. */
function lockedChange(deck: Deck, changes: DeckChanges): number | null {
  const changed = new Set(changes.slides.filter((row) => row.status !== "unchanged" || row.moved).map((row) => row.id));
  const at = deck.slides.findIndex((slide) => slide.locked && changed.has(slide.id));
  return at < 0 ? null : at + 1;
}

/** Asks before every change since the last commit goes. */
function DiscardAllDialog(props: { changes: DeckChanges; onClose: () => void; onDiscard: () => void }) {
  const { commit } = props.changes;
  return (
    <Dialog
      label="Discard all changes"
      onClose={props.onClose}
      className="flex w-[26rem] max-w-[90vw] flex-col gap-4 rounded-xl border bg-background p-5 text-foreground shadow-2xl outline-none"
      heading={<h2 className="text-base font-semibold">Discard all changes to this deck?</h2>}
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        Every slide and the shared styles go back to how they were at the last commit
        {commit ? (
          <>
            {" "}
            (<code>{commit.hash}</code> {commit.subject})
          </>
        ) : null}
        : new slides are taken out, removed ones come back, and what is staged of the deck is unstaged.{" "}
        {formatKeys("mod+z")} brings the changes back.
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="xl" data-autofocus onClick={props.onClose}>
          Cancel
        </Button>
        <Button variant="destructive" size="xl" onClick={props.onDiscard}>
          Discard all changes
        </Button>
      </div>
    </Dialog>
  );
}

function ChangeRow(props: { deck: Deck; row: SlideChange; number?: number; commit?: string; canStage: boolean }) {
  const { deck, row, number, commit, canStage } = props;
  const picked = useChanges((s) => s.picked === row.key);
  const slide = deck.slides.find((s) => s.id === row.id);
  const marks = marksOf(row);
  const content = contentMarkOf(row);
  const actions = content && canStage ? actionsOf(row, content) : null;
  const itemRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (picked) itemRef.current?.scrollIntoView({ block: "nearest", behavior: scrollBehavior() });
  }, [picked]);

  return (
    <li ref={itemRef} data-testid="change-row" data-status={row.status} data-moved={row.moved} className="flex gap-2">
      <span className="w-4 shrink-0 pt-0.5 text-right text-2xs tabular-nums text-muted-foreground">
        {number ?? "–"}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="relative">
          <button
            type="button"
            aria-pressed={picked}
            aria-label={[number ? `Slide ${number}` : "Slide", describeRow(row), content && row.staged && "staged"]
              .filter(Boolean)
              .join(", ")}
            onClick={() => useChanges.getState().pick(row.key)}
            className={cn(
              "block w-full overflow-hidden rounded-md shadow-thumbnail transition-shadow",
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
          {/* In a corner, so the picture of the slide stays in view. */}
          {content && <MarkBadge mark={content} className="pointer-events-none absolute right-1 top-1" />}
          {content && row.staged && <StagedMark />}
        </div>
        {content && actions && (
          <MarkActionsRow mark={content} deck={deck.id} actions={actions} locked={!!slide?.locked} />
        )}
        {row.moved && (
          <MoveRow row={row} number={number} deck={deck.id} actions={canStage ? actionsOf(row, MARKS.moved) : null} />
        )}
      </div>
    </li>
  );
}

/** The field under a slide that moved: its own change, staged and restored apart from the slide. */
function MoveRow(props: { row: SlideChange; number?: number; deck: string; actions: MarkActions | null }) {
  const { row, number, deck, actions } = props;
  const from = row.oldNumber === null || number === undefined ? "Moved" : `${row.oldNumber} → ${number}`;
  const title = row.oldNumber === null ? "Moved" : `Moved from slide ${row.oldNumber} to slide ${number ?? "?"}`;
  return (
    <div
      data-testid="move-row"
      className="flex flex-wrap items-center justify-between gap-1.5 rounded-md border border-dashed border-info px-1.5 py-1 text-xs text-muted-foreground"
    >
      <span className="flex min-w-0 items-center gap-1" title={title}>
        {row.moveStaged && (
          <span
            data-testid="staged-mark"
            title="Staged"
            className="shrink-0 rounded-full bg-overlay p-0.5 text-overlay-foreground"
          >
            <Check className="size-2.5" />
          </span>
        )}
        <MarkBadge mark={MARKS.moved} small />
        <span className="truncate tabular-nums">{from}</span>
      </span>
      {actions && <MarkActionsRow mark={MARKS.moved} deck={deck} actions={actions} locked={false} />}
    </div>
  );
}

/** The check in the corner of what is staged. */
function StagedMark() {
  return (
    <span
      data-testid="staged-mark"
      title="Staged"
      className="pointer-events-none absolute left-1 top-1 rounded-full bg-overlay p-0.5 text-overlay-foreground"
    >
      <Check className="size-3" />
    </span>
  );
}

/** The row above the slides for what they share, once that changed: a styles mark with its buttons. */
function StylesRow({ deck, changes, canStage }: { deck: string; changes: DeckChanges; canStage: boolean }) {
  return (
    <li data-testid="styles-row" className="flex gap-2">
      <span className="w-4 shrink-0" />
      <div className="relative flex min-w-0 flex-1 flex-wrap items-center justify-between gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1.5">
          {changes.stylesStaged && (
            <span
              data-testid="staged-mark"
              title="Staged"
              className="shrink-0 rounded-full bg-overlay p-0.5 text-overlay-foreground"
            >
              <Check className="size-2.5" />
            </span>
          )}
          <MarkBadge mark={STYLES} small />
          <span className="truncate">Shared styles</span>
        </span>
        {canStage && (
          <MarkActionsRow mark={STYLES} deck={deck} actions={stylesActions(changes.stylesStaged)} locked={false} />
        )}
      </div>
    </li>
  );
}

/** The round icon of a kind of change. */
function MarkBadge({ mark, small, className }: { mark: Mark; small?: boolean; className?: string }) {
  const { label, icon: Icon, color } = mark;
  return (
    <span
      data-testid="change-mark"
      title={label}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full shadow-md",
        small ? "size-4" : "size-6",
        color,
        className,
      )}
    >
      <Icon className={small ? "size-2.5" : "size-3.5"} />
    </span>
  );
}

/**
 * What can be done with a change, as buttons that say it: stage it (or take it out of the next
 * commit again), and put it back as committed, named by what that does to it (see
 * `restoreActionOf`) and red where work goes with it.
 */
function MarkActionsRow(props: {
  mark: Mark;
  deck: string;
  actions: MarkActions;
  locked: boolean;
  /** What the buttons are for, when the mark's name does not say it. */
  label?: string;
}) {
  const { mark, deck, actions, locked } = props;
  const { stage, unstage, restore } = useChanges.getState();
  const undo = actions.restore;
  return (
    <fieldset aria-label={props.label ?? mark.label} className="flex min-w-0 flex-wrap items-center gap-1">
      <Button
        size="xs"
        title={stageTitle(actions)}
        onClick={() => void (actions.staged ? unstage : stage)(deck, actions.change)}
        className="bg-background"
      >
        {actions.staged ? <Minus className="size-3" /> : <Plus className="size-3" />}
        {actions.staged ? "Unstage" : "Stage"}
      </Button>
      <Button
        size="xs"
        variant={undo.destructive ? "destructive" : "outline"}
        title={locked ? "This slide is locked; unlock it first" : `${undo.title} (${formatKeys("mod+z")} undoes it)`}
        disabled={locked}
        onClick={() => void restore(deck, actions.change)}
        className="bg-background"
      >
        {undo.destructive ? <Trash2 className="size-3" /> : <Undo2 className="size-3" />}
        {undo.label}
      </Button>
    </fieldset>
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
      if (keepsKey(event)) return;
      // A restore is a change to the deck: the same keys take it back as anywhere else.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void (event.shiftKey ? useApp.getState().redo() : useApp.getState().undo());
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
  const error = useChanges((s) => (s.deck === deck.id ? s.error : null));
  const row = useChanges((s) => s.changes?.slides.find((r) => r.key === s.picked));
  useRefreshChanges(deck.id);
  useChangesKeyboard();

  if (error) {
    return (
      <Message title="Could not read the changes" role="alert">
        <span className="selectable whitespace-pre-wrap break-words">{error}</span>
        <Button className="mx-auto mt-3" onClick={() => void useChanges.getState().refresh(deck.id)}>
          <RefreshCw />
          Retry
        </Button>
      </Message>
    );
  }
  if (!changes) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center gap-2 bg-canvas text-xs text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" />
        Reading changes…
      </div>
    );
  }
  // Without a repository the mode is about to close; see ModeTabs.tsx.
  if (changes.tracking === "noRepository") return <div className="h-full bg-canvas" />;
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

function Message({ title, role, children }: { title: string; role?: "alert"; children: React.ReactNode }) {
  return (
    <div role={role} className="flex h-full flex-col items-center justify-center gap-2 bg-canvas p-6 text-center">
      <GitCompare className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      <div className="max-w-sm text-xs leading-relaxed text-muted-foreground">{children}</div>
    </div>
  );
}

const VIEWS: { id: CompareView; label: string; title: string }[] = [
  { id: "split", label: "Split", title: "Both versions, split by a divider you can drag" },
  { id: "before", label: "Before", title: "The slide as it was committed" },
  { id: "after", label: "After", title: "The slide as it is now" },
];

/**
 * What is compared with and on which branch, how the two versions show (split, or one of them),
 * and the divider's settings behind a button of their own.
 */
function ComparisonBar({ changes, deck, enabled }: { changes: DeckChanges; deck: string; enabled: boolean }) {
  const view = useChanges((s) => s.view);
  const loading = useChanges((s) => s.loading);
  const { commit } = changes;
  return (
    <div className="relative z-20 flex min-h-10 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-1 text-xs text-muted-foreground">
      <Branch changes={changes} className="max-w-40 shrink-0" />
      <span className="min-w-24 flex-1 truncate" title={commit ? `${commit.hash} ${commit.subject}` : undefined}>
        {commit ? (
          <>
            Since <code>{commit.hash}</code> {commit.subject}
          </>
        ) : (
          "Not committed yet"
        )}
      </span>
      <fieldset aria-label="Show" className="flex shrink-0 overflow-hidden rounded-md border">
        {VIEWS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={view === option.id}
            disabled={!enabled}
            title={enabled ? option.title : "This slide has one version to show"}
            onClick={() => useChanges.getState().setView(option.id)}
            className="px-2 py-1 font-medium enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-40 aria-pressed:enabled:bg-accent aria-pressed:enabled:text-foreground"
          >
            {option.label}
          </button>
        ))}
      </fieldset>
      <DividerSettings enabled={enabled && view === "split"} />
      <ToolButton variant="plain" label="Refresh" onClick={() => void useChanges.getState().refresh(deck)}>
        <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
      </ToolButton>
    </div>
  );
}

/** The divider's angle and feather, and putting it back, in a panel behind one button. */
function DividerSettings({ enabled }: { enabled: boolean }) {
  const divider = useChanges((s) => s.divider);
  const { setDivider, resetDivider } = useChanges.getState();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  if (!enabled && open) setOpen(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-expanded={open}
        disabled={!enabled}
        title={enabled ? "The divider's angle and feather" : "The divider shows in the split view"}
        onClick={() => setOpen(!open)}
        className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 enabled:hover:bg-accent enabled:hover:text-foreground disabled:opacity-40 aria-expanded:bg-accent aria-expanded:text-foreground"
      >
        <SlidersHorizontal className="size-3.5" />
        Divider
      </button>
      {open && (
        <Popover anchor={anchor} onClose={close} width={280} align="end" label="Divider" className="p-3">
          <div className="flex flex-col gap-3 text-xs text-muted-foreground">
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
            <Button
              className="self-start"
              title="Put the divider back in the middle, without a feather"
              onClick={resetDivider}
            >
              <RotateCcw />
              Reset divider
            </Button>
          </div>
        </Popover>
      )}
    </>
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
      <span className={cn("w-12 shrink-0", disabled && "opacity-40")}>{label}</span>
      <input
        type="range"
        aria-label={label}
        title={label}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1 min-w-0 flex-1 accent-primary disabled:opacity-40"
      />
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
      <span className={cn("w-4 shrink-0", disabled && "opacity-40")}>{unit}</span>
    </div>
  );
}

/** The picked slide as large as fits, and what the list says about it under it. */
function SlideArea({ deck, changes, row }: { deck: Deck; changes: DeckChanges; row: SlideChange }) {
  const area = useRef<HTMLDivElement>(null);
  const room = useContentSize(area);
  const view = useChanges((s) => s.view);
  const canvas = pixelsOf({ size: deck.size });
  const oldCanvas = pixelsOf({ size: changes.oldSize });
  const scale = room ? Math.max(0, Math.min(room.width / canvas.width, room.height / canvas.height)) : 0;
  const box = { width: canvas.width * scale, height: canvas.height * scale };
  const commit = changes.commit?.hash;
  const slide = deck.slides.find((s) => s.id === row.id);
  const compared = comparable(row, changes);

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
  // One version of a slide that has two, when asked for; else whichever there is.
  const single = compared && view === "before" ? before : compared && view === "after" ? after : (after ?? before);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <ChangeActions deck={deck} changes={changes} />
      <div className="min-h-0 flex-1 p-6">
        <div ref={area} className="flex size-full items-center justify-center">
          {scale > 0 &&
            (compared && view === "split" ? (
              <SlideComparison box={box} scale={scale} before={before} after={after} />
            ) : (
              <div data-testid="single-version" className="flex items-center overflow-hidden bg-stage" style={box}>
                {single}
              </div>
            ))}
        </div>
      </div>
      <p className="flex min-h-10 shrink-0 items-center justify-center px-3 text-center text-xs text-muted-foreground">
        {compared && view !== "split" && (
          <span className="mr-1.5 font-medium text-foreground">
            {view === "before" ? `Before (${commit}).` : "After (now)."}
          </span>
        )}
        {caption(row, changes)}
      </p>
    </div>
  );
}

/** Stage and restore for what the slides share, which no slide's marks stand for. */
function ChangeActions({ deck, changes }: { deck: Deck; changes: DeckChanges }) {
  if (changes.tracking !== "committed" || !changes.stylesChanged) return null;
  return (
    <div className="flex min-h-10 shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 px-3 pt-2 text-xs text-muted-foreground">
      <span>Shared styles</span>
      <MarkActionsRow
        mark={STYLES}
        deck={deck.id}
        actions={stylesActions(changes.stylesStaged)}
        locked={false}
        label="Shared styles"
      />
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
