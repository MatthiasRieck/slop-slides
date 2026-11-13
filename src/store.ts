// The app's state: one zustand store, `useApp`, made of a slice per concern (see ./store/). This
// module creates it and is what the rest of the app imports the store and its helpers from.
import { create } from "zustand";

import { createChatSlice } from "./store/chat";
import { createComposerSlice } from "./store/composer";
import { createEditingSlice } from "./store/editing";
import { reportingErrorsIn, showErrorIn, showInfoIn, showSuccessIn } from "./store/errors";
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
import { createUiSlice, type ToastAction } from "./store/ui";
import { createWorkspaceSlice, leaveForClose, settleUnsavedEdits as settleDeckEdits } from "./store/workspace";

export { SKETCH_TARGET_ATTR } from "./store/capture";
export { COMPACT_COMMAND } from "./store/chat";
export { type DeckMode, deckMode, editedSlidesOf, editingSlide } from "./store/editing";
export { lastError, toastTexts } from "./store/errors";
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
export { listedSlides, railSelection } from "./store/slides";
export type { DesignChange } from "./store/templates";
export { SIDEBAR_TABS, type SidebarTab, type Toast, type ToastAction, type ToastKind } from "./store/ui";
export { provideCodeSave, type WorkspaceChange } from "./store/workspace";

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

/**
 * Settles the unsaved edits in the sidebar's HTML tab before what would lose them: the user saves
 * them, gives them up, or stays. True when nothing unsaved is left to lose.
 */
export const settleUnsavedEdits = () => settleDeckEdits(useApp);

/**
 * Gets what is open ready for the window to close; false when the user stays, for unsaved edits,
 * for what `alsoAsk` asks about, or for the agent's running turn.
 */
export const leaveForWindowClose = (alsoAsk?: () => Promise<boolean>) => leaveForClose(useApp, alsoAsk);

/** Follows the backend's events: the agent's, changes in the open workspace, and a folder opened from Finder. */
export const initEventBridge = () => bridgeEvents(useApp);

/** Shows what went wrong in the app's toasts, after `prefix` when there is one; it stays until dismissed. */
export const showError = (error: unknown, prefix = "") => showErrorIn(useApp, error, prefix);

/** Tells the user something worth knowing that is no failure; `action` is a button in the toast. It goes away by itself. */
export const showInfo = (text: string, action?: ToastAction) => showInfoIn(useApp, text, action);

/** Tells the user that what they asked for is done; `action` is a button in the toast. It goes away by itself. */
export const showSuccess = (text: string, action?: ToastAction) => showSuccessIn(useApp, text, action);

/** Takes the toast with `id` away. */
export const dismissToast = (id: number) => useApp.getState().dismissToast(id);

/** Opens the list of keyboard shortcuts. */
export const openShortcutHelp = () => useApp.getState().setShortcutHelpOpen(true);

/** Runs `action`, showing what goes wrong in the app's toasts; undefined when it failed. */
export const reportingErrors = <T>(action: () => Promise<T>, prefix = "") => reportingErrorsIn(useApp, action, prefix);
