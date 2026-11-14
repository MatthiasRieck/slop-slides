// Getting a deck out of the app and a PowerPoint file in: the exports running (several at once,
// a video among them), the export dialog that is open, the PowerPoint import under way and the
// report of the last one. Its own store, as the narration's is: what it holds outlives the deck
// that started it (an export goes on when the deck closes, and says so when it is done).
import { create } from "zustand";

import type { ConversionChange, FontUse } from "../lib/api";
import type { ExportFormat } from "../lib/exportOptions";
import type { VideoProgress } from "../lib/video";

/** An export under way. */
export interface ExportRun {
  /** What the backend knows it by (`export-progress` events, `cancel_export`). */
  id: string;
  format: ExportFormat;
  /** The file (or the folder of images) it writes. */
  dest: string;
  /** How many of `total` slides are done; 0 of 0 before the first word from the backend. */
  done: number;
  total: number;
  /** A video's own progress: narration spoken first, then frames. */
  video?: VideoProgress;
  /** When the video's current phase began (ms), for how long it still takes. */
  phaseStarted?: number;
  /** Cancel was pressed: it stops at its next step. */
  cancelling: boolean;
}

/** A PowerPoint import under way: the file, and the slide it is reading (from 1) of how many. */
export interface ImportRun {
  file: string;
  slide: number;
  slides: number;
}

/** What an import changed, for the deck it made: it stays on hand while that deck is open. */
export interface ImportReport {
  /** The deck made, by its id. */
  deckId: string;
  title: string;
  /** The PowerPoint file's name. */
  file: string;
  slides: number;
  changes: ConversionChange[];
  /** The fonts the file is set in that this computer does not have. */
  missingFonts: FontUse[];
}

interface ExportsState {
  runs: ExportRun[];
  /** The format whose export dialog is open. */
  dialog: ExportFormat | null;
  importing: ImportRun | null;
  report: ImportReport | null;
  reportOpen: boolean;
}

export const useExports = create<ExportsState>(() => ({
  runs: [],
  dialog: null,
  importing: null,
  report: null,
  reportOpen: false,
}));

const update = (id: string, change: (run: ExportRun) => ExportRun) =>
  useExports.setState((s) => ({ runs: s.runs.map((run) => (run.id === id ? change(run) : run)) }));

/** Adds an export that has just started. */
export function addRun(run: Pick<ExportRun, "id" | "format" | "dest">): void {
  useExports.setState((s) => ({ runs: [...s.runs, { ...run, done: 0, total: 0, cancelling: false }] }));
}

/** Notes that `done` of `total` slides of the export `id` are done. */
export function runProgress(id: string, done: number, total: number): void {
  update(id, (run) => ({ ...run, done, total }));
}

/** Notes how far the video export `id` has got; a new phase starts its clock again. */
export function videoProgress(id: string, progress: VideoProgress, now = Date.now()): void {
  update(id, (run) => ({
    ...run,
    video: progress,
    phaseStarted: run.video?.phase === progress.phase && run.phaseStarted !== undefined ? run.phaseStarted : now,
  }));
}

export function markCancelling(id: string): void {
  update(id, (run) => ({ ...run, cancelling: true }));
}

/** Takes away an export that has ended, however it ended. */
export function endRun(id: string): void {
  useExports.setState((s) => ({ runs: s.runs.filter((run) => run.id !== id) }));
}

/** Whether a video is being exported: the encoder makes one at a time. */
export const videoRunning = (s: Pick<ExportsState, "runs">) => s.runs.some((run) => run.format === "video");

/** Opens the export dialog for `format`, as the Export menu's items do. */
export function openExportDialog(format: ExportFormat): void {
  useExports.setState({ dialog: format });
}

export function closeExportDialog(): void {
  useExports.setState({ dialog: null });
}
