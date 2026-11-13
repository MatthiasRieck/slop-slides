import { MessageSquare, Trash2, X } from "lucide-react";
import { Fragment, type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  type AreaShape,
  areaFromDrag,
  areaPath,
  type CommentArea,
  type CommentScope,
  type CommentSpot,
  commentTime,
} from "../lib/comments";
import { toFraction } from "../lib/ink";
import { cn } from "../lib/utils";
import { insertTranscript } from "../lib/voice";
import { commentsInScope, heldComment, useApp } from "../store";
import { Popover } from "./Popover";
import { type OpenComment, type SlideComments, useSlideComments } from "./stage/useSlideComments";
import { VoiceInput, type VoiceInputHandle } from "./VoiceInput";

export { type SlideComments, useSlideComments };

/**
 * The numbered pins over the slide; they take the clicks unless `inking` needs the slide. A pin
 * pointed at (or focused) shows what its comment says next to it, and all do when `texts` is on.
 */
export function CommentPins(props: {
  pins: SlideComments;
  inking: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
}) {
  const { pins, inking, anchor } = props;
  const { comments, open } = pins;
  const texts = useApp((s) => s.commentTexts);
  const [pointedAt, setPointedAt] = useState<string | null>(null);
  if (pins.capturing) return null;
  const areas = comments.flatMap((c) => (c.area ? [{ id: c.id, area: c.area }] : []));
  if (open?.area && !open.id) areas.push({ id: "new", area: open.area });
  return (
    <>
      {areas.length > 0 && (
        <svg
          aria-hidden
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 size-full overflow-visible text-primary"
        >
          {areas.map(({ id, area }) => (
            <AreaOutline key={id} area={area} />
          ))}
        </svg>
      )}
      {comments.map((comment, i) => {
        const spot = pins.spotOf(comment);
        const pointed = (on: boolean) => setPointedAt((id) => (on ? comment.id : id === comment.id ? null : id));
        // The editor says it while the comment is open.
        const bubble = (texts || pointedAt === comment.id) && open?.id !== comment.id;
        return (
          <Fragment key={comment.id}>
            <Pin
              ref={open?.id === comment.id ? anchor : undefined}
              mark={String(i + 1)}
              label={`Comment ${i + 1}`}
              title={spot.found ? undefined : "The element it was on is gone."}
              spot={spot}
              inking={inking}
              onClick={() => pins.openComment(comment)}
              onPointed={pointed}
            />
            {bubble && <CommentBubble text={comment.text} spot={spot} raised={pointedAt === comment.id} />}
          </Fragment>
        );
      })}
      {open && !open.id && (
        <Pin
          ref={anchor}
          mark="+"
          label="New comment"
          title="New comment"
          spot={{ x: open.x, y: open.y, found: true }}
          inking={inking}
        />
      )}
    </>
  );
}

/**
 * What a comment says, floating beside its pin: towards the middle of the slide, so it stays in
 * view. It never takes the pointer, so the slide under it stays in reach.
 */
function CommentBubble({ text, spot, raised }: { text: string; spot: CommentSpot; raised: boolean }) {
  const leftwards = spot.x > 0.6;
  return (
    <div
      role="note"
      data-testid="comment-bubble"
      style={{
        left: `${spot.x * 100}%`,
        top: `${spot.y * 100}%`,
        transform: `translate(${leftwards ? "calc(-100% - 4px)" : "28px"}, -24px)`,
      }}
      className={cn(
        "pointer-events-none absolute w-max max-w-56 rounded-md border bg-card px-2 py-1 text-xs leading-snug text-foreground shadow-md",
        raised ? "z-20" : "z-10",
        !spot.found && "opacity-80",
      )}
    >
      <p className="line-clamp-6 whitespace-pre-wrap break-words">{text}</p>
      {!spot.found && <p className="mt-0.5 text-2xs text-muted-foreground">The element it was on is gone.</p>}
    </div>
  );
}

function AreaOutline({ area }: { area: CommentArea }) {
  return (
    <path
      data-testid="comment-area"
      d={areaPath(area)}
      fill="currentColor"
      fillOpacity={0.08}
      stroke="currentColor"
      strokeWidth={2}
      strokeDasharray="6 4"
      vectorEffect="non-scaling-stroke"
    />
  );
}

/**
 * Takes drags over the slide while the area tool is on, showing the outline as it is drawn,
 * and hands over the area once it is let go.
 */
export function AreaDrawer(props: { shape: AreaShape; onArea: (area: CommentArea) => void }) {
  const { shape, onArea } = props;
  const layer = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<[number, number][] | null>(null);
  const at = (event: ReactPointerEvent) =>
    toFraction(event.clientX, event.clientY, layer.current!.getBoundingClientRect());
  const draft = points && (shape === "lasso" ? points : [points[0]!, points.at(-1)!]);

  return (
    <div
      ref={layer}
      data-testid="area-drawer"
      className="pointer-events-auto absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setPoints([at(event)]);
      }}
      onPointerMove={(event) => {
        if (!points) return;
        const point = at(event);
        setPoints((p) => p && (shape === "lasso" ? [...p, point] : [p[0]!, point]));
      }}
      onPointerUp={(event) => {
        if (!points) return;
        const area = areaFromDrag(shape, [...points, at(event)]);
        setPoints(null);
        if (area) onArea(area);
      }}
      onPointerCancel={() => setPoints(null)}
    >
      {draft && draft.length > 1 && (
        <svg
          aria-hidden
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 size-full overflow-visible text-primary"
        >
          <AreaOutline area={{ shape, points: draft }} />
        </svg>
      )}
    </div>
  );
}

function Pin(props: {
  ref?: RefObject<HTMLButtonElement | null>;
  mark: string;
  label: string;
  title?: string;
  spot: CommentSpot;
  inking: boolean;
  onClick?: () => void;
  /** The pointer or the focus came to the pin, or left it. */
  onPointed?: (on: boolean) => void;
}) {
  const { spot } = props;
  return (
    <button
      ref={props.ref}
      type="button"
      data-testid="comment-pin"
      aria-label={props.label}
      title={props.title}
      onClick={props.onClick}
      onPointerEnter={() => props.onPointed?.(true)}
      onPointerLeave={() => props.onPointed?.(false)}
      onFocus={() => props.onPointed?.(true)}
      onBlur={() => props.onPointed?.(false)}
      style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
      className={cn(
        "absolute z-10 flex size-6 -translate-y-full items-center justify-center rounded-full rounded-bl-none border-2 border-background bg-primary text-2xs font-semibold text-primary-foreground shadow-md",
        props.inking ? "pointer-events-none" : "pointer-events-auto",
        !spot.found && "opacity-60",
      )}
    >
      {props.mark}
    </button>
  );
}

/** Writes or changes the open comment, next to its pin. */
export function CommentEditor(props: {
  comment: OpenComment;
  anchor: RefObject<HTMLButtonElement | null>;
  keepOpen: RefObject<(() => void) | null>;
  onClose: () => void;
}) {
  const { comment, anchor, keepOpen, onClose } = props;
  const [text, setText] = useState(comment.text);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Dictation goes in at the caret, showing what was said so far until it is done.
  const voice = useRef<VoiceInputHandle>(null);
  const [dictation, setDictation] = useState<{ start: number; end: number; text: string } | null>(null);
  const dictated = (said: string) =>
    dictation ? insertTranscript(text, said, dictation.start, dictation.end) : { draft: text, caret: text.length };
  const shown = dictation?.text ? dictated(dictation.text).draft : text;

  const save = (written = text) => {
    keepOpen.current = null;
    const next = written.trim();
    const app = useApp.getState();
    if (next && comment.id) {
      if (next !== comment.text) app.updateComment(comment.slide, comment.id, next);
    } else if (next) {
      const { x, y, target, area, time } = comment;
      app.addComment(comment.slide, {
        id: crypto.randomUUID(),
        text: next,
        x,
        y,
        ...(target && { target }),
        ...(area && { area }),
        ...(time !== null && { time }),
      });
      if (comment.shot) app.attachToComposer(comment.shot);
    }
    onClose();
  };
  // While dictating, the words still being transcribed go in first.
  const submit = () => (dictation ? voice.current?.finishAndSend() : save());
  const cancel = () => {
    keepOpen.current = null;
    onClose();
  };
  keepOpen.current = () => save(shown);
  const dictationHandlers = {
    onStart: () => {
      const el = inputRef.current;
      setDictation({ start: el?.selectionStart ?? text.length, end: el?.selectionEnd ?? text.length, text: "" });
    },
    onPartial: (said: string) => setDictation((d) => d && { ...d, text: said }),
    onEnd: (said: string, send: boolean) => {
      setDictation(null);
      const result = said && dictation ? dictated(said) : null;
      if (result) setText(result.draft);
      if (send) return save(result?.draft ?? text);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        if (result) inputRef.current?.setSelectionRange(result.caret, result.caret);
      });
    },
  };

  return (
    <Popover
      anchor={anchor}
      placement={comment.y > 0.6 ? "above" : "below"}
      width={280}
      label={comment.id ? "Comment" : "New comment"}
      onClose={() => save(shown)}
      initialFocus={inputRef}
    >
      <div className="flex flex-col gap-2 p-2">
        {comment.target?.label && (
          <p className="truncate px-1 text-2xs text-muted-foreground">
            On &lt;{comment.target.tag}&gt; “{comment.target.label}”
          </p>
        )}
        {comment.area && (
          <p className="truncate px-1 text-2xs text-muted-foreground">
            On the area inside the {AREA_NAMES[comment.area.shape]}
            {comment.shot && " · its screenshot goes in the chat"}
          </p>
        )}
        {comment.time !== null && (
          <p data-testid="comment-moment" className="truncate px-1 text-2xs text-muted-foreground">
            At {commentTime(comment.time)} after the slide shows
          </p>
        )}
        <textarea
          ref={inputRef}
          value={shown}
          rows={3}
          aria-label="Comment text"
          placeholder="Add a comment…"
          readOnly={!!dictation}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              // Keeps the popover from taking it as a close, which saves.
              e.stopPropagation();
              cancel();
            }
          }}
          className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus:border-input"
        />
        <div className="flex items-center gap-1 text-xs">
          {comment.id && (
            <button
              type="button"
              aria-label="Delete comment"
              title="Delete comment"
              onClick={() => {
                if (comment.id) useApp.getState().removeComment(comment.slide, comment.id);
                cancel();
              }}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-destructive [&_svg]:size-3.5"
            >
              <Trash2 />
            </button>
          )}
          <VoiceInput ref={voice} label="Dictate the comment" portal={false} {...dictationHandlers} />
          <div className="flex-1" />
          <button type="button" onClick={cancel} className="rounded-md px-2 py-1 hover:bg-accent">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!shown.trim() && !dictation}
            className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </Popover>
  );
}

const AREA_NAMES: Record<AreaShape, string> = { rect: "rectangle", ellipse: "ellipse", lasso: "lasso" };

const SCOPES: { id: CommentScope; label: string; title: string }[] = [
  { id: "slide", label: "This slide", title: "Send the comments on this slide" },
  { id: "deck", label: "All slides", title: "Send the comments of the whole presentation" },
];

/**
 * The comments going out with the next message, in the composer: how many, whether they are this
 * slide's or the whole deck's, and a list to pick from. Hidden while the deck has none on show.
 */
export function ComposerComments() {
  const scope = useApp((s) => s.commentScope);
  const visible = useApp((s) => s.reviewVisible && Object.values(s.comments).some((c) => c.length > 0));
  const count = useApp((s) => commentsInScope(s).filter((c) => !heldComment(s, c)).length);
  const [listOpen, setListOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setListOpen(false), []);
  if (!visible) return null;

  return (
    <span
      className={cn(
        "flex h-5 items-center gap-1 rounded-md border px-1.5 text-xs whitespace-nowrap",
        count > 0 ? "border-primary/30 bg-primary/10 text-primary" : "text-muted-foreground",
      )}
    >
      <button
        ref={anchor}
        type="button"
        aria-expanded={listOpen}
        title="Show the comments that go out with your message"
        onClick={() => setListOpen((v) => !v)}
        className="flex shrink-0 items-center gap-1 hover:text-foreground"
      >
        <MessageSquare className="size-3" />
        <span>
          {count} <span className="sr-only @[16rem]:not-sr-only">comment{count === 1 ? "" : "s"}</span>
        </span>
      </button>
      {/* biome-ignore lint/a11y/useSemanticElements: two pressed buttons read better here than a fieldset. */}
      <span role="group" aria-label="Which comments to send" className="flex items-center gap-0.5">
        {SCOPES.map(({ id, label, title }) => (
          <button
            key={id}
            type="button"
            aria-pressed={scope === id}
            title={title}
            onClick={() => useApp.getState().setCommentScope(id)}
            className={cn("rounded px-1 text-2xs hover:text-foreground", scope === id && "bg-background font-medium")}
          >
            {label}
          </button>
        ))}
      </span>
      {count > 0 && (
        <button
          type="button"
          aria-label="Don't send comments"
          title="Don't send these comments; they stay on the slides until they are sent"
          onClick={() => useApp.getState().holdComments(commentsInScope(useApp.getState()))}
          className="hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
      {listOpen && <CommentList anchor={anchor} onClose={close} />}
    </span>
  );
}

/** The comments in scope, each with a box for whether it goes out. */
function CommentList({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const state = useApp(
    useShallow((s) => ({
      deck: s.deck,
      selected: s.selected,
      comments: s.comments,
      commentScope: s.commentScope,
      reviewVisible: s.reviewVisible,
      commentsHeld: s.commentsHeld,
    })),
  );
  const comments = commentsInScope(state);
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      width={300}
      variant="menu"
      portal
      follow
      capture
      className="p-1 shadow-composer"
    >
      {comments.length === 0 && <p className="p-2 text-xs text-muted-foreground">No comments on this slide.</p>}
      {comments.map((comment) => {
        const included = !heldComment(state, comment);
        return (
          <label key={comment.id} className="flex items-start gap-2 rounded-lg p-2 text-xs hover:bg-accent">
            <input
              type="checkbox"
              checked={included}
              aria-label={`Send: ${comment.text}`}
              onChange={() => useApp.getState().setCommentHeld(comment, included)}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-2xs text-muted-foreground">Slide {comment.slideNumber}</span>
              <span className="whitespace-pre-wrap break-words">{comment.text}</span>
            </span>
          </label>
        );
      })}
    </Popover>
  );
}
