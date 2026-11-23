import { MessageSquare, Send, Trash2, X } from "lucide-react";
import { Fragment, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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
import { formatKeys } from "../lib/keys";
import { cn, plural } from "../lib/utils";
import { insertTranscript } from "../lib/voice";
import { commentsInScope, commentsToSend, deckComments, hasComments, heldComment, useApp } from "../store";
import { type OpenComment, type SlideComments, useSlideComments } from "./stage/useSlideComments";
import { VoiceInput, type VoiceInputHandle } from "./VoiceInput";

export { type SlideComments, useSlideComments };

/**
 * The numbered pins over the slide; they take the clicks unless `inking` needs the slide. A pin
 * pointed at (or focused) shows what its comment says next to it, and all do when `texts` is on.
 * That bubble is the pin's tooltip: it also says when the element the comment was on is gone.
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
        <Pin ref={anchor} mark="+" label="New comment" spot={{ x: open.x, y: open.y, found: true }} inking={inking} />
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
  spot: CommentSpot;
  inking: boolean;
  onClick?: () => void;
  /** The pointer or the focus came to the pin, or left it. */
  onPointed?: (on: boolean) => void;
}) {
  const { spot } = props;
  return (
    <Button
      ref={props.ref}
      size="icon-xs"
      data-testid="comment-pin"
      aria-label={props.label}
      // It opens the comment's panel; and a button that opens one is not nudged by its press.
      aria-haspopup="dialog"
      onClick={props.onClick}
      onPointerEnter={() => props.onPointed?.(true)}
      onPointerLeave={() => props.onPointed?.(false)}
      onFocus={() => props.onPointed?.(true)}
      onBlur={() => props.onPointed?.(false)}
      style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
      className={cn(
        "absolute z-10 -translate-y-full rounded-full rounded-bl-none border-2 border-background text-2xs font-semibold shadow-md",
        props.inking ? "pointer-events-none" : "pointer-events-auto",
        !spot.found && "opacity-60",
      )}
    >
      {props.mark}
    </Button>
  );
}

/**
 * What a panel anchored to a button that is not its trigger does when it is asked to close. A
 * press on that button is left to the button, which closes the panel itself (or keeps it): taken
 * as a press outside as well, it would close the panel and the button open it again.
 */
function closeBesideAnchor(anchor: RefObject<HTMLElement | null>, close: () => void) {
  return (open: boolean, details: { reason: string; event: Event }) => {
    if (open) return;
    const target = details.event?.target;
    if (details.reason === "outside-press" && target instanceof Node && anchor.current?.contains(target)) return;
    close();
  };
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
  // The panel puts the focus in the field as it shows. A press in the slide preview that opened
  // it can hand the focus to the preview after that: the field takes it back once that has settled.
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (document.activeElement !== inputRef.current) inputRef.current?.focus();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
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
    <Popover open onOpenChange={closeBesideAnchor(anchor, () => save(shown))}>
      <PopoverContent
        anchor={anchor}
        side={comment.y > 0.6 ? "top" : "bottom"}
        align="start"
        aria-label={comment.id ? "Comment" : "New comment"}
        initialFocus={inputRef}
        className="w-[280px] gap-2 p-2"
      >
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
        <Textarea
          ref={inputRef}
          value={shown}
          rows={3}
          aria-label="Comment text"
          placeholder={`Add a comment… ${formatKeys("enter")} saves, ${formatKeys("shift+enter")} adds a line`}
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
          className="resize-none px-2 py-1.5"
        />
        <div className="flex items-center gap-1">
          {comment.id && (
            <Button
              variant="tool"
              size="icon-xs"
              tooltip="Delete comment"
              onClick={() => {
                if (comment.id) useApp.getState().removeComment(comment.slide, comment.id);
                cancel();
              }}
              className="hover:text-destructive"
            >
              <Trash2 />
            </Button>
          )}
          <VoiceInput ref={voice} label="Dictate the comment" portal={false} {...dictationHandlers} />
          <div className="flex-1" />
          <Button variant="ghost" size="xs" onClick={cancel}>
            Cancel
          </Button>
          <Button size="xs" onClick={submit} disabled={!shown.trim() && !dictation}>
            Save
          </Button>
        </div>
      </PopoverContent>
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
  const visible = useApp((s) => s.reviewVisible && hasComments(s));
  const count = useApp(commentsToSend);
  if (!visible) return null;

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 overflow-visible rounded-md px-1 font-normal",
        count > 0 ? "border-primary/30 bg-primary/10 text-primary" : "text-muted-foreground",
      )}
    >
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="2xs"
              tooltip="Show the comments that go out with your message"
              className="h-4 px-0.5 font-normal"
            />
          }
        >
          <MessageSquare />
          <span>
            {count} <span className="sr-only @[16rem]:not-sr-only">comment{count === 1 ? "" : "s"}</span>
          </span>
        </PopoverTrigger>
        <CommentList />
      </Popover>
      <ToggleGroup
        aria-label="Which comments to send"
        size="xs"
        spacing={0.5}
        value={[scope]}
        // One of the two is always on: pressing the one that is leaves it so.
        onValueChange={([next]) => next && useApp.getState().setCommentScope(next as CommentScope)}
      >
        {SCOPES.map(({ id, label, title }) => (
          <Tooltip key={id}>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  value={id}
                  className="h-4 min-w-0 rounded px-1 text-2xs font-normal aria-pressed:bg-background aria-pressed:font-medium"
                />
              }
            >
              {label}
            </TooltipTrigger>
            <TooltipContent>{title}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
      {count > 0 && (
        <Button
          variant="ghost"
          size="icon-2xs"
          aria-label="Don't send comments"
          tooltip="Don't send these comments; they stay on the slides until they are sent"
          onClick={() => useApp.getState().holdComments(commentsInScope(useApp.getState()))}
          className="size-4"
        >
          <X />
        </Button>
      )}
    </Badge>
  );
}

/** The comments in scope, each with a box for whether it goes out: the panel of the composer's count. */
function CommentList() {
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
    <PopoverContent
      side="top"
      align="start"
      aria-label="Comments to send"
      className="max-h-(--available-height) w-[300px] gap-0 overflow-y-auto p-1 shadow-composer"
    >
      {comments.length === 0 && <p className="p-2 text-xs text-muted-foreground">No comments on this slide.</p>}
      {comments.map((comment) => {
        const included = !heldComment(state, comment);
        return (
          <label key={comment.id} className="flex items-start gap-2 rounded-md p-2 text-xs hover:bg-muted">
            <input
              type="checkbox"
              checked={included}
              aria-label={`Send: ${comment.text}`}
              onChange={() => useApp.getState().setCommentHeld(comment, included)}
              className="mt-0.5 accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-2xs text-muted-foreground">Slide {comment.slideNumber}</span>
              <span className="whitespace-pre-wrap break-words">{comment.text}</span>
            </span>
          </label>
        );
      })}
    </PopoverContent>
  );
}

/**
 * Every comment of the deck, grouped by slide, in a panel next to `anchor`: the overview that the
 * pins, one slide at a time, do not give. A comment pressed goes to its slide and opens there;
 * "Send to agent" has the next message take them all along and goes to the chat to write it.
 */
export function CommentsOverview({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const comments = useApp(deckComments);
  const selected = useApp((s) => s.selected);
  const numbers = [...new Set(comments.map((c) => c.slideNumber))];
  const send = () => {
    const app = useApp.getState();
    app.takeAllComments();
    app.focusComposer();
    onClose();
  };
  return (
    <Popover open onOpenChange={closeBesideAnchor(anchor, onClose)}>
      <PopoverContent
        anchor={anchor}
        side="bottom"
        align="start"
        aria-label="Comments"
        className="max-h-(--available-height) w-[340px] gap-0 overflow-hidden p-0"
      >
        <p className="shrink-0 border-b px-3 py-2 text-xs font-medium">
          {comments.length === 0
            ? "No comments yet"
            : `${plural(comments.length, "comment")} on ${plural(numbers.length, "slide")}`}
        </p>
        <div className="min-h-0 flex-1 overflow-y-auto p-1 text-xs">
          {comments.length === 0 && (
            <p className="p-2 leading-relaxed text-muted-foreground">
              Comment on an element or an area of a slide with the tools beside this button. Comments go to the agent
              with your next message.
            </p>
          )}
          {numbers.map((number) => (
            // biome-ignore lint/a11y/useSemanticElements: a labelled group of rows, not a form's fieldset
            <div key={number} role="group" aria-label={`Slide ${number}`}>
              <p className="px-2 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Slide {number}
              </p>
              {comments
                .filter((c) => c.slideNumber === number)
                .map((comment) => (
                  <Button
                    key={comment.id}
                    variant="ghost"
                    size="sm"
                    aria-current={comment.slide === selected ? "true" : undefined}
                    tooltip="Go to this comment"
                    tooltipSide="left"
                    onClick={() => {
                      useApp.getState().showComment(comment.slide, comment.id);
                      onClose();
                    }}
                    className="h-auto w-full items-start justify-start gap-2 px-2 py-1.5 text-left text-xs font-normal whitespace-normal"
                  >
                    <MessageSquare className="mt-0.5 text-muted-foreground" />
                    <span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words">{comment.text}</span>
                  </Button>
                ))}
            </div>
          ))}
        </div>
        <div className="flex shrink-0 justify-end border-t p-2">
          {/* With nothing to send it is plainly off, and has no more to say. */}
          <Button
            size="xs"
            disabled={comments.length === 0}
            tooltip={
              comments.length > 0 &&
              "Takes every comment along with your next message, and goes to the chat to write it"
            }
            onClick={send}
          >
            <Send data-icon="inline-start" />
            Send to agent
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
