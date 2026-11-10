import type { StateCreator, StoreApi } from "zustand";

import type { ChatSlice } from "./chat";
import type { ComposerSlice } from "./composer";
import type { EditingSlice } from "./editing";
import type { HistorySlice } from "./history";
import type { LintSlice } from "./lint";
import type { ModelsSlice } from "./models";
import type { NarrationSlice } from "./narration";
import type { ReviewSlice } from "./review";
import type { RewindSlice } from "./rewind";
import type { SearchSlice } from "./search";
import type { SlidesSlice } from "./slides";
import type { TemplatesSlice } from "./templates";
import type { UiSlice } from "./ui";
import type { WorkspaceSlice } from "./workspace";

/** The app's state: one store (`useApp`, see ../store.ts) made of a slice per concern. */
export type AppState = WorkspaceSlice &
  SlidesSlice &
  EditingSlice &
  NarrationSlice &
  HistorySlice &
  RewindSlice &
  SearchSlice &
  ReviewSlice &
  ComposerSlice &
  ChatSlice &
  ModelsSlice &
  UiSlice &
  TemplatesSlice &
  LintSlice;

/** The store, as helpers outside the slices reach it. */
export type AppStore = StoreApi<AppState>;

/** Makes a slice of the store; its actions see the whole state. */
export type Slice<T> = StateCreator<AppState, [], [], T>;
