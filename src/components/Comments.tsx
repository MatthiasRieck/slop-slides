import { MessageSquare, Trash2, X } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  type CommentScope,
  type CommentSpot,
  type CommentTarget,
  parseSpots,
  parseTarget,
  type SlideComment,
} from "../lib/comments";
import { cn } from "../lib/utils";
import { commentsInScope, heldComment, useApp } from "../store";
import { ComposerPopover } from "./ComposerPopover";
import { Popover } from "./Templates";

/** The comment being written or changed; a new one has no id yet. */
interface OpenComment {
  /** Tells apart comments opened one after the other. */
  key: string;
  slide: string;
  id: string | null;
  x: number;
  y: number;
  target: CommentTarget | null;
  text: string;
}

const NO_COMMENTS: SlideComment[] = [];

/**
 * Comments on the slide on the stage, while `shown`: the comment tool, which picks elements in
 * the preview, where the preview found the elements the comments are on, and the open comment.
 */
export function useSlideComments(
  areaRef: RefObject<HTMLDivElement | null>,
  post: (data: unknown) => void,
  shown: boolean,
) {
  const selected = useApp((s) => s.selected);
  const stored = useApp((s) => (s.selected ? s.comments[s.selected] : undefined));
  const comments = shown ? (stored ?? NO_COMMENTS) : NO_COMMENTS;
  const [commenting, setCommenting] = useState(false);
  const [found, setFound] = useState<{ slide: string; spots: Record<string, CommentSpot> } | null>(null);
  const [open, setOpen] = useState<OpenComment | null>(null);
  // Keeps what the open comment says when something else closes it.
  const keepOpen = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      // Keys pressed in the preview after a click on the slide land here.
      if (data?.type === "slop:key" && data.key === "Escape") setCommenting(false);
      if (data?.type !== "slop:comment-pick" && data?.type !== "slop:comment-spots") return;
      const frames = Array.from(areaRef.current?.querySelectorAll("iframe") ?? []);
      if (!frames.some((f) => f.contentWindow === event.source) || data.slide !== useApp.getState().selected) return;
      if (data.type === "slop:comment-spots") {
        setFound({ slide: data.slide, spots: parseSpots(data.spots) });
      } else if ([data.x, data.y].every(Number.isFinite)) {
        keepOpen.current?.();
        setOpen({
          key: crypto.randomUUID(),
          slide: data.slide,
          id: null,
          x: data.x,
          y: data.y,
          target: parseTarget(data.target),
          text: "",
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [areaRef]);

  useEffect(() => {
    post({ type: "slop:comment-tool", on: commenting });
  }, [commenting, post]);
  useEffect(() => {
    post({ type: "slop:comment-locate", comments });
  }, [comments, post]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the open comment belongs to this slide and mode
  useEffect(
    () => () => {
      keepOpen.current?.();
      setOpen(null);
    },
    [selected, shown],
  );

  const spots = found?.slide === selected ? found.spots : null;
  return {
    /** A click on the slide starts a comment on what is under it. */
    commenting,
    setCommenting,
    comments,
    open,
    /** Where a comment's pin goes. */
    spotOf: (comment: SlideComment): CommentSpot => spots?.[comment.id] ?? { ...comment, found: true },
    openComment: (comment: SlideComment) => {
      if (!selected) return;
      keepOpen.current?.();
      setOpen({
        key: crypto.randomUUID(),
        slide: selected,
        id: comment.id,
        x: comment.x,
        y: comment.y,
        target: comment.target ?? null,
        text: comment.text,
      });
    },
    close: useCallback(() => setOpen(null), []),
    keepOpen,
    onFrameReady: () => {
      post({ type: "slop:comment-tool", on: commenting });
      post({ type: "slop:comment-locate", comments });
    },
  };
}

export type SlideComments = ReturnType<typeof useSlideComments>;

/** The numbered pins over the slide; they take the clicks unless `inking` needs the slide. */
export function CommentPins(props: {
  pins: SlideComments;
  inking: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
}) {
  const { pins, inking, anchor } = props;
  const { comments, open } = pins;
  return (
    <>
      {comments.map((comment, i) => {
        const spot = pins.spotOf(comment);
        return (
          <Pin
            key={comment.id}
            ref={open?.id === comment.id ? anchor : undefined}
            mark={String(i + 1)}
            label={`Comment ${i + 1}`}
            title={spot.found ? comment.text : `${comment.text}\n\nThe element it was on is gone.`}
            spot={spot}
            inking={inking}
            onClick={() => pins.openComment(comment)}
          />
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

function Pin(props: {
  ref?: RefObject<HTMLButtonElement | null>;
  mark: string;
  label: string;
  title: string;
  spot: CommentSpot;
  inking: boolean;
  onClick?: () => void;
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
      style={{ left: `${spot.x * 100}%`, top: `${spot.y * 100}%` }}
      className={cn(
        "absolute flex size-6 -translate-y-full items-center justify-center rounded-full rounded-bl-none border-2 border-background bg-primary text-2xs font-semibold text-primary-foreground shadow-md",
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

  const save = () => {
    keepOpen.current = null;
    const next = text.trim();
    const app = useApp.getState();
    if (next && comment.id) {
      if (next !== comment.text) app.updateComment(comment.slide, comment.id, next);
    } else if (next) {
      const { x, y, target } = comment;
      app.addComment(comment.slide, { id: crypto.randomUUID(), text: next, x, y, ...(target && { target }) });
    }
    onClose();
  };
  const cancel = () => {
    keepOpen.current = null;
    onClose();
  };
  keepOpen.current = save;
  useEffect(() => inputRef.current?.focus(), []);

  return (
    <Popover
      anchor={anchor}
      placement={comment.y > 0.6 ? "above" : "below"}
      width={280}
      label={comment.id ? "Comment" : "New comment"}
      onClose={save}
    >
      <div className="flex flex-col gap-2 p-2">
        {comment.target?.label && (
          <p className="truncate px-1 text-2xs text-muted-foreground">
            On &lt;{comment.target.tag}&gt; “{comment.target.label}”
          </p>
        )}
        <textarea
          ref={inputRef}
          value={text}
          rows={3}
          aria-label="Comment text"
          placeholder="Add a comment…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              save();
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
          <div className="flex-1" />
          <button type="button" onClick={cancel} className="rounded-md px-2 py-1 hover:bg-accent">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!text.trim()}
            className="rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </Popover>
  );
}

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
        "flex h-5 items-center gap-1 rounded-md border px-1.5 text-xs",
        count > 0 ? "border-primary/30 bg-primary/10 text-primary" : "text-muted-foreground",
      )}
    >
      <button
        ref={anchor}
        type="button"
        aria-expanded={listOpen}
        title="Show the comments that go out with your message"
        onClick={() => setListOpen((v) => !v)}
        className="flex items-center gap-1 hover:text-foreground"
      >
        <MessageSquare className="size-3" />
        {count} comment{count === 1 ? "" : "s"}
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
          title="Don't send these comments; they stay on the slides"
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
    <ComposerPopover
      anchor={anchor}
      onClose={onClose}
      width={300}
      className="z-50 overflow-y-auto rounded-xl border bg-card p-1 text-foreground shadow-composer"
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
    </ComposerPopover>
  );
}
