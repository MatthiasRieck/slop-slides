import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { api, errorMessage } from "../../lib/api";
import {
  type AreaShape,
  areaBounds,
  areaCapture,
  type CommentArea,
  type CommentSpot,
  type CommentTarget,
  parseSpots,
  parseTarget,
  type SlideComment,
} from "../../lib/comments";
import { dismissTopLayer } from "../../lib/layers";
import { getSlideClock } from "../../lib/slideClock";
import { loadText, trySaveText } from "../../lib/storage";
import { useApp } from "../../store";
import { fromFrameIn } from "./frames";

/** The comment being written or changed; a new one has no id yet. */
export interface OpenComment {
  /** Tells apart comments opened one after the other. */
  key: string;
  slide: string;
  id: string | null;
  x: number;
  y: number;
  target: CommentTarget | null;
  area: CommentArea | null;
  /** A new area comment's screenshot of its area, attached in the composer once it is saved. */
  shot: string | null;
  /** The moment it is about, in seconds since the slide showed; null for the slide whenever. */
  time: number | null;
  text: string;
}

/**
 * The moment the timeline's playhead holds `slide` at on the stage, in seconds since the slide
 * showed, to the hundredth; null when it does not: nothing is held, or the deck is playing on.
 */
export function heldMoment(slide: string): number | null {
  const clock = getSlideClock();
  return clock?.paused && clock.slide === slide ? Math.round(Math.max(0, clock.at) * 100) / 100 : null;
}

const AREA_SHAPE_KEY = "slopslides.areaShape";

function loadAreaShape(): AreaShape {
  const saved = loadText(AREA_SHAPE_KEY);
  return saved === "ellipse" || saved === "lasso" ? saved : "rect";
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * Screenshot of `area` of the slide shown at `slide`, cut to what `stage` shows of it, with the
 * rest made transparent; null when it cannot be taken.
 */
async function captureArea(
  deckId: string,
  area: CommentArea,
  slide: HTMLElement | null,
  stage: HTMLElement | null,
): Promise<string | null> {
  if (!slide || !stage) return null;
  const region = areaCapture(area, slide.getBoundingClientRect(), stage.getBoundingClientRect());
  if (!region) return null;
  // Let the outlines and pins drawn over the slide go first.
  await nextFrame();
  await nextFrame();
  try {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return (await api.captureArea(deckId, region.rect, viewport, region.outline)) ?? null;
  } catch (error) {
    // The area's place still tells the agent where to look.
    console.warn("area screenshot failed:", errorMessage(error));
    return null;
  }
}

const NO_COMMENTS: SlideComment[] = [];

/**
 * Comments on the slide on the stage, while `shown`: the comment tools, one picking elements in
 * the preview and one outlining an area over `slideRef` (the box the slide is shown in), where
 * the preview found the elements the comments are on, and the open comment.
 */
export function useSlideComments(
  areaRef: RefObject<HTMLDivElement | null>,
  post: (data: unknown) => void,
  shown: boolean,
  slideRef: RefObject<HTMLDivElement | null>,
) {
  const selected = useApp((s) => s.selected);
  const stored = useApp((s) => (s.selected ? s.comments[s.selected] : undefined));
  const comments = shown ? (stored ?? NO_COMMENTS) : NO_COMMENTS;
  const [commenting, setPicking] = useState(false);
  const [outlining, setOutlining] = useState(false);
  const [areaShape, setShape] = useState(loadAreaShape);
  // The pins and outlines step aside while an area is screenshot.
  const [capturing, setCapturing] = useState(false);
  // Each tool puts the other away.
  const setCommenting = useCallback((on: boolean) => {
    setPicking(on);
    if (on) setOutlining(false);
  }, []);
  const setDrawingArea = useCallback((on: boolean) => {
    setOutlining(on);
    if (on) setPicking(false);
  }, []);
  const [found, setFound] = useState<{ slide: string; spots: Record<string, CommentSpot> } | null>(null);
  const [open, setOpen] = useState<OpenComment | null>(null);
  // Keeps what the open comment says when something else closes it.
  const keepOpen = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      // Keys pressed in the preview after a click on the slide land here.
      if (data?.type === "slop:key" && data.key === "Escape" && !dismissTopLayer(event)) {
        setPicking(false);
        setOutlining(false);
      }
      if (data?.type !== "slop:comment-pick" && data?.type !== "slop:comment-spots") return;
      if (!fromFrameIn(areaRef.current, event.source) || data.slide !== useApp.getState().selected) return;
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
          area: null,
          shot: null,
          time: heldMoment(data.slide),
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

  // A comment taken off the slide while it is open (sent to the agent) has nothing left to change.
  const openGone = !!open?.id && !comments.some((c) => c.id === open.id);
  useEffect(() => {
    if (!openGone) return;
    keepOpen.current = null;
    setOpen(null);
  }, [openGone]);

  /** Screenshots the area just outlined, then opens a new comment on it. */
  const commentOnArea = async (area: CommentArea) => {
    const { deck, selected: slide } = useApp.getState();
    if (!deck || !slide) return;
    keepOpen.current?.();
    setOpen(null);
    setCapturing(true);
    const shot = await captureArea(deck.id, area, slideRef.current, areaRef.current);
    setCapturing(false);
    if (useApp.getState().selected !== slide) return;
    const { left, top } = areaBounds(area);
    const time = heldMoment(slide);
    setOpen({ key: crypto.randomUUID(), slide, id: null, x: left, y: top, target: null, area, shot, time, text: "" });
  };

  const openComment = (comment: SlideComment) => {
    if (!selected) return;
    keepOpen.current?.();
    setOpen({
      key: crypto.randomUUID(),
      slide: selected,
      id: comment.id,
      x: comment.x,
      y: comment.y,
      target: comment.target ?? null,
      area: comment.area ?? null,
      shot: null,
      time: comment.time ?? null,
      text: comment.text,
    });
  };

  // The list of comments (see `CommentsOverview`) asks for one to be opened, on its slide.
  const asked = useApp((s) => s.commentAsked);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opens once per ask, when its slide and its comments are there
  useEffect(() => {
    if (!asked || asked.slide !== selected || !shown) return;
    const comment = comments.find((c) => c.id === asked.id);
    useApp.getState().commentShown();
    if (comment) openComment(comment);
  }, [asked, selected, shown, comments]);

  const spots = found?.slide === selected ? found.spots : null;
  return {
    /** A click on the slide starts a comment on what is under it. */
    commenting,
    setCommenting,
    /** A drag over the slide outlines an area to comment on, in the shape `areaShape`. */
    drawingArea: outlining,
    setDrawingArea,
    areaShape,
    setAreaShape: useCallback((shape: AreaShape) => {
      setShape(shape);
      trySaveText(AREA_SHAPE_KEY, shape);
    }, []),
    commentOnArea,
    capturing,
    comments,
    open,
    /** Where a comment's pin goes. */
    spotOf: (comment: SlideComment): CommentSpot => spots?.[comment.id] ?? { ...comment, found: true },
    openComment,
    close: useCallback(() => setOpen(null), []),
    keepOpen,
    onFrameReady: () => {
      post({ type: "slop:comment-tool", on: commenting });
      post({ type: "slop:comment-locate", comments });
    },
  };
}

export type SlideComments = ReturnType<typeof useSlideComments>;
