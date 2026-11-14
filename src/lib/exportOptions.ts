// What an export from the Export menu is of and how it is made: the formats, the slides it holds
// (all, the current one, or a range, with or without hidden slides), each format's own options,
// and the choices remembered per format. The backend reads the same fields (src-tauri/src/
// export_scope.rs, pdf.rs, slide_images.rs).
import type { Slide } from "./api";
import { loadJson, saveJson } from "./storage";
import { plural } from "./utils";

/** What a deck is exported as, in the Export menu's order. */
export type ExportFormat = "pdf" | "pptx" | "html" | "images" | "video";

/** Each format's name, as the menu, the dialog and the progress say it. */
export const FORMAT_NAMES: Record<ExportFormat, string> = {
  pdf: "PDF",
  pptx: "PowerPoint",
  html: "Web page",
  images: "Images",
  video: "Video",
};

/** Each format's export dialog, by its heading. */
export const EXPORT_TITLES: Record<ExportFormat, string> = {
  pdf: "Export PDF",
  pptx: "Export PowerPoint",
  html: "Export web page",
  images: "Export images",
  video: "Export video",
};

/** The backend's error for an export the user cancelled (src-tauri/src/export_job.rs). */
export const EXPORT_CANCELLED = "the export was cancelled";

/** The slides an export is of: every one when `slides` is left out, hidden ones only with `includeHidden`. */
export interface ExportScope {
  slides?: string[];
  includeHidden: boolean;
}

export interface PdfOptions extends ExportScope {
  /** A page with each slide's speaker notes after it. */
  notes: boolean;
}

/** What a web page keeps of what the author keeps to themselves; nothing unless asked. */
export interface WebPageOptions extends ExportScope {
  notes: boolean;
  narration: boolean;
  review: boolean;
}

export type ImageFormat = "png" | "jpeg";

export interface ImageOptions extends ExportScope {
  format: ImageFormat;
  /** Pixels per slide pixel. */
  scale: 1 | 2;
}

/** Which slides: every one, the one selected, or the slides numbered `from` to `to`. */
export type SlideRange = "all" | "current" | "range";

/** What the export dialog remembers for a format, the next export starting from it. */
export interface ExportChoices {
  range: SlideRange;
  includeHidden: boolean;
  /** PDF: a page of notes after each slide. Web page: keep the speaker notes. */
  notes: boolean;
  /** Web page: keep the narration scripts. */
  narration: boolean;
  /** Web page: keep the review marks and comments. */
  review: boolean;
  imageFormat: ImageFormat;
  imageScale: 1 | 2;
  /** Video: how tall, in pixels; null for the slides' own size. */
  videoHeight: number | null;
  /** Video: captions written beside it. */
  captions: "srt" | "vtt" | null;
}

/** Hidden slides stay out of every format unless asked for; private material stays out of a web page. */
export const DEFAULT_CHOICES: ExportChoices = {
  range: "all",
  includeHidden: false,
  notes: false,
  narration: false,
  review: false,
  imageFormat: "png",
  imageScale: 1,
  videoHeight: null,
  captions: null,
};

/** The video heights offered besides the slides' own (src-tauri/src/video/mod.rs, HEIGHTS). */
export const VIDEO_HEIGHTS = [720, 1080, 2160] as const;

const storageKey = (format: ExportFormat) => `slopslide.export.${format}`;

const oneOf = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** Stored choices, each one that is missing or unknown replaced by its default. */
export function readChoices(saved: unknown): ExportChoices {
  if (!saved || typeof saved !== "object") return DEFAULT_CHOICES;
  const s = saved as Record<string, unknown>;
  const d = DEFAULT_CHOICES;
  return {
    range: oneOf<SlideRange>(s.range, ["all", "current", "range"], d.range),
    includeHidden: flag(s.includeHidden, d.includeHidden),
    notes: flag(s.notes, d.notes),
    narration: flag(s.narration, d.narration),
    review: flag(s.review, d.review),
    imageFormat: oneOf<ImageFormat>(s.imageFormat, ["png", "jpeg"], d.imageFormat),
    imageScale: oneOf<1 | 2>(s.imageScale, [1, 2], d.imageScale),
    videoHeight: oneOf<number | null>(s.videoHeight, [null, ...VIDEO_HEIGHTS], d.videoHeight),
    captions: oneOf<"srt" | "vtt" | null>(s.captions, [null, "srt", "vtt"], d.captions),
  };
}

/** The choices last made for `format`, or the defaults. */
export function loadChoices(format: ExportFormat): ExportChoices {
  return loadJson(storageKey(format), DEFAULT_CHOICES, readChoices);
}

/** Remembers `choices` for the next export as `format`. */
export function saveChoices(format: ExportFormat, choices: ExportChoices): void {
  try {
    saveJson(storageKey(format), choices);
  } catch {
    // Storage full or blocked: the next export starts from the defaults, nothing worse.
  }
}

/** Which slides an export is of, as the dialog chose them. */
export interface SlideChoice {
  range: SlideRange;
  /** The first and last slide of a range, by their number in the deck, as typed. */
  from: string;
  to: string;
  includeHidden: boolean;
}

/** The slides a choice comes to, the scope that asks for them, and what is wrong with it, if anything. */
export interface ChosenSlides {
  slides: Slide[];
  scope: ExportScope;
  problem: string | null;
}

/** A slide number typed in a range, or null when it is none of the deck's `count`. */
function slideNumber(text: string, count: number): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(value) && value >= 1 && value <= count ? value : null;
}

/**
 * The slides of `deck` that `choice` comes to, `current` being the slide selected. Numbers count
 * every slide, hidden ones too, as the slide rail shows them.
 */
export function chooseSlides(deck: Slide[], choice: SlideChoice, current: string | null): ChosenSlides {
  const scope = (slides?: string[]): ExportScope => ({
    ...(slides && { slides }),
    includeHidden: choice.includeHidden,
  });
  const kept = (slides: Slide[]) => slides.filter((s) => choice.includeHidden || !s.hidden);
  const done = (slides: Slide[], ids: string[] | undefined, hiddenProblem: string): ChosenSlides => {
    const chosen = kept(slides);
    const problem = chosen.length === 0 ? (slides.length > 0 ? hiddenProblem : "The deck has no slides.") : null;
    return { slides: chosen, scope: scope(ids), problem };
  };
  if (choice.range === "current") {
    const slide = deck.find((s) => s.id === current);
    if (!slide) return { slides: [], scope: scope([]), problem: "Select a slide first." };
    return done([slide], [slide.id], "The current slide is hidden. Tick “Include hidden slides” to export it.");
  }
  if (choice.range === "range") {
    const from = slideNumber(choice.from, deck.length);
    const to = slideNumber(choice.to, deck.length);
    if (from === null || to === null) {
      return { slides: [], scope: scope([]), problem: `Enter slide numbers from 1 to ${deck.length}.` };
    }
    if (from > to) return { slides: [], scope: scope([]), problem: "The first slide must come before the last." };
    const slides = deck.slice(from - 1, to);
    return done(
      slides,
      slides.map((s) => s.id),
      "Every slide in this range is hidden. Tick “Include hidden slides” to export them.",
    );
  }
  return done(deck, undefined, "Every slide is hidden. Tick “Include hidden slides” to export them.");
}

/** Whether a web page of `slides` has one to show: it skips hidden slides as the show does. */
export function webPageProblem(slides: Slide[]): string | null {
  return slides.length > 0 && slides.every((s) => s.hidden)
    ? "A web page skips hidden slides, so it needs one that is not hidden."
    : null;
}

/** Text that is there once trimmed. */
const said = (text: string | undefined) => (text ?? "").trim() !== "";

/** What of the author's own material `slides` have, for the web page dialog to offer. */
export function privateParts(slides: Slide[]) {
  return {
    notes: slides.filter((s) => said(s.notes)).length,
    narration: slides.filter((s) => said(s.narration)).length,
  };
}

/** The scope and options the backend takes for a web page. */
export function webPageOptions(scope: ExportScope, choices: ExportChoices): WebPageOptions {
  return { ...scope, notes: choices.notes, narration: choices.narration, review: choices.review };
}

export function pdfOptions(scope: ExportScope, choices: ExportChoices): PdfOptions {
  return { ...scope, notes: choices.notes };
}

export function imageOptions(scope: ExportScope, choices: ExportChoices): ImageOptions {
  return { ...scope, format: choices.imageFormat, scale: choices.imageScale };
}

/** The slides' width and height in pixels, `scale` times over: "1920 × 1080 px". */
export function pixelSize(width: number, height: number, scale = 1): string {
  return `${Math.round(width * scale)} × ${Math.round(height * scale)} px`;
}

/** How far an export has got, for the menu: "Slide 4 of 20", or what it starts with. */
export function slideProgress(done: number, total: number): string {
  if (!(total > 0)) return "Starting…";
  if (done >= total) return "Finishing…";
  return `Slide ${done + 1} of ${total}`;
}

/** The same in the room of a button: "4/20". */
export function slideProgressShort(done: number, total: number): string {
  if (!(total > 0)) return "…";
  return `${Math.min(done + 1, total)}/${total}`;
}

/** How far along, in whole percent. */
export function slidePercent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

/** "3 slides", for a summary. */
export function slideCount(slides: Slide[]): string {
  return plural(slides.length, "slide");
}
