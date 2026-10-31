import { invoke } from "@tauri-apps/api/core";
import type { Stroke } from "./ink";
import type { Provider, ProviderInfo } from "./models";
import type { Approval, ApprovalDecision, PermissionMode } from "./permissions";
import type { SizeInfo, SlideSize } from "./slideSize";
import type { VideoOptions } from "./video";

/** What a workspace file is, which decides what it opens in (see src-tauri/src/workspace.rs). */
export type FileKind = "directory" | "deck" | "slideshow" | "webpage" | "file";

/** A file or folder in the open workspace. */
export interface WorkspaceEntry {
  name: string;
  /** Workspace-relative, `/`-separated. */
  path: string;
  kind: FileKind;
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
  /** Id of the template the deck's design comes from (its `slopslide-template` meta). */
  template?: string | null;
  /** Every slide's canvas (its `slopslide-size` meta); 1920×1080 px when missing. */
  size?: SizeInfo;
  /** The voice and language its narration is said in (its `slopslide-narration-*` metas). */
  narration?: NarrationSettings;
}

export interface NarrationSettings {
  /** One of SpeechStatus.voices' ids. */
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
  /** A slide copied from the slide rail: it goes in as a new slide (see `pasteSlide`). */
  | { kind: "slide" }
  | { kind: "nothing" };

export interface CreatedSlide {
  deck: Deck;
  slide: string;
}

export interface UpdatedSlide {
  deck: Deck;
  /** The slide's markup before the update; saving it back undoes the update. */
  previous: string;
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
  /** The deck's source before and after; saving `previous` over `source` undoes the replace. */
  previous: string;
  source: string;
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
  | { type: "toolResult"; id: string; isError: boolean }
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
  | { type: "finished"; interrupted: boolean };

export interface AgentEventEnvelope {
  workspace: string;
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

/** A built-in voice of the narration model (see src-tauri/src/narration/mod.rs). */
export interface NarrationVoice {
  id: string;
  name: string;
  description: string;
  /** The language it speaks natively; others it speaks with an accent. */
  native: string;
}

export interface NarrationLanguage {
  /** ISO 639-1 code. */
  id: string;
  name: string;
}

/** What narration can do on this machine (see src-tauri/src/narration/mod.rs). */
export interface SpeechStatus {
  /** This build has the speech engine (not every platform does). */
  available: boolean;
  /** The voice model is downloaded. */
  modelReady: boolean;
  /** The model's download size. */
  modelBytes: number;
  downloading: boolean;
  /** The deck whose narration is being said, if any. */
  rendering: string | null;
  voices: NarrationVoice[];
  languages: NarrationLanguage[];
}

/** Whether a slide's audio matches its narration: none without narration, stale when made from another script, voice or language. */
export type AudioState = "none" | "missing" | "stale" | "ready";

export interface SlideAudio {
  slide: string;
  state: AudioState;
  /** How long the audio there plays (stale audio too); null without any. */
  seconds: number | null;
}

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

export const api = {
  /** Opens another app window, on the start screen; each window has a folder of its own. */
  newWindow: () => invoke<void>("new_window"),
  /** The folder opened from Finder that is waiting to open in this window, once; null without one. */
  takePendingFolder: () => invoke<string | null>("take_pending_folder"),
  /** Opens a folder: the file tree shows it and the app serves and watches its files. */
  openWorkspace: (path: string) => invoke<WorkspaceInfo>("open_workspace", { path }),
  closeWorkspace: () => invoke<void>("close_workspace"),
  /** Folders opened before, newest first. */
  recentWorkspaces: () => invoke<RecentWorkspace[]>("recent_workspaces"),
  forgetWorkspace: (path: string) => invoke<void>("forget_workspace", { path }),
  /** `~/Documents/SlopSlide`, where decks lived before workspaces. */
  libraryFolder: () => invoke<string>("library_folder"),
  /** One folder of the open workspace (`""` for its root), folders first. */
  listDir: (path: string) => invoke<WorkspaceEntry[]>("list_dir", { path }),
  /** A file of the open workspace, with the viewer it opens in. */
  openFile: (path: string) => invoke<OpenedFile>("open_file", { path }),
  /** Creates `<workspace>/<title>/deck.html`; with a template, it takes its styles (and names it). */
  createDeck: (title: string, template: string | null = null) => invoke<Deck>("create_deck", { title, template }),
  openDeck: (id: string) => invoke<Deck>("open_deck", { id }),
  loadDeck: (id: string) => invoke<Deck>("load_deck", { id }),
  /** Stores the review marks (by slide id) in the deck file. */
  saveReview: (id: string, review: Record<string, Stroke[]>) => invoke<void>("save_review", { id, review }),
  renameDeck: (id: string, title: string) => invoke<Deck>("rename_deck", { id, title }),
  /** `slides` lists every slide id and section key (see `sectionKey`) in the new order. */
  reorderSlides: (id: string, slides: string[]) => invoke<Deck>("reorder_slides", { id, slides }),
  addSlide: (id: string, after: string | null) => invoke<CreatedSlide>("add_slide", { id, after }),
  duplicateSlide: (id: string, slide: string) => invoke<CreatedSlide>("duplicate_slide", { id, slide }),
  setSlideHidden: (id: string, slide: string, hidden: boolean) =>
    invoke<Deck>("set_slide_hidden", { id, slide, hidden }),
  setSlideLocked: (id: string, slide: string, locked: boolean) =>
    invoke<Deck>("set_slide_locked", { id, slide, locked }),
  /** Sets what is said over the slide; empty `text` removes its narration. */
  setSlideNarration: (id: string, slide: string, text: string) =>
    invoke<Deck>("set_slide_narration", { id, slide, text }),
  /** Gives every slide the canvas `size` (the slides' content stays as it is). */
  setSlideSize: (id: string, size: SlideSize) => invoke<Deck>("set_slide_size", { id, size }),
  addSection: (id: string, before: string | null, title: string) => invoke<Deck>("add_section", { id, before, title }),
  renameSection: (id: string, index: number, title: string) => invoke<Deck>("rename_section", { id, index, title }),
  deleteSection: (id: string, index: number) => invoke<Deck>("delete_section", { id, index }),
  deleteSlide: (id: string, slide: string) => invoke<Deck>("delete_slide", { id, slide }),
  /** Replaces one slide's markup; refused when the slide's hash is no longer `base`. */
  updateSlide: (id: string, slide: string, markup: string, base: string) =>
    invoke<UpdatedSlide>("update_slide", { id, slide, markup, base }),
  saveDeckSource: (id: string, source: string, base: string | null) =>
    invoke<Deck>("save_deck_source", { id, source, base }),
  /** Where `query` is found in the text on the deck's slides (and their notes). */
  findInDeck: (id: string, query: string, options: FindOptions) =>
    invoke<FindMatch[]>("find_in_deck", { id, query, options }),
  /** Replaces `query` in the text of the deck's slides, or only of `slides`; locked slides are left alone. */
  replaceInDeck: (id: string, query: string, replacement: string, options: FindOptions, slides: string[] | null) =>
    invoke<ReplacedText>("replace_in_deck", { id, query, replacement, options, slides }),
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
  copySlide: (id: string, slide: string) => invoke<void>("copy_slide", { id, slide }),
  /** Inserts the slide on the clipboard after `after` (with its images); null when there is none. */
  pasteSlide: (id: string, after: string | null) => invoke<CreatedSlide | null>("paste_slide", { id, after }),
  /** The clipboard's plain text (empty without any), for pasting into text without its formatting. */
  readClipboardText: () => invoke<string>("read_clipboard_text"),
  /** What pasting into deck `id` brings in; pasted images are saved into its assets. */
  pasteFromClipboard: (id: string) => invoke<Pasted>("paste_from_clipboard", { id }),
  exportDeck: (id: string, dest: string) => invoke<void>("export_deck", { id, dest }),
  /** Prints the deck to `dest` as a PDF: one page per shown slide, with selectable text. */
  exportPdf: (id: string, dest: string) => invoke<void>("export_pdf", { id, dest }),
  /**
   * Records the deck to `dest` as an MP4, each shown slide on screen for the same time (longer
   * to fit its narration, with `options.narration`); `video-export-progress` events follow it.
   */
  exportVideo: (id: string, dest: string, options: VideoOptions) => invoke<void>("export_video", { id, dest, options }),
  /** Stops the running video export, which then fails with VIDEO_CANCELLED. */
  cancelVideoExport: () => invoke<void>("cancel_video_export"),
  /** Creates a new folder named after the deck inside `parent`; returns its path. */
  createImageExportDir: (id: string, parent: string) => invoke<string>("create_image_export_dir", { id, parent }),
  /**
   * Screenshots `rect` (one slide, CSS pixels) as `<dir>/slide-NN.png`, at most `width` (the
   * slides' canvas width) pixels wide; returns its path.
   */
  exportSlideImage: (
    dir: string,
    index: number,
    total: number,
    rect: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number },
    width: number,
  ) => invoke<string>("export_slide_image", { dir, index, total, rect, viewport, width }),
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
  sessionProvider: (id: string) => invoke<Provider | null>("session_provider", { id }),
  loadChat: (id: string) => invoke<unknown>("load_chat", { id }),
  saveChat: (id: string, chat: unknown) => invoke<void>("save_chat", { id, chat }),
  resetChat: (id: string) => invoke<void>("reset_chat", { id }),
  sendMessage: (
    workspace: string,
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
  ) => invoke<void>("send_message", { args: { workspace, prompt, ...selection, compact } }),
  /** The modes `provider` offers in workspace `id` (Codex: per its configuration). */
  permissionModes: (provider: Provider, id: string) => invoke<PermissionMode[]>("permission_modes", { provider, id }),
  respondApproval: (workspace: string, id: string, decision: ApprovalDecision) =>
    invoke<void>("respond_approval", { workspace, id, decision }),
  interruptAgent: (id: string) => invoke<void>("interrupt_agent", { id }),
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
  /** Records the microphone, reporting its level as `voice-level` events. */
  startRecording: () => invoke<void>("start_recording"),
  /** Stops recording; resolves to what was said. */
  stopRecording: () => invoke<string>("stop_recording"),
  cancelRecording: () => invoke<void>("cancel_recording"),
  speechStatus: () => invoke<SpeechStatus>("speech_status"),
  /** Downloads the narration voice model to `~/.slopslides/models`, reporting `speech-download` events. */
  downloadSpeechModel: () => invoke<void>("download_speech_model"),
  /** Each slide's narration audio, in slide order. */
  narrationAudio: (id: string) => invoke<SlideAudio[]>("narration_audio", { id }),
  /**
   * Says the narration of `slides` (all for null) that has no up-to-date audio, reporting
   * `narration-render` events; resolves to every slide's audio. Fails with NARRATION_CANCELLED
   * when cancelled.
   */
  renderNarration: (id: string, slides: string[] | null) => invoke<SlideAudio[]>("render_narration", { id, slides }),
  cancelNarration: () => invoke<void>("cancel_narration"),
  /** A slide's narration audio, as WAV bytes. */
  narrationWav: (id: string, slide: string) => invoke<ArrayBuffer>("narration_wav", { id, slide }),
  setNarrationVoice: (id: string, voice: string) => invoke<Deck>("set_narration_voice", { id, voice }),
  setNarrationLanguage: (id: string, language: string) => invoke<Deck>("set_narration_language", { id, language }),
};

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
