import { Channel, invoke as send } from "@tauri-apps/api/core";
import type { SlideComment } from "./comments";
import type { ExportScope, ImageOptions, PdfOptions, WebPageOptions } from "./exportOptions";
import type { Stroke } from "./ink";
import type { Provider, ProviderInfo } from "./models";
import type { Approval, ApprovalDecision, PermissionMode } from "./permissions";
import { trackingSaves } from "./saves";
import type { SizeInfo, SlideSize } from "./slideSize";
import type { VideoOptions, VideoOutput } from "./video";

/** Every command goes through here, so the top bar can say when the deck is being saved (see ./saves.ts). */
const invoke = trackingSaves(send);

/** What a workspace file is, which decides what it opens in (see src-tauri/src/workspace.rs). */
export type FileKind = "directory" | "deck" | "slideshow" | "webpage" | "file";

/** A file or folder in the open workspace. */
export interface WorkspaceEntry {
  name: string;
  /** Workspace-relative, `/`-separated. */
  path: string;
  kind: FileKind;
  /**
   * For a deck's folder (one holding a `deck.html` that is a SlopSlide deck): the deck's title.
   * The file tree shows such a folder as the deck (see src-tauri/src/file_ops.rs).
   */
  deckTitle?: string;
}

/** What a search of the workspace's files found (see `api.searchFiles`). */
export interface FileSearch {
  found: WorkspaceEntry[];
  /** There may be more: the search stopped at its limit. */
  truncated: boolean;
}

/** The start of a text file, for the file viewer (see `api.readTextFile`). */
export interface TextPreview {
  text: string;
  /** The file is longer than what is shown. */
  truncated: boolean;
}

/** Something an import or an export changed or left out, and the slides (numbered from 1) it is about; none when it is about all of them. */
export interface ConversionChange {
  what: string;
  slides: number[];
}

/** A font a PowerPoint file names, and the slides set in it; none when it is the presentation's own, used throughout. */
export interface FontUse {
  name: string;
  slides: number[];
}

/** A deck made from a PowerPoint file, what could not come along as it was, and the fonts the file names. */
export interface ImportedPptx {
  deck: Deck;
  changes: ConversionChange[];
  fonts: FontUse[];
}

/** Payload of `pptx-import-progress` events: reading slide `slide` of `slides`, from 1. */
export interface ImportProgress {
  slide: number;
  slides: number;
}

/** Payload of `export-progress` events: `done` of `total` slides of the export `job`. */
export interface ExportProgress {
  job: string;
  done: number;
  total: number;
}

/** What a PowerPoint export did not keep of the deck. */
export interface ExportedPptx {
  changes: ConversionChange[];
}

/** Where slide images were saved: one image's file, or the folder of several, and how many. */
export interface SavedImages {
  path: string;
  count: number;
}

/** A workspace file the user opened, with the viewer it needs. */
export interface OpenedFile {
  /** Workspace-relative, `/`-separated. */
  path: string;
  /** Absolute path: a deck's id, and what the viewer loads the file by. */
  absolute: string;
  kind: FileKind;
}

export interface WorkspaceInfo {
  path: string;
  name: string;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  openedMs: number;
}

/** A deck opened before, for the start screen to open again. */
export interface RecentDeck {
  /** The deck file's absolute path: the deck's id. */
  path: string;
  title: string;
  /** The folder it opens in. */
  workspace: string;
  openedMs: number;
}

/** A deck on the start screen: one of the library's, or one opened before. */
export interface GalleryDeck {
  /** The deck file's absolute path: the deck's id. */
  path: string;
  title: string;
  /** The folder it opens in. */
  workspace: string;
  /** When the deck file last changed, in milliseconds since the Unix epoch. */
  modifiedMs: number;
  /** When it was last opened here; null for a deck that is not among the recent ones. */
  openedMs: number | null;
  /** Its slide size, which is the shape of its preview. */
  size: SizeInfo;
}

export interface Slide {
  /** The slide's `id` attribute in the deck file. */
  id: string;
  /** Changes when the slide's markup changes. */
  hash: string;
  /** Has `data-hidden`: skipped when presenting, shown muted in the editor. */
  hidden: boolean;
  /** Has `data-locked`: neither the user nor the agent can change it until it is unlocked. */
  locked: boolean;
  /** Has elements moved by hand (`data-moved`) that the agent has not tidied up yet. */
  moved: boolean;
  /** What is said over the slide (its `<aside class="narration">`), as plain text; empty without any. */
  narration?: string;
  /** What the presenter reads alongside it (its `<aside class="notes">`), as plain text; empty without any. */
  notes?: string;
  /** The seconds the presenter expects to spend on it (its `data-time`); 0 or missing without any. */
  time?: number;
  /** How long the narration timeline shows it, in seconds (its `data-duration`); automatic without any. */
  duration?: number | null;
  /** When its narration starts, in seconds after the slide does (its `data-narration-start`); earlier when negative. */
  narrationStart?: number | null;
}

/** A slide's markup in the deck file, and its hash (see `Slide.hash`). */
export interface SlideSource {
  markup: string;
  hash: string;
}

/** What a slide's timing on the narration timeline becomes; null removes that part of it. */
export interface SlideTiming {
  slide: string;
  duration: number | null;
  narrationStart: number | null;
}

/** What a change from the slide rail did. The deck's history takes it back. */
/** What giving every slide a background did (see `setBackgroundOfAll`). */
export interface BackgroundEdit {
  deck: Deck;
  /** How many slides it changed. */
  changed: number;
}

export interface RailEdit {
  deck: Deck;
  /** Ids of the slides it added. */
  created: string[];
}

/** A named group of slides, started by a marker between slides in the deck file. */
export interface Section {
  /** Position among the deck's section markers, in document order. */
  index: number;
  title: string;
  /** Number of slides before the marker: the section starts at the slide with this index. */
  before: number;
}

export interface Deck {
  /** The deck file's absolute path. */
  id: string;
  title: string;
  /** The deck file's absolute path (the same as `id`). */
  path: string;
  slides: Slide[];
  sections: Section[];
  /** Changes when anything outside the slides (styles, fonts) changes. */
  shellHash: string;
  /** Review marks the user drew, by slide id, stored in the deck file. */
  review?: Record<string, Stroke[]>;
  /** Comments on slides, by slide id, stored in the deck file. */
  comments?: Record<string, SlideComment[]>;
  /** Id of the template the deck's design comes from (its `slopslide-template` meta). */
  template?: string | null;
  /** Every slide's canvas (its `slopslide-size` meta); 1920×1080 px when missing. */
  size?: SizeInfo;
  /** The voice and language its narration is said in (its `slopslide-narration-*` metas). */
  narration?: NarrationSettings;
}

export interface NarrationSettings {
  /** Who says it: one of SpeechStatus.providers' ids (its `slopslide-narration-provider` meta); "local" when missing. */
  provider?: string;
  /** One of its provider's voices' ids. */
  voice: string;
  /** One of SpeechStatus.languages' ids. */
  language: string;
}

/** A deck of example layouts in one style; each slide is a layout for new or changed slides. */
export interface TemplateSummary {
  id: string;
  title: string;
  /** Ships with the app; otherwise it is the user's, in `~/.slopslides/templates/<id>`. */
  builtin: boolean;
  /** Folder of a user template. */
  path: string | null;
  /** Slide ids, one per layout, in order. */
  slides: string[];
  /** The template's slide size, which a deck made from it takes. */
  size?: SizeInfo;
}

/** What pasting into a deck brings in (see `paste_from_clipboard`). */
export type Pasted =
  | { kind: "element"; html: string }
  | { kind: "images"; images: string[] }
  | { kind: "text"; text: string }
  /** A slide copied from the slide rail: it goes in as a new slide (see `pasteSlides`). */
  | { kind: "slide" }
  | { kind: "nothing" };

export interface CreatedSlide {
  deck: Deck;
  slide: string;
}

/** What made a change in a deck's history (see src-tauri/src/history.rs). */
export type HistorySource =
  | "open"
  | "external"
  | "edit"
  | "rail"
  | "review"
  | "narration"
  | "notes"
  | "deck"
  | "code"
  | "chat";

/** One version in a deck's undo history, with the change that made it. */
export interface HistoryEntry {
  id: string;
  source: HistorySource;
  label: string;
  /** Milliseconds since the Unix epoch. */
  time: number;
  /** The chat message whose agent turn made the change. */
  message?: string;
}

/** What undo and redo would do in a deck now. */
export interface DeckHistory {
  /** The change undo takes back. */
  undo: HistoryEntry | null;
  /** The change redo makes again. */
  redo: HistoryEntry | null;
  /** The version the deck is at. */
  current: string | null;
}

/** Every version kept of a deck, for going back to one of them. */
export interface DeckVersions {
  /** The newest first, each with the change that made it. */
  entries: HistoryEntry[];
  /** The version the deck is at: the ones before it in `entries` were undone. */
  current: string | null;
}

/** What an undo or redo did: the deck it left, the change it took back or made again. */
export interface HistoryStep {
  deck: Deck;
  entry: HistoryEntry | null;
  status: DeckHistory;
}

/** How find and replace matches (see src-tauri/src/find.rs). */
export interface FindOptions {
  matchCase: boolean;
  /** Only where the query is not part of a longer word. */
  wholeWord: boolean;
}

/** One place the query is found on a slide, with some of the text around it. */
export interface FindMatch {
  slide: string;
  /** The slide's position in the deck, from 0. */
  index: number;
  /** Locked slides are found but never changed. */
  locked: boolean;
  /** In the slide's notes or narration, which the slide doesn't show. */
  notes: boolean;
  before: string;
  text: string;
  after: string;
}

export interface ReplacedText {
  deck: Deck;
  count: number;
  /** Slides that changed. */
  slides: string[];
  /** Locked slides with matches, left as they were. */
  skipped: string[];
}

export interface LintIssue {
  /** Rule id, e.g. `unclosed-tag` (see src-tauri/src/lint.rs). */
  rule: string;
  severity: "error" | "warning";
  message: string;
  /** 1-based line in the deck file. */
  line: number;
  slide: string | null;
}

export type AgentEvent =
  | { type: "approvalRequested"; approval: Approval }
  | { type: "approvalResolved"; id: string }
  | { type: "approvalReview"; id: string; status: string; detail: string | null }
  | { type: "openFile"; path: string }
  | { type: "started"; sessionId: string | null }
  | { type: "thinking" }
  | { type: "textStart" }
  | { type: "textDelta"; text: string }
  | { type: "toolUse"; id: string; name: string; input: Record<string, unknown> }
  | { type: "toolResult"; id: string; isError: boolean; output: string | null; images: string[] }
  | {
      type: "result";
      isError: boolean;
      text: string | null;
      costUsd: number | null;
      durationMs: number | null;
    }
  | { type: "error"; message: string }
  /** A null field is not known from this event; keep what was known before. */
  | { type: "usage"; contextTokens: number | null; contextWindow: number | null }
  | { type: "compacting" }
  | { type: "compacted" }
  /** The user's message `message` went into the running turn; what follows answers it. */
  | { type: "steered"; message: string | null }
  | { type: "finished"; interrupted: boolean };

export interface AgentEventEnvelope {
  /** The chat the event belongs to: a deck's id, or a folder's path for its own chat. */
  chat: string;
  event: AgentEvent;
}

export interface WorkspaceChanged {
  /** The workspace folder, as it was opened. */
  root: string;
  /** Workspace-relative, `/`-separated. */
  paths: string[];
}

/** Voice input's state (see src-tauri/src/voice.rs). */
export interface VoiceStatus {
  /** The speech model is downloaded, so recording can start at once. */
  modelReady: boolean;
  /** The model's download size. */
  modelBytes: number;
  downloading: boolean;
  recording: boolean;
}

/** A voice narration can be said in (see src-tauri/src/narration/). */
export interface NarrationVoice {
  id: string;
  name: string;
  description: string;
}

/** Where a hosted provider's API key comes from: saved in the app, or its environment variable. */
export type SpeechKeySource = "saved" | "environment";

/** A hosted service that can say narration with the user's API key (see src-tauri/src/narration/cloud.rs). */
export interface NarrationProvider {
  id: string;
  name: string;
  /** Where its key comes from; null while it has none. */
  key: SpeechKeySource | null;
  /** Its voices, the default first. */
  voices: NarrationVoice[];
  /** Whether it takes a note on the manner narration is said in (see `NarrationDelivery.style`). */
  takesStyle?: boolean;
}

/** How fast narration is said. */
export type NarrationPace = "slower" | "normal" | "faster";

/** The times a deck plays with wherever it plays by itself: the timeline, the show's Play, a video. */
export interface NarrationTiming {
  /** How long a slide without narration shows, in seconds. */
  secondsPerSlide: number;
  /** Silence before and after a slide's narration, in seconds. */
  pauseBefore: number;
  pauseAfter: number;
}

/**
 * What a deck keeps next to its audio (in `narration/manifest.json`) of how its narration is said
 * and timed. Each part is missing until the deck sets it: the app's times, a normal pace, no style.
 */
export interface DeckNarrationSettings {
  timing?: NarrationTiming;
  pace?: NarrationPace;
  /** A note on the manner it is said in, like "warm and calm"; only some services take one. */
  style?: string;
}

export interface NarrationLanguage {
  /** ISO 639-1 code. */
  id: string;
  name: string;
}

/** What narration can do on this machine (see src-tauri/src/narration/mod.rs). */
export interface SpeechStatus {
  /** The deck whose narration is being said, if any. */
  rendering: string | null;
  /** Who can say narration, the default first. */
  providers: NarrationProvider[];
  languages: NarrationLanguage[];
}

/** Whether a slide's audio matches its narration: none without narration or recording, stale when made from another script, voice or language. */
export type AudioState = "none" | "missing" | "stale" | "ready";

export interface SlideAudio {
  slide: string;
  state: AudioState;
  /** How long the audio there plays (stale audio too); null without any. */
  seconds: number | null;
  /** It is the presenter's own recording, or audio made elsewhere: up to date whatever the script says. */
  recorded?: boolean;
  /** It is audio made elsewhere, brought in by the agent (`set_narration_audio`). */
  imported?: boolean;
  /** When each of its words is said is known (see `timeNarration`). */
  timed?: boolean;
}

/** A word said in a slide's narration audio, and when: seconds from the audio's start. */
export interface NarrationWord {
  text: string;
  start: number;
  end: number;
}

/** Payload of `narration-timing` events. */
export interface NarrationTimingProgress {
  deck: string;
  /** The slide being heard now; null once all are done. */
  slide: string | null;
  done: number;
  total: number;
}

/** What recording narration in the presenter view keeps: the words, or the voice. */
export type NarrationRecordMode = "text" | "audio";

/** Payload of `narration-render` events. */
export interface NarrationRenderProgress {
  deck: string;
  /** The slide being said now; null once all are done. */
  slide: string | null;
  done: number;
  total: number;
}

/** Payload of `voice-download` events. */
export interface VoiceDownloadProgress {
  received: number;
  total: number;
}

/** How a slide differs from the last commit (see src-tauri/src/git.rs). */
export type SlideStatus = "added" | "removed" | "modified" | "moved" | "unchanged";

/** A text of a slide that changed, as it was and as it is; either is empty when the text is new or gone. */
export interface TextChange {
  where: "slide" | "notes" | "narration";
  before: string;
  after: string;
}

export interface SlideChange {
  /** Tells the rows of the list apart. */
  key: string;
  status: SlideStatus;
  /** The slide's id in the deck; null for a removed slide. */
  id: string | null;
  /** The slide's id at the commit; null for an added slide. */
  oldId: string | null;
  /** What changed that the slide's picture may not show, such as its speaker notes. */
  details: string[];
  /** The texts of a modified slide that changed: on the slide, in its notes, in its narration. */
  textChanges: TextChange[];
  /** It is elsewhere in the deck than at the commit, whatever else changed. */
  moved: boolean;
  /** Its number in the deck at the commit; null for an added slide. */
  oldNumber: number | null;
  /** The index has the slide as it is now. */
  staged: boolean;
  /** The index has the slide where it is now. */
  moveStaged: boolean;
}

/** What discarding changes did: the deck now, and how many files around it went back too, which undo does not bring back. */
export interface Discarded extends RailEdit {
  files: number;
}

/** A change to stage or restore. */
export type Change =
  | { kind: "slide"; id: string | null; oldId: string | null }
  | { kind: "move"; id: string; oldId: string }
  | { kind: "styles" };

/** The deck compared with the last commit. */
export interface DeckChanges {
  tracking: "noRepository" | "notCommitted" | "committed";
  /** The branch checked out, which the next commit goes to; null outside a repository and while `detached`. */
  branch: string | null;
  /** A commit is checked out rather than a branch, so the next commit is on no branch. */
  detached: boolean;
  /** The commit compared with; `hash` reloads what is shown from it when it changes. */
  commit: { hash: string; subject: string /** When it was made, in seconds since 1970. */; time: number } | null;
  /** Something every slide shares changed, so any of them may look different. */
  stylesChanged: boolean;
  /** Every slide's canvas at the commit. */
  oldSize: SizeInfo | null;
  /** The deck's slides in order, with the removed ones where they used to be. */
  slides: SlideChange[];
  /** The index has the shared styles as they are now. */
  stylesStaged: boolean;
  /** How many files the next commit takes in. */
  stagedFiles: number;
  /** How many of those are outside the deck's folder. */
  stagedElsewhere: number;
  /** The deck or its folder has something the index does not. */
  hasUnstaged: boolean;
}

/** An attached screen (see src-tauri/src/screens.rs). */
export interface Screen {
  /** Position in the list, which `presentOn` takes. */
  index: number;
  name: string;
  /** Where it sits, in the desktop's units (one unit for all screens). */
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  primary: boolean;
}

export const api = {
  /** The attached screens, left to right. */
  listScreens: () => invoke<Screen[]>("list_screens"),
  /**
   * A screenshot (data URL) of each screen in `listScreens`, or null where there is none.
   * `onGrabbed` is called when the screens are captured: what appears on them later isn't in the
   * screenshots, which take a moment longer.
   */
  screenPreviews: (onGrabbed: () => void) =>
    invoke<(string | null)[]>("screen_previews", { grabbed: new Channel<null>(onGrabbed) }),
  /** Moves this window to the `audience` screen and opens the presenter view on `presenter`. */
  presentOn: (audience: number, presenter: number | null) => invoke<void>("present_on", { audience, presenter }),
  /** Opens the presenter view in a window of its own; this window stays where and as it is. */
  presentInWindows: () => invoke<void>("present_in_windows"),
  /** Closes the presenter view window, if open. */
  closePresenterView: () => invoke<void>("close_presenter_view"),
  /** Puts this window back where it was before `presentOn` moved it, once it has left full screen. */
  restoreShowWindow: () => invoke<void>("restore_show_window"),
  /** Keeps the display from sleeping while this window presents (`on`), or no longer. */
  keepAwake: (on: boolean) => invoke<void>("keep_awake", { on }),
  /** Opens another app window, on the start screen; each window has a folder of its own. */
  newWindow: () => invoke<void>("new_window"),
  /**
   * Which of the menu bar's commands cannot run, and which are on, for this window: the menu bar
   * shows it while this window has the focus (see src-tauri/src/menu.rs).
   */
  setMenuState: (state: { disabled: string[]; checked: string[] }) => invoke<void>("set_menu_state", { state }),
  /** The folder opened from Finder that is waiting to open in this window, once; null without one. */
  takePendingFolder: () => invoke<string | null>("take_pending_folder"),
  /** Opens a folder: the file tree shows it and the app serves and watches its files. */
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  closeWorkspace: () => invoke<void>("close_workspace"),
  /** Folders opened before, newest first. */
  recentWorkspaces: () => invoke<RecentWorkspace[]>("recent_workspaces"),
  forgetWorkspace: (path: string) => invoke<void>("forget_workspace", { path }),
  /** Decks opened before, newest first. */
  recentDecks: () => invoke<RecentDeck[]>("recent_decks"),
  forgetDeck: (path: string) => invoke<void>("forget_deck", { path }),
  /** `~/Documents/SlopSlide`, where decks lived before workspaces. */
  libraryFolder: () => invoke<string>("library_folder"),
  /** The decks of the start screen: the ones opened before and the library's, the newest first. */
  deckGallery: () => invoke<GalleryDeck[]>("deck_gallery"),
  /** The folder the deck file at `path` opens in when it is opened by itself (picked, or dropped on the window). */
  deckWorkspace: (path: string) => invoke<string>("deck_workspace", { path }),
  /** One folder of the open workspace (`""` for its root), folders first. */
  listDir: (path: string) => invoke<WorkspaceEntry[]>("list_dir", { path }),
  /** The files and folders anywhere in the open workspace whose name, or whose deck's title, holds `query`. */
  searchFiles: (query: string) => invoke<FileSearch>("search_files", { query }),
  /** Renames a file or folder of the open workspace where it is; its new workspace-relative path. */
  renameEntry: (path: string, name: string) => invoke<string>("rename_entry", { path, name }),
  /** Makes a "New folder" in the folder `parent` (`""` for the root); its workspace-relative path. */
  createFolder: (parent: string) => invoke<string>("create_folder", { parent }),
  /** Moves a file or folder of the open workspace to the system's trash. */
  trashEntry: (path: string) => invoke<void>("trash_entry", { path }),
  /** The start of a text file of the open workspace; refused for a file that is not text. */
  readTextFile: (path: string) => invoke<TextPreview>("read_text_file", { path }),
  /** Opens a file of the open workspace in the app the system opens it in; refused for what would run. */
  openInDefaultApp: (path: string) => invoke<void>("open_in_default_app", { path }),
  /** A file of the open workspace, with the viewer it opens in. */
  openFile: (path: string) => invoke<OpenedFile>("open_file", { path }),
  /** Converts a PowerPoint file into a new deck in the workspace; the file itself stays as it is. */
  importPptx: (path: string) => invoke<ImportedPptx>("import_pptx", { path }),
  /** Creates `<workspace>/<title>/deck.html`; with a template, it takes its styles (and names it). */
  createDeck: (title: string, template: string | null = null) => invoke<Deck>("create_deck", { title, template }),
  /** Creates an example deck with slides in the workspace, for a first look at the app. */
  createExampleDeck: () => invoke<Deck>("create_example_deck"),
  /** Copies deck `id`, with its folder when it has one of its own, as "<title> copy"; resolves to the copy's id. */
  duplicateDeck: (id: string) => invoke<string>("duplicate_deck", { id }),
  /** Moves deck `id` (and its own folder) to the system's trash. Refused while it is open in a window. */
  trashDeck: (id: string) => invoke<void>("trash_deck", { id }),
  /**
   * Opens deck `id` in this window, whose chat becomes the deck's. A deck open in another window
   * is refused and shown there (not when `quiet`). With `keepChat`, the folder's own chat stays:
   * it made the deck and is still at work on it.
   */
  openDeck: (id: string, options: { keepChat?: boolean; quiet?: boolean } = {}) =>
    invoke<Deck>("open_deck", { id, keepChat: options.keepChat ?? false, quiet: options.quiet ?? false }),
  /** Closes this window's deck: the chat is the folder's own again. Refused while another window shows that chat. */
  closeDeck: () => invoke<void>("close_deck"),
  loadDeck: (id: string) => invoke<Deck>("load_deck", { id }),
  /** Stores the review marks (by slide id) in the deck file. */
  saveReview: (id: string, review: Record<string, Stroke[]>) => invoke<void>("save_review", { id, review }),
  /** Stores the comments (by slide id) in the deck file. */
  saveComments: (id: string, comments: Record<string, SlideComment[]>) =>
    invoke<void>("save_comments", { id, comments }),
  renameDeck: (id: string, title: string) => invoke<Deck>("rename_deck", { id, title }),
  /** `slides` lists every slide id and section key (see `sectionKey`) in the new order. */
  reorderSlides: (id: string, slides: string[]) => invoke<RailEdit>("reorder_slides", { id, slides }),
  addSlide: (id: string, after: string | null) => invoke<CreatedSlide>("add_slide", { id, after }),
  /** Puts a copy of each of `slides` right after it. */
  duplicateSlides: (id: string, slides: string[]) => invoke<RailEdit>("duplicate_slides", { id, slides }),
  setSlidesHidden: (id: string, slides: string[], hidden: boolean) =>
    invoke<RailEdit>("set_slides_hidden", { id, slides, hidden }),
  setSlideLocked: (id: string, slide: string, locked: boolean) =>
    invoke<Deck>("set_slide_locked", { id, slide, locked }),
  /** Locks or unlocks `slides`, as one change to the deck. */
  setSlidesLocked: (id: string, slides: string[], locked: boolean) =>
    invoke<Deck>("set_slides_locked", { id, slides, locked }),
  /** Sets the seconds expected on a slide; 0 removes them. */
  setSlideTime: (id: string, slide: string, seconds: number) => invoke<Deck>("set_slide_time", { id, slide, seconds }),
  /** Sets the timing of slides on the narration timeline, all in one write. */
  setSlideTiming: (id: string, timing: SlideTiming[]) => invoke<RailEdit>("set_slide_timing", { id, timing }),
  /** Sets what is said over the slide; empty `text` removes its narration. */
  setSlideNarration: (id: string, slide: string, text: string) =>
    invoke<Deck>("set_slide_narration", { id, slide, text }),
  /** Sets the slide's speaker notes; empty `text` removes them. */
  setSlideNotes: (id: string, slide: string, text: string) => invoke<Deck>("set_slide_notes", { id, slide, text }),
  /** Gives every slide the canvas `size` (the slides' content stays as it is). */
  setSlideSize: (id: string, size: SlideSize) => invoke<Deck>("set_slide_size", { id, size }),
  addSection: (id: string, before: string | null, title: string) => invoke<Deck>("add_section", { id, before, title }),
  renameSection: (id: string, index: number, title: string) => invoke<Deck>("rename_section", { id, index, title }),
  deleteSection: (id: string, index: number) => invoke<Deck>("delete_section", { id, index }),
  /** Deletes section `index` along with `slides`, the slides it holds, as one change to the deck. */
  deleteSectionSlides: (id: string, index: number, slides: string[]) =>
    invoke<RailEdit>("delete_section_slides", { id, index, slides }),
  /** Deletes `slides` along with their review marks; none of them if any is locked. */
  deleteSlides: (id: string, slides: string[]) => invoke<RailEdit>("delete_slides", { id, slides }),
  /**
   * Replaces one slide's markup; refused when the slide's hash is no longer `base`. `group` names
   * a run of small edits that belong together (the editor's arrow-key nudges of the same
   * elements): their saves, close together, are one step to undo.
   */
  updateSlide: (id: string, slide: string, markup: string, base: string, group?: string) =>
    invoke<Deck>("update_slide", { id, slide, markup, base, group }),
  /**
   * Gives every slide that is not locked `color` as its own background (null: the deck's own
   * again), as one step to undo and one write of the deck; says how many slides it changed.
   */
  setBackgroundOfAll: (id: string, color: string | null) =>
    invoke<BackgroundEdit>("set_background_of_all", { id, color }),
  /**
   * The slide picture at `url` (see `pictureUrl`) is no longer shown where it was asked for:
   * unless it is shown elsewhere too, the backend does not make it when its turn comes.
   */
  forgetThumbnail: (url: string) => invoke<void>("forget_thumbnail", { url }),
  /** One slide's markup as it is in the file, with the hash `updateSlide` takes as its base. */
  slideSource: (id: string, slide: string) => invoke<SlideSource>("slide_source", { id, slide }),
  saveDeckSource: (id: string, source: string, base: string | null) =>
    invoke<Deck>("save_deck_source", { id, source, base }),
  /** What undo and redo would do in the deck; notices changes made outside the app first. */
  deckHistory: (id: string) => invoke<DeckHistory>("deck_history", { id }),
  /** Takes back the deck's newest change, whatever made it. */
  undoDeck: (id: string) => invoke<HistoryStep>("undo_deck", { id }),
  /** Makes the change undone last again. */
  redoDeck: (id: string) => invoke<HistoryStep>("redo_deck", { id }),
  /** Every version kept of the deck, the newest first. */
  deckVersions: (id: string) => invoke<DeckVersions>("deck_versions", { id }),
  /** Puts the deck back as it was at `version`, as one change that undo takes back. */
  restoreVersion: (id: string, version: string) => invoke<HistoryStep>("restore_version", { id, version }),
  /** Puts `slides` back as they were at version `since` of the deck's history. */
  restoreSlides: (id: string, since: string, slides: string[]) => invoke<Deck>("restore_slides", { id, since, slides }),
  /** Where `query` is found in the text on the deck's slides (and their notes). */
  findInDeck: (id: string, query: string, options: FindOptions) =>
    invoke<FindMatch[]>("find_in_deck", { id, query, options }),
  /** Replaces `query` in the text of the deck's slides, or only of `slides`; locked slides are left alone. */
  replaceInDeck: (id: string, query: string, replacement: string, options: FindOptions, slides: string[] | null) =>
    invoke<ReplacedText>("replace_in_deck", { id, query, replacement, options, slides }),
  /** Replaces one match of `query`: the `nth` on `slide`, from 0, in the order `findInDeck` lists that slide's. */
  replaceMatchInDeck: (
    id: string,
    query: string,
    replacement: string,
    options: FindOptions,
    slide: string,
    nth: number,
  ) => invoke<ReplacedText>("replace_match_in_deck", { id, query, replacement, options, slide, nth }),
  importAssets: (id: string, paths: string[]) => invoke<string[]>("import_assets", { id, paths }),
  /** Saves pasted file contents (base64) into the deck's assets; returns its `assets/…` ref. */
  saveAsset: (id: string, name: string, data: string) => invoke<string>("save_asset", { id, name, data }),
  /**
   * Puts an element copied in the slide editor of deck `id` on the system clipboard, with
   * `text` for other apps. Naming the deck lets a paste into another deck bring its images.
   */
  copyToClipboard: (html: string, text: string, id: string | null = null) =>
    invoke<void>("copy_to_clipboard", { html, text, id }),
  /** Puts a whole slide on the system clipboard, to paste into this deck or another one. */
  copySlides: (id: string, slides: string[]) => invoke<void>("copy_slides", { id, slides }),
  /** Inserts the slides on the clipboard after `after`, in their order (with their images); null when there are none. */
  pasteSlides: (id: string, after: string | null) => invoke<RailEdit | null>("paste_slides", { id, after }),
  /** The clipboard's plain text (empty without any), for pasting into text without its formatting. */
  readClipboardText: () => invoke<string>("read_clipboard_text"),
  /** What pasting into deck `id` brings in; pasted images are saved into its assets. */
  pasteFromClipboard: (id: string) => invoke<Pasted>("paste_from_clipboard", { id }),
  /**
   * Writes the deck to `dest` as one web page that stands on its own, with the slides and the
   * author's own material (notes, narration scripts, review marks) `options` asks for.
   */
  exportDeck: (id: string, dest: string, options: WebPageOptions) => invoke<void>("export_deck", { id, dest, options }),
  /**
   * Prints the slides `options` names to `dest` as a PDF, a page each (and their notes, when asked).
   * `export-progress` events for `jobId` follow it; `cancelExport(jobId)` stops it, leaving no file.
   */
  exportPdf: (id: string, dest: string, jobId: string, options: PdfOptions) =>
    invoke<void>("export_pdf", { id, dest, jobId, options }),
  /** Writes the slides `scope` names to `dest` as a PowerPoint file, followed and cancelled as `exportPdf`. */
  exportPptx: (id: string, dest: string, jobId: string, scope: ExportScope) =>
    invoke<ExportedPptx>("export_pptx", { id, dest, jobId, scope }),
  /**
   * Saves an image of each slide `options` names: one slide to the file `dest`, several to a new
   * folder named after the deck inside the folder `dest`. Followed and cancelled as `exportPdf`.
   */
  exportSlideImages: (id: string, dest: string, jobId: string, options: ImageOptions) =>
    invoke<SavedImages>("export_slide_images", { id, dest, jobId, options }),
  /** Stops the export `jobId`, which then fails with EXPORT_CANCELLED before it writes anything. */
  cancelExport: (jobId: string) => invoke<void>("cancel_export", { jobId }),
  /**
   * Records the slides `output` names to `dest` as an MP4, each on screen for the same time (longer
   * to fit its narration, with `options.narration`), captions beside it when asked;
   * `video-export-progress` events follow it.
   */
  exportVideo: (id: string, dest: string, options: VideoOptions, output: VideoOutput) =>
    invoke<void>("export_video", { id, dest, options, output }),
  /** Stops the running video export, which then fails with VIDEO_CANCELLED. */
  cancelVideoExport: () => invoke<void>("cancel_video_export"),
  /** Whether the deck is in a git repository, which takes git being installed. */
  deckInRepository: (id: string) => invoke<boolean>("deck_in_repository", { id }),
  /** How the deck differs from the last commit. */
  deckChanges: (id: string) => invoke<DeckChanges>("deck_changes", { id }),
  stageChange: (id: string, change: Change) => invoke<void>("stage_change", { id, change }),
  unstageChange: (id: string, change: Change) => invoke<void>("unstage_change", { id, change }),
  /** Puts a change back as it was committed, in the deck and the index. */
  restoreChange: (id: string, change: Change) => invoke<Discarded>("restore_change", { id, change }),
  /** Puts the whole deck back as it was committed, as one change to undo. */
  restoreAllChanges: (id: string) => invoke<Discarded>("restore_all_changes", { id }),
  /** Stages the whole deck and the changed files it refers to. */
  stageAll: (id: string) => invoke<void>("stage_all", { id }),
  /** Unstages everything in the deck's folder. */
  unstageAll: (id: string) => invoke<void>("unstage_all", { id }),
  /** Commits what is staged. */
  commitChanges: (id: string, message: string) => invoke<void>("commit_changes", { id, message }),
  lintDeck: (id: string) => invoke<LintIssue[]>("lint_deck", { id }),
  /**
   * Screenshots `rect` of the window; returns an absolute session image path. Both are in CSS
   * pixels; the viewport size lets the backend work out the display's scale.
   */
  captureSketch: (
    id: string,
    rect: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number },
  ) => invoke<string>("capture_sketch", { id, rect, viewport }),
  /**
   * Screenshots `rect` of the window like {@link captureSketch}, with what lies outside `outline`
   * (a polygon in fractions of `rect`) made transparent.
   */
  captureArea: (
    id: string,
    rect: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number },
    outline: [number, number][],
  ) => invoke<string>("capture_area", { id, rect, viewport, outline }),
  sessionProvider: (id: string) => invoke<Provider | null>("session_provider", { id }),
  loadChat: (id: string) => invoke<unknown>("load_chat", { id }),
  saveChat: (id: string, chat: unknown) => invoke<void>("save_chat", { id, chat }),
  listChatThreads: (id: string) =>
    invoke<
      {
        id: string;
        title: string;
        createdAt: number | null;
        current: boolean;
        messageCount: number;
        association: string | null;
        /** The deck the conversation is about, when it is one that still exists. */
        deck: string | null;
      }[]
    >("list_chat_threads", { id }),
  selectChatThread: (id: string, thread: string) =>
    invoke<{ chat: unknown; provider: Provider | null; title?: string }>("select_chat_thread", { id, thread }),
  /** The name the user gave the conversation on show in chat `id`; null while it has none. */
  chatTitle: (id: string) => invoke<string | null>("chat_title", { id }),
  /** Names conversation `thread`; a blank `title` gives it back the name its first message gives it. */
  renameChatThread: (thread: string, title: string) => invoke<void>("rename_chat_thread", { thread, title }),
  /** Deletes conversation `thread` for good; refused for the one on show in chat `id`. */
  deleteChatThread: (id: string, thread: string) => invoke<void>("delete_chat_thread", { id, thread }),
  /** Takes back `path` (`assets/…`), attached in the composer of chat `id` and never sent; false when a deck uses it. */
  discardAttachment: (id: string, path: string) => invoke<boolean>("discard_attachment", { id, path }),
  resetChat: (id: string) => invoke<void>("reset_chat", { id }),
  /** Moves the folder's own chat to the deck open in this window, which it made. */
  moveChatToDeck: () => invoke<void>("move_chat_to_deck"),
  /** Starts a turn of chat `chat` (a deck's id, or the folder's path), the agent working in folder `workspace`. */
  sendMessage: (
    workspace: string,
    chat: string,
    prompt: string,
    selection: {
      provider: Provider;
      model: string;
      effort: string;
      contextWindow: string | null;
      permissionMode?: PermissionMode;
    },
    /** Summarize the conversation so far instead of sending `prompt`. */
    compact = false,
    /** The chat message the turn answers, and what the user wrote, for the decks' histories. */
    turn: { message: string; label: string } | null = null,
  ) => invoke<void>("send_message", { args: { workspace, chat, prompt, ...selection, compact, ...turn } }),
  /**
   * Takes chat `id`'s conversation back to before chat message `message` when its next turn
   * starts; that turn's prompt starts with `note` when the provider cannot do it.
   */
  rewindChat: (id: string, message: string, note: string) => invoke<void>("rewind_chat", { id, message, note }),
  /** The modes `provider` offers in workspace `id` (Codex: per its configuration). */
  permissionModes: (provider: Provider, id: string) => invoke<PermissionMode[]>("permission_modes", { provider, id }),
  setPermissionMode: (id: string, mode: PermissionMode) => invoke<void>("set_permission_mode", { id, mode }),
  respondApproval: (chat: string, id: string, decision: ApprovalDecision) =>
    invoke<void>("respond_approval", { chat, id, decision }),
  interruptAgent: (id: string) => invoke<void>("interrupt_agent", { id }),
  /**
   * Sends `prompt` into the running turn, for chat message `message`; false when it did not
   * get in (the turn was ending), and it should run as the next turn instead.
   */
  steerAgent: (chat: string, prompt: string, message: string) =>
    invoke<boolean>("steer_agent", { chat, prompt, message }),
  agentRunning: (id: string) => invoke<boolean>("agent_running", { id }),
  listProviders: () => invoke<ProviderInfo[]>("list_providers"),
  /** The user's templates first, then the built-in ones. */
  listTemplates: () => invoke<TemplateSummary[]>("list_templates"),
  /** Copies the template into the workspace's session for the agent; returns its absolute path. */
  stageTemplate: (id: string, template: string) => invoke<string>("stage_template", { id, template }),
  /** Gives a deck without slides the template's styles. */
  applyTemplate: (id: string, template: string) => invoke<Deck>("apply_template", { id, template }),
  /** Inserts a copy of the template's slide after `after` (or at the end). */
  addTemplateSlide: (id: string, template: string, slide: string, after: string | null) =>
    invoke<CreatedSlide>("add_template_slide", { id, template, slide, after }),
  /** Saves the deck as a user template with placeholder text in place of its content. */
  createTemplate: (id: string, name: string) => invoke<TemplateSummary>("create_template", { id, name }),
  voiceStatus: () => invoke<VoiceStatus>("voice_status"),
  /** Downloads the speech model to `~/.slopslides/models`, reporting `voice-download` events. */
  downloadVoiceModel: () => invoke<void>("download_voice_model"),
  /** Stops the speech model's download; `downloadVoiceModel` fails with VOICE_DOWNLOAD_CANCELLED. */
  cancelVoiceDownload: () => invoke<void>("cancel_voice_download"),
  /** Listens for the teleprompter, reporting recent words as `voice-heard` events; `cancelRecording` ends it. */
  followSpeech: () => invoke<void>("follow_speech"),
  /** Records the microphone, reporting its level as `voice-level` events. */
  startRecording: () => invoke<void>("start_recording"),
  /** Stops recording; resolves to what was said. */
  stopRecording: () => invoke<string>("stop_recording"),
  cancelRecording: () => invoke<void>("cancel_recording"),
  /**
   * Records the deck's narration from `slide` on: what is said is added to the slide on screen,
   * reporting `voice-level` and `narration-recorded` events (`narration-record-failed` when it
   * goes wrong). `narrationRecordingSlide` says when the slide changes.
   */
  startNarrationRecording: (id: string, slide: string, mode: NarrationRecordMode, replace = false) =>
    invoke<void>("start_narration_recording", { id, slide, mode, replace }),
  narrationRecordingSlide: (slide: string) => invoke<void>("narration_recording_slide", { slide }),
  /** Ends the narration recording; resolves once all of it is kept. */
  stopNarrationRecording: () => invoke<void>("stop_narration_recording"),
  /** Deletes a slide's recorded narration; resolves to every slide's audio. */
  deleteRecordedNarration: (id: string, slide: string) =>
    invoke<SlideAudio[]>("delete_recorded_narration", { id, slide }),
  speechStatus: () => invoke<SpeechStatus>("speech_status"),
  /** Each slide's narration audio, in slide order. */
  narrationAudio: (id: string) => invoke<SlideAudio[]>("narration_audio", { id }),
  /**
   * Says the narration of `slides` (all for null) that has no up-to-date audio, reporting
   * `narration-render` events; resolves to every slide's audio. Fails with NARRATION_CANCELLED
   * when cancelled.
   */
  renderNarration: (id: string, slides: string[] | null) => invoke<SlideAudio[]>("render_narration", { id, slides }),
  cancelNarration: () => invoke<void>("cancel_narration"),
  /**
   * Has the speech-to-text model hear the up-to-date audio of `slides` (all for null) again, to
   * know when each word is said, reporting `narration-timing` events; resolves to every slide's audio.
   */
  timeNarration: (id: string, slides: string[] | null) => invoke<SlideAudio[]>("time_narration", { id, slides }),
  /** When each word of a slide's narration audio is said; null until `timeNarration` heard it. */
  narrationWords: (id: string, slide: string) => invoke<NarrationWord[] | null>("narration_words", { id, slide }),
  /** A slide's narration audio, as WAV bytes. */
  narrationWav: (id: string, slide: string) => invoke<ArrayBuffer>("narration_wav", { id, slide }),
  /** How loud a slide's narration audio is along its length, 0 to 1, for drawing its waveform. */
  narrationPeaks: (id: string, slide: string) => invoke<number[]>("narration_peaks", { id, slide }),
  setNarrationVoice: (id: string, voice: string) => invoke<Deck>("set_narration_voice", { id, voice }),
  /** Sets who says the deck's narration; a voice the provider does not have becomes its default. */
  setNarrationProvider: (id: string, provider: string) => invoke<Deck>("set_narration_provider", { id, provider }),
  /** Saves a hosted provider's API key in `~/.slopslides`, or forgets it for null. */
  setSpeechKey: (provider: string, key: string | null) => invoke<SpeechStatus>("set_speech_key", { provider, key }),
  /** Every voice the provider's account can use (ElevenLabs: the account's own too). */
  speechVoices: (provider: string) => invoke<NarrationVoice[]>("speech_voices", { provider }),
  setNarrationLanguage: (id: string, language: string) => invoke<Deck>("set_narration_language", { id, language }),
  /** Stops `timeNarration` before its next slide; it fails with NARRATION_CANCELLED, what was heard is kept. */
  cancelNarrationTiming: () => invoke<void>("cancel_narration_timing"),
  /** What the deck keeps of how its narration is said and timed. */
  narrationSettings: (id: string) => invoke<DeckNarrationSettings>("narration_settings", { id }),
  /** Sets the times the deck plays with; resolves to all it keeps. */
  setNarrationTiming: (id: string, timing: NarrationTiming) =>
    invoke<DeckNarrationSettings>("set_narration_timing", { id, timing }),
  /** Sets how fast and in what manner the deck's narration is said; audio said another way is out of date then. */
  setNarrationDelivery: (id: string, pace: NarrationPace, style: string) =>
    invoke<DeckNarrationSettings>("set_narration_delivery", { id, pace, style }),
  /** A short sample of a voice, as WAV bytes: said once with the user's key, then kept for every deck. */
  previewNarrationVoice: (provider: string, voice: string, language: string) =>
    invoke<ArrayBuffer>("preview_narration_voice", { provider, voice, language }),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
