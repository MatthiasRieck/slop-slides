// Running an export the export dialog asked for: where it goes (the save dialog, or a folder for
// several images), the export itself with its progress in the exports store, and what is said
// when it ends: saved (with a way to the file, and for PowerPoint what it did not keep),
// cancelled (nothing was saved), or what went wrong.
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

import { api, type ConversionChange, type Deck, type ExportProgress, errorMessage } from "../../lib/api";
import {
  EXPORT_CANCELLED,
  type ExportFormat,
  type ExportScope,
  FORMAT_NAMES,
  type ImageOptions,
  type PdfOptions,
  type WebPageOptions,
} from "../../lib/exportOptions";
import { basename, plural, revealLabel } from "../../lib/utils";
import { VIDEO_CANCELLED, type VideoOptions, type VideoOutput, type VideoProgress } from "../../lib/video";
import { showError, showInfo, useApp } from "../../store";
import { addRun, type ExportRun, endRun, markCancelling, runProgress, videoProgress } from "../../store/exports";
import { revealSaved, showSaved } from "../exportSaved";

/** What the export dialog asks for, by format. */
export type ExportRequest =
  | { format: "pdf"; options: PdfOptions }
  | { format: "pptx"; scope: ExportScope }
  | { format: "html"; options: WebPageOptions }
  | { format: "images"; options: ImageOptions }
  | { format: "video"; options: VideoOptions; output: VideoOutput };

/** The files each export saves: what the save dialog offers, and what a failure says first. */
const FILES: Record<ExportFormat, { title: string; extension: string; filter: string; failure: string }> = {
  pdf: { title: "Export as PDF", extension: "pdf", filter: "PDF document", failure: "Could not save the PDF: " },
  pptx: {
    title: "Export as PowerPoint",
    extension: "pptx",
    filter: "PowerPoint presentation",
    failure: "Could not save the PowerPoint file: ",
  },
  html: {
    title: "Export as web page",
    extension: "html",
    filter: "HTML web page",
    failure: "Could not save the web page: ",
  },
  images: {
    title: "Export slide image",
    extension: "png",
    filter: "PNG image",
    failure: "Could not save the images: ",
  },
  video: { title: "Export as video", extension: "mp4", filter: "MP4 video", failure: "Could not save the video: " },
};

/** A name for a file made from `title`: what file systems take, or "presentation". */
export function exportFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, "").trim() || "presentation";
}

/** Whether `request` saves one image, to a file of its own, rather than a folder of them. */
const oneImage = (request: ExportRequest) => request.format === "images" && request.options.slides?.length === 1;

/** Asks where `request` goes, offering a name made from `deck`'s title; null when the user cancels. */
async function askWhere(deck: Deck, request: ExportRequest): Promise<string | null> {
  const name = exportFileName(deck.title);
  if (request.format === "images" && !oneImage(request)) {
    const folder = await open({ directory: true, title: "Choose where to save the slide images" });
    return typeof folder === "string" ? folder : null;
  }
  let { title, extension, filter } = FILES[request.format];
  let fileName = name;
  if (request.format === "images") {
    const id = request.options.slides?.[0];
    const number = deck.slides.findIndex((s) => s.id === id) + 1;
    fileName = `${name} - slide ${number}`;
    if (request.options.format === "jpeg") [extension, filter] = ["jpg", "JPEG image"];
  }
  if (request.format === "video" && request.output.captions) title = "Export as video, with captions beside it";
  return save({ title, defaultPath: `${fileName}.${extension}`, filters: [{ name: filter, extensions: [extension] }] });
}

/** "Slide 4", "Slides 4, 9", or "Whole presentation" for what is about every slide. */
export function slidesText(slides: number[]): string {
  if (slides.length === 0) return "Whole presentation";
  return `${slides.length === 1 ? "Slide" : "Slides"} ${slides.join(", ")}`;
}

/** A conversion's changes as lines to read: where, then what. */
export function changesText(changes: ConversionChange[]): string {
  return changes.map((change) => `${slidesText(change.slides)}: ${change.what}.`).join("\n");
}

/** Says a PowerPoint file is saved, and what it did not keep, behind the toast's Details. */
function showPptxSaved(dest: string, changes: ConversionChange[]) {
  if (changes.length === 0) {
    showSaved(dest);
    return;
  }
  const text = `Saved ${basename(dest)}. ${plural(changes.length, "thing")} changed; see Details`;
  useApp.getState().showToast(
    "success",
    text,
    { label: revealLabel, run: () => void revealSaved(dest) },
    {
      details: changesText(changes),
    },
  );
}

/** The captions file saved beside the video `dest`. */
const captionsFile = (dest: string, format: "srt" | "vtt") => `${dest.replace(/\.[^./\\]*$/, "")}.${format}`;

/** Runs `request`'s export to `dest` as the export `id`, and says what it saved. */
async function exportTo(deck: Deck, request: ExportRequest, dest: string, id: string): Promise<void> {
  switch (request.format) {
    case "html":
      await api.exportDeck(deck.id, dest, request.options);
      showSaved(dest);
      return;
    case "pdf":
      await api.exportPdf(deck.id, dest, id, request.options);
      showSaved(dest);
      return;
    case "pptx": {
      const { changes } = await api.exportPptx(deck.id, dest, id, request.scope);
      showPptxSaved(dest, changes);
      return;
    }
    case "images": {
      const saved = await api.exportSlideImages(deck.id, dest, id, request.options);
      const text =
        saved.count === 1
          ? `Saved ${basename(saved.path)}`
          : `Saved ${saved.count} slide images in ${basename(saved.path)}`;
      showSaved(saved.path, text);
      return;
    }
    case "video": {
      await api.exportVideo(deck.id, dest, request.options, request.output);
      const { captions } = request.output;
      showSaved(dest, captions ? `Saved ${basename(dest)} and ${basename(captionsFile(dest, captions))}` : undefined);
      return;
    }
  }
}

/**
 * Exports `deck` as `request` asks, once the user has said where; its progress shows on the
 * Export button meanwhile. A cancelled export says that nothing was saved; a failed one, why.
 */
export async function startExport(deck: Deck, request: ExportRequest): Promise<void> {
  const dest = await askWhere(deck, request);
  if (!dest) return;
  const id = crypto.randomUUID();
  addRun({ id, format: request.format, dest });
  const stopListening =
    request.format === "video"
      ? await listen<VideoProgress>("video-export-progress", ({ payload }) => videoProgress(id, payload))
      : await listen<ExportProgress>("export-progress", ({ payload }) => {
          if (payload.job === id) runProgress(id, payload.done, payload.total);
        });
  try {
    await exportTo(deck, request, dest, id);
  } catch (error) {
    const message = errorMessage(error);
    if (message === EXPORT_CANCELLED || message === VIDEO_CANCELLED) {
      showInfo(`Stopped the ${FORMAT_NAMES[request.format].toLowerCase()} export. Nothing was saved.`);
    } else {
      showError(message, FILES[request.format].failure);
    }
  } finally {
    stopListening();
    endRun(id);
  }
}

/** Whether `run` can be stopped: a web page is written at once. */
export const canCancel = (run: ExportRun) => run.format !== "html" && !run.cancelling;

/** Stops `run` at its next step; it then ends as cancelled, leaving no file. */
export async function cancelExport(run: ExportRun): Promise<void> {
  if (!canCancel(run)) return;
  markCancelling(run.id);
  try {
    if (run.format === "video") await api.cancelVideoExport();
    else await api.cancelExport(run.id);
  } catch (error) {
    showError(error, "Could not stop the export: ");
  }
}
