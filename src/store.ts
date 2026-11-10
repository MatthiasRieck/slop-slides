// The app's state: one zustand store, `useApp`, made of a slice per concern (see ./store/). This
// module creates it and is what the rest of the app imports the store and its helpers from.
import { create } from "zustand";

import { createChatSlice } from "./store/chat";
import { createComposerSlice } from "./store/composer";
import { createEditingSlice } from "./store/editing";
import { reportingErrorsIn, showErrorIn } from "./store/errors";
import { initEventBridge as bridgeEvents } from "./store/events";
import { createHistorySlice } from "./store/history";
import { createLintSlice } from "./store/lint";
import { createModelsSlice } from "./store/models";
import { createNarrationSlice } from "./store/narration";
import { createReviewSlice, flushReview } from "./store/review";
import { createRewindSlice } from "./store/rewind";
import { createSearchSlice } from "./store/search";
import { createSlidesSlice } from "./store/slides";
import { createTemplatesSlice } from "./store/templates";
import type { AppState } from "./store/types";
import { createUiSlice } from "./store/ui";
import { confirmDiscardEdits as confirmDeckEdits, createWorkspaceSlice } from "./store/workspace";

export { SKETCH_TARGET_ATTR } from "./store/capture";
export { COMPACT_COMMAND } from "./store/chat";
export { type DeckMode, deckMode, editedSlidesOf } from "./store/editing";
export type {
  AssistantMessage,
  ChatMessage,
  ChatPart,
  QueuedMessage,
  SendOptions,
  Sketch,
  UserMessage,
} from "./store/messages";
export { chatProvider, type ModelSelection } from "./store/models";
export { relativePath } from "./store/paths";
export {
  addLayoutPrompt,
  changeLayoutPrompt,
  lintFixPrompt,
  stylePrompt,
  TIDY_ELEMENT_PROMPT,
  TIDY_PROMPT,
  tidyPrompt,
  withRevertNotes,
} from "./store/prompts";
export { commentsInScope, heldComment } from "./store/review";
export { REWIND_KEY, type RewindChoice, rememberedRewind, rememberRewind } from "./store/rewind";
export { activeMatch, type SlideSearch, searchHighlight } from "./store/search";
export { railSelection } from "./store/slides";
export { SIDEBAR_TABS, type SidebarTab } from "./store/ui";
export type { WorkspaceChange } from "./store/workspace";

export const useApp = create<AppState>()((...a) => ({
  ...createWorkspaceSlice(...a),
  ...createSlidesSlice(...a),
  ...createEditingSlice(...a),
  ...createNarrationSlice(...a),
  ...createHistorySlice(...a),
  ...createRewindSlice(...a),
  ...createSearchSlice(...a),
  ...createReviewSlice(...a),
  ...createComposerSlice(...a),
  ...createChatSlice(...a),
  ...createModelsSlice(...a),
  ...createUiSlice(...a),
  ...createTemplatesSlice(...a),
  ...createLintSlice(...a),
}));

/** Saves review marks and comments still waiting for the user to pause, right away. */
export const flushReviewSave = () => flushReview(useApp);

/** Whether the user gives up the unsaved edits in the sidebar's HTML tab. */
export const confirmDiscardEdits = () => confirmDeckEdits(useApp);

/** Follows the backend's events: the agent's, changes in the open workspace, and a folder opened from Finder. */
export const initEventBridge = () => bridgeEvents(useApp);

/** Shows what went wrong in the app's error banner, after `prefix` when there is one. */
export const showError = (error: unknown, prefix = "") => showErrorIn(useApp, error, prefix);

/** Runs `action`, showing what goes wrong in the app's error banner; undefined when it failed. */
export const reportingErrors = <T>(action: () => Promise<T>, prefix = "") => reportingErrorsIn(useApp, action, prefix);
