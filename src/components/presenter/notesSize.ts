import { loadJson, saveJson } from "../../lib/storage";

/** The sizes the presenter's notes can be read at, smallest first. */
export const NOTE_SIZES = ["text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-3xl", "text-4xl"] as const;

/** Where the notes are read: in the panel beside the slide, or in the presenter view's own window. */
export type NotesPlace = "panel" | "window";

/** The size each place starts with, as an index of `NOTE_SIZES`: the window has the room for larger text. */
const DEFAULT_SIZE: Record<NotesPlace, number> = { panel: 1, window: 4 };

const NOTES_SIZE_KEY = "slopslide.presenterNotesSize";

const valid = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < NOTE_SIZES.length;

/** The size picked last for `place`, kept on this computer; its default without. */
export function loadNotesSize(place: NotesPlace): number {
  return loadJson(NOTES_SIZE_KEY, DEFAULT_SIZE[place], (stored) => {
    const saved = (stored as Partial<Record<NotesPlace, unknown>>)[place];
    return valid(saved) ? saved : DEFAULT_SIZE[place];
  });
}

/** Remembers `size` for `place`, leaving the other place's as it is. */
export function saveNotesSize(place: NotesPlace, size: number) {
  const other: NotesPlace = place === "panel" ? "window" : "panel";
  saveJson(NOTES_SIZE_KEY, { [other]: loadNotesSize(other), [place]: size });
}

/** `size` one step larger (`by` 1) or smaller (-1), within the sizes there are. */
export function stepNotesSize(size: number, by: 1 | -1): number {
  return Math.min(NOTE_SIZES.length - 1, Math.max(0, size + by));
}
