import {
  AlertTriangle,
  Check,
  GitBranch,
  GitCompare,
  ListFilter,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type CompareView, useChanges, visibleRows } from "../changesStore";
import { useContentSize } from "../hooks/useContentSize";
import type { Deck, DeckChanges, Slide, SlideChange } from "../lib/api";
import { MAX_FEATHER, normalAngle } from "../lib/compare";
import { formatKeys, keepsKey } from "../lib/keys";
import { scrollBehavior } from "../lib/motion";
import { pixelsOf } from "../lib/slideSize";
import { cn, headSlideUrl, plural } from "../lib/utils";
import { lintKey, useApp } from "../store";
import {
  actionsOf,
  branchLabel,
  canDiscardAll,
  caption,
  changeCounts,
  comparable,
  contentMarkOf,
  describeRow,
  hasSlideChanges,
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
import { SlideComparison } from "./SlideComparison";
import { SlideFrame, useSlideVersion } from "./SlideFrame";
import { SECTION_HEADING } from "./styles";

/** A kind of change in the header, with how many slides have it. Every badge has the same height and icon box. */
function CountBadge(props: { mark: Mark; title: string; count?: number }) {
  const { icon: Icon, color } = props.mark;
  return (
    <Badge
      data-testid="count-badge"
      title={props.title}
      className={cn("h-4 gap-0.5 rounded px-1 text-2xs leading-none tabular-nums", color)}
    >
      <Icon />
      {props.count}
    </Badge>
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
          {counts.length === 0 && !stylesChanged && <span className={cn("truncate", SECTION_HEADING)}>Changes</span>}
          {stylesChanged && <CountBadge mark={STYLES} title="The shared styles changed" />}
          {counts.map(({ status, count }) => {
            const mark = MARKS[status];
            return <CountBadge key={status} mark={mark} title={`${count} ${mark.label.toLowerCase()}`} count={count} />;
          })}
        </div>
        <Button
          variant="tool"
          size="icon-xs"
          aria-label="Show only the slides that changed"
          tooltip={onlyChanges ? "Show every slide" : "Show only the slides that changed"}
          aria-pressed={onlyChanges}
          onClick={() => useChanges.getState().setOnlyChanges(!onlyChanges)}
        >
          <ListFilter className="size-4" />
        </Button>
      </div>
      {!changes && (
        <p role="status" className="flex items-center gap-1.5 px-3 pb-3 text-xs text-muted-foreground">
          <Spinner aria-hidden="true" className="size-3" />
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
        {!changes &&
          [0, 1, 2].map((n) => (
            <li key={n} aria-hidden="true" data-testid="change-skeleton" className="flex gap-2">
              <span className="w-4 shrink-0" />
              <Skeleton className="aspect-video min-w-0 flex-1" />
            </li>
          ))}
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
      <Textarea
        aria-label="Commit message"
        placeholder="Commit message"
        rows={2}
        value={message}
        onChange={(event) => setMessage(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void commit();
        }}
        className="min-h-12 resize-none bg-background px-1.5 py-1 text-xs"
      />
      <Button
        size="xs"
        disabled={waitsFor !== null || committing}
        aria-busy={committing || undefined}
        tooltip={waitsFor ?? (all ? "Stage everything in this deck and commit it" : "Commit what is staged")}
        shortcut={waitsFor ? undefined : "mod+enter"}
        onClick={() => void commit()}
        className="w-full"
      >
        {committing && <Spinner aria-hidden="true" data-icon="inline-start" />}
        <span className="truncate">
          {all ? "Commit all" : `Commit${stagedFiles > 0 ? ` ${plural(stagedFiles, "file")}` : ""}`}
        </span>
      </Button>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size="xs"
          tooltip="Stage everything in this deck"
          disabled={!hasUnstaged}
          onClick={() => void useChanges.getState().stageAll(deck.id)}
        >
          Stage all
        </Button>
        <Button
          variant="outline"
          size="xs"
          tooltip="Unstage everything in this deck's folder"
          disabled={stagedFiles === stagedElsewhere}
          onClick={() => void useChanges.getState().unstageAll(deck.id)}
        >
          Unstage all
        </Button>
        {canDiscardAll(changes) && (
          <Button
            size="xs"
            variant="destructive"
            disabled={locked !== null}
            tooltip={
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
    <AlertDialog open onOpenChange={(open) => !open && props.onClose()}>
      <AlertDialogContent className="data-[size=default]:sm:max-w-[26rem]">
        <AlertDialogHeader>
          <AlertDialogTitle>Discard all changes to this deck?</AlertDialogTitle>
          <AlertDialogDescription>
            Every slide and the shared styles go back to how they were at the last commit
            {commit ? (
              <>
                {" "}
                (<code>{commit.hash}</code> {commit.subject})
              </>
            ) : null}
            : new slides are taken out, removed ones come back, and what is staged of the deck is unstaged.{" "}
            {formatKeys("mod+z")} brings the changes back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" size="sm" onClick={props.onDiscard}>
            Discard all changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
              // No transition on the ring: it would repaint the slide under it for its whole length.
              "block w-full overflow-hidden rounded-md shadow-thumbnail",
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
                lazy
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
    <Item
      data-testid="move-row"
      variant="outline"
      size="xs"
      className="justify-between gap-1.5 border-dashed border-info px-1.5 py-1 text-xs text-muted-foreground"
    >
      <ItemContent title={title} className="min-w-0 flex-row items-center gap-1">
        {row.moveStaged && <StagedDot />}
        <MarkBadge mark={MARKS.moved} small />
        <span className="truncate tabular-nums">{from}</span>
      </ItemContent>
      {actions && (
        <ItemActions>
          <MarkActionsRow mark={MARKS.moved} deck={deck} actions={actions} locked={false} />
        </ItemActions>
      )}
    </Item>
  );
}

/** The check beside the name of what is staged, in a row of its own. */
function StagedDot() {
  return (
    <span
      data-testid="staged-mark"
      title="Staged"
      className="shrink-0 rounded-full bg-overlay p-0.5 text-overlay-foreground"
    >
      <Check className="size-2.5" />
    </span>
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
      <Item
        variant="outline"
        size="xs"
        className="w-auto min-w-0 flex-1 justify-between gap-1.5 border-dashed px-2 py-1.5 text-xs text-muted-foreground"
      >
        {changes.stylesStaged && <StagedDot />}
        <ItemMedia>
          <MarkBadge mark={STYLES} small />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="truncate text-xs font-normal">Shared styles</ItemTitle>
        </ItemContent>
        {canStage && (
          <ItemActions>
            <MarkActionsRow mark={STYLES} deck={deck} actions={stylesActions(changes.stylesStaged)} locked={false} />
          </ItemActions>
        )}
      </Item>
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
        variant="outline"
        size="2xs"
        tooltip={stageTitle(actions)}
        onClick={() => void (actions.staged ? unstage : stage)(deck, actions.change)}
        className="bg-background"
      >
        {actions.staged ? <Minus data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
        {actions.staged ? "Unstage" : "Stage"}
      </Button>
      <Button
        size="2xs"
        variant={undo.destructive ? "destructive" : "outline"}
        tooltip={locked ? "This slide is locked; unlock it first" : undo.title}
        shortcut={locked ? undefined : "mod+z"}
        disabled={locked}
        onClick={() => void restore(deck, actions.change)}
        className={cn(!undo.destructive && "bg-background")}
      >
        {undo.destructive ? <Trash2 data-icon="inline-start" /> : <Undo2 data-icon="inline-start" />}
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
      lazy
      className={cn(faded && "opacity-50")}
    />
  );
}

/** Reads the changes when the deck does, and on coming back to the window after a commit elsewhere. */
function useRefreshChanges(deck: string) {
  // The deck's key is worked out once per deck object, not on every update of the store.
  const content = useApp((s) => `${s.assetsRev}|${lintKey(s.deck)}`);
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
        <EmptyContent className="mt-3">
          <Button variant="outline" size="xs" onClick={() => void useChanges.getState().refresh(deck.id)}>
            <RefreshCw data-icon="inline-start" />
            Retry
          </Button>
        </EmptyContent>
      </Message>
    );
  }
  if (!changes) {
    return (
      <div
        role="status"
        className="flex h-full items-center justify-center gap-2 bg-canvas text-xs text-muted-foreground"
      >
        <Spinner aria-hidden="true" className="size-3.5" />
        Reading changes…
      </div>
    );
  }
  // Without a repository the mode is about to close; see ModeTabs.tsx.
  if (changes.tracking === "noRepository") return <div className="h-full bg-canvas" />;
  // With nothing changed there is nothing to compare, so no slide shows: not the one picked either.
  const shown = row && hasSlideChanges(changes) ? row : null;
  return (
    <div className="flex h-full flex-col">
      <ComparisonBar changes={changes} deck={deck.id} enabled={!!shown && comparable(shown, changes)} />
      {shown ? (
        <SlideArea deck={deck} changes={changes} row={shown} />
      ) : row ? (
        <Message title="No changes">
          Every slide is as {changes.commit ? <code>{changes.commit.hash}</code> : "the last commit"} has it.
        </Message>
      ) : (
        <Message title="No slides">This deck has no slides, and the last commit had none either.</Message>
      )}
    </div>
  );
}

function Message({ title, role, children }: { title: string; role?: "alert"; children: React.ReactNode }) {
  return (
    <Empty role={role} className="h-full rounded-none bg-canvas">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <GitCompare />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription className="text-xs/relaxed">{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
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
      <Tooltip disabled={enabled}>
        {/* Why the choice is off, on what is around it: the choices let the pointer through while they are. */}
        <TooltipTrigger render={<span className="shrink-0" />}>
          <ToggleGroup
            aria-label="Show"
            variant="outline"
            size="xs"
            spacing={0}
            disabled={!enabled}
            value={[view]}
            // One of them always shows: pressing the one that does leaves it so.
            onValueChange={([next]) => next && useChanges.getState().setView(next as CompareView)}
          >
            {VIEWS.map((option) => (
              <Tooltip key={option.id}>
                <TooltipTrigger render={<ToggleGroupItem value={option.id} className="px-2 font-medium" />}>
                  {option.label}
                </TooltipTrigger>
                <TooltipContent>{option.title}</TooltipContent>
              </Tooltip>
            ))}
          </ToggleGroup>
        </TooltipTrigger>
        <TooltipContent>This slide has one version to show</TooltipContent>
      </Tooltip>
      <DividerSettings enabled={enabled && view === "split"} />
      <Button variant="ghost" size="icon-xs" tooltip="Refresh" onClick={() => void useChanges.getState().refresh(deck)}>
        <RefreshCw className={cn(loading && "animate-spin")} />
      </Button>
    </div>
  );
}

/** The divider's angle and feather, and putting it back, in a panel behind one button. */
function DividerSettings({ enabled }: { enabled: boolean }) {
  const divider = useChanges((s) => s.divider);
  const { setDivider, resetDivider } = useChanges.getState();
  const [open, setOpen] = useState(false);
  if (!enabled && open) setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            disabled={!enabled}
            tooltip={enabled ? "The divider's angle and feather" : "The divider shows in the split view"}
            className="shrink-0"
          />
        }
      >
        <SlidersHorizontal data-icon="inline-start" />
        Divider
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Divider" className="w-[280px] gap-3 p-3 text-xs text-muted-foreground">
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
          variant="outline"
          size="xs"
          className="self-start"
          tooltip="Put the divider back in the middle, without a feather"
          onClick={resetDivider}
        >
          <RotateCcw data-icon="inline-start" />
          Reset divider
        </Button>
      </PopoverContent>
    </Popover>
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
  const id = useId();
  const clamped = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  return (
    <div className="flex items-center gap-1.5">
      <span id={id} className={cn("w-12 shrink-0", disabled && "opacity-40")}>
        {label}
      </span>
      <Slider
        aria-labelledby={id}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onValueChange={(next) => onChange(Array.isArray(next) ? (next[0] ?? value) : next)}
        className="min-w-0 flex-1"
      />
      <Input
        size="sm"
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
        className="h-6 w-14 bg-background px-1 text-right tabular-nums text-foreground"
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
