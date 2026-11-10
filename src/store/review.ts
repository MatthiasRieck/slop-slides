import { api, type Deck, errorMessage } from "../lib/api";
import { type CommentScope, type PlacedComment, placeComments, type SlideComment } from "../lib/comments";
import type { Stroke } from "../lib/ink";
import { loadFlag, saveFlag } from "./persist";
import type { AppState, AppStore, Slice } from "./types";

/** The review on the slides: ink drawn on them and comments, saved in the deck file and sent to the agent. */
export interface ReviewSlice {
  /**
   * Ink drawn on slides in the editor, by slide id. Saved in the deck file as review marks, and
   * sent along with the next message about the slide while it has changed since last sent.
   */
  sketches: Record<string, Stroke[]>;
  /** The marks each slide had when they were last sent (or skipped), so they go out once. */
  sketchesSent: Record<string, Stroke[]>;
  /** Review marks and comments are shown on the stage (and sent to the agent). */
  reviewVisible: boolean;
  /** Comments on slides, by slide id. Saved in the deck file. */
  comments: Record<string, SlideComment[]>;
  /** Which comments the next message takes along. */
  commentScope: CommentScope;
  /**
   * What comments said when they were last sent or left out, by id: they go out again once
   * changed, or when the user picks them in the composer.
   */
  commentsHeld: Record<string, string>;

  setSketches: (update: (all: Record<string, Stroke[]>) => Record<string, Stroke[]>) => void;
  clearSketch: (slide: string) => void;
  /** Keeps the slide's current marks out of the next message. */
  skipSketch: (slide: string) => void;
  setReviewVisible: (visible: boolean) => void;
  addComment: (slide: string, comment: SlideComment) => void;
  updateComment: (slide: string, id: string, text: string) => void;
  removeComment: (slide: string, id: string) => void;
  setCommentScope: (scope: CommentScope) => void;
  /** Leaves a comment out of the next messages, or takes it along again. */
  setCommentHeld: (comment: SlideComment, held: boolean) => void;
  holdComments: (comments: SlideComment[]) => void;
}

const REVIEW_VISIBLE_KEY = "slopslide.reviewVisible";

/** The comments the composer offers to send: the selected slide's or the deck's, in deck order. */
export function commentsInScope(
  state: Pick<AppState, "deck" | "selected" | "comments" | "commentScope" | "reviewVisible">,
): PlacedComment[] {
  if (!state.deck || !state.reviewVisible) return [];
  const placed = placeComments(state.comments, state.deck.slides);
  return state.commentScope === "deck" ? placed : placed.filter((c) => c.slide === state.selected);
}

/** Whether a comment stays out of the next message: it has not changed since it last went out. */
export function heldComment(state: Pick<AppState, "commentsHeld">, comment: SlideComment): boolean {
  return state.commentsHeld[comment.id] === comment.text;
}

export const createReviewSlice: Slice<ReviewSlice> = (set, _get, app) => ({
  sketches: {},
  sketchesSent: {},
  reviewVisible: loadFlag(REVIEW_VISIBLE_KEY, true),
  comments: {},
  commentScope: "slide",
  commentsHeld: {},

  setSketches: (update) => {
    set((s) => ({ sketches: update(s.sketches) }));
    scheduleReviewSave(app);
  },

  clearSketch: (slide) => {
    set((s) => {
      const { [slide]: _, ...rest } = s.sketches;
      return { sketches: rest };
    });
    scheduleReviewSave(app);
  },

  skipSketch: (slide) => set((s) => ({ sketchesSent: { ...s.sketchesSent, [slide]: s.sketches[slide] ?? [] } })),

  setReviewVisible: (reviewVisible) => {
    saveFlag(REVIEW_VISIBLE_KEY, reviewVisible);
    set({ reviewVisible });
  },

  addComment: (slide, comment) => {
    set((s) => ({ comments: { ...s.comments, [slide]: [...(s.comments[slide] ?? []), comment] } }));
    scheduleReviewSave(app);
  },

  updateComment: (slide, id, text) => {
    set((s) => ({
      comments: { ...s.comments, [slide]: (s.comments[slide] ?? []).map((c) => (c.id === id ? { ...c, text } : c)) },
    }));
    scheduleReviewSave(app);
  },

  removeComment: (slide, id) => {
    set((s) => ({ comments: { ...s.comments, [slide]: (s.comments[slide] ?? []).filter((c) => c.id !== id) } }));
    scheduleReviewSave(app);
  },

  setCommentScope: (commentScope) => set({ commentScope }),

  setCommentHeld: (comment, held) =>
    set((s) => {
      const { [comment.id]: _, ...rest } = s.commentsHeld;
      return { commentsHeld: held ? { ...rest, [comment.id]: comment.text } : rest };
    }),

  holdComments: (comments) =>
    set((s) => ({
      commentsHeld: { ...s.commentsHeld, ...Object.fromEntries(comments.map((c) => [c.id, c.text])) },
    })),
});

const REVIEW_SAVE_DELAY = 400;
let reviewSave: { deckId: string; timer: ReturnType<typeof setTimeout> } | null = null;
/** Review saves still on their way to disk. */
let reviewSaving = 0;
/** The review marks as the deck file holds them, as far as the app knows (see `reviewKey`). */
let savedReview = reviewKey({});
/** The same for the comments. */
let savedComments = reviewKey({});

/** Compares review marks or comments independent of slide order; slides without any don't count. */
function reviewKey(review: Record<string, unknown[]>): string {
  return JSON.stringify(
    Object.entries(review)
      .filter(([, strokes]) => strokes.length > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Notes the review marks and comments of a deck just opened as the ones its file holds. */
export function reviewLoaded(deck: Deck) {
  savedReview = reviewKey(deck.review ?? {});
  savedComments = reviewKey(deck.comments ?? {});
}

/**
 * Takes on review marks and comments changed outside the app's own saves (the agent clearing
 * them, an edit in the HTML view), unless the user's latest ones are still being saved.
 */
export function adoptReview(app: AppStore, deck: Deck) {
  if (reviewSave || reviewSaving > 0) return;
  const review = deck.review ?? {};
  const key = reviewKey(review);
  if (key !== savedReview) {
    savedReview = key;
    if (key !== reviewKey(app.getState().sketches)) app.setState({ sketches: review, sketchesSent: {} });
  }
  const comments = deck.comments ?? {};
  const commentsKey = reviewKey(comments);
  if (commentsKey !== savedComments) {
    savedComments = commentsKey;
    if (commentsKey !== reviewKey(app.getState().comments)) app.setState({ comments });
  }
}

/** Saves the review marks and comments to the deck file once the user pauses. */
function scheduleReviewSave(app: AppStore) {
  const deck = app.getState().deck;
  if (!deck) return;
  if (reviewSave && reviewSave.deckId !== deck.id) void flushReview(app);
  if (reviewSave) clearTimeout(reviewSave.timer);
  reviewSave = { deckId: deck.id, timer: setTimeout(() => void flushReview(app), REVIEW_SAVE_DELAY) };
}

/** Saves review marks and comments still waiting for the user to pause, right away. */
export async function flushReview(app: AppStore) {
  if (!reviewSave) return;
  const { deckId, timer } = reviewSave;
  clearTimeout(timer);
  reviewSave = null;
  const { deck, sketches, comments } = app.getState();
  if (deck?.id !== deckId) return;
  const review = Object.fromEntries(Object.entries(sketches).filter(([, strokes]) => strokes.length > 0));
  const notes = Object.fromEntries(Object.entries(comments).filter(([, list]) => list.length > 0));
  reviewSaving++;
  try {
    // Drawing and undoing back to where the file is leaves nothing to save.
    if (reviewKey(review) !== savedReview) {
      await api.saveReview(deckId, review);
      savedReview = reviewKey(review);
    }
    if (reviewKey(notes) !== savedComments) {
      await api.saveComments(deckId, notes);
      savedComments = reviewKey(notes);
    }
  } catch (error) {
    app.setState({ error: `Could not save the review marks and comments: ${errorMessage(error)}` });
  } finally {
    reviewSaving--;
  }
}
