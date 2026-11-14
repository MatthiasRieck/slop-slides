// The app's commands as the menus, the command palette and the shortcut help list them: their
// names, where they sit and their keys. The table is ./commands.json, which the native menu bar
// is built from too (src-tauri/src/menu.rs), so the two never disagree. What each command does,
// and when it can, is in ../commands/.
import table from "./commands.json";
import { formatKeys } from "./keys";
import { loadJson, saveJson } from "./storage";
import { isMac, isWindows } from "./utils";

/** The menus of the menu bar, in order; App is macOS's application menu. */
export type MenuName =
  | "App"
  | "File"
  | "Edit"
  | "View"
  | "Insert"
  | "Format"
  | "Arrange"
  | "Slide"
  | "Present"
  | "Window"
  | "Help";

/** A command's place in the menus and its keys, as ./commands.json gives them. */
export interface CommandSpec {
  id: string;
  /** Its name on this system, in sentence case; an ellipsis when it asks for more first. */
  title: string;
  /** The menu it sits in. */
  menu: MenuName;
  /** Its keys, as a `formatKeys` spec. */
  keys?: string;
  /** It is on or off, and the menu shows a check mark while it is on. */
  check?: boolean;
  /** The section of the shortcut help its keys are listed in. */
  help?: string;
  /** What the shortcut help says it does, when that says more than its title. */
  describe?: string;
  /** A word more about it in the palette: what it does that its name does not say. */
  hint?: string;
}

/** A command as ./commands.json has it, with its name on each system. */
interface TableItem {
  id: string;
  title: string;
  titles?: { macos?: string; windows?: string; linux?: string };
  keys?: string;
  check?: boolean;
  help?: string;
  describe?: string;
  hint?: string;
}

type TableEntry = TableItem | { native: string } | "-";

const isCommand = (entry: TableEntry): entry is TableItem => typeof entry === "object" && "id" in entry;

/** The system the app runs on, as the table names it. */
export type System = "macos" | "windows" | "linux";

export const SYSTEM: System = isMac ? "macos" : isWindows ? "windows" : "linux";

/** Every command of the table, in menu order, named for `system`. */
export function commandSpecs(system: System = SYSTEM): CommandSpec[] {
  return (table.menus as { title: string; items: TableEntry[] }[]).flatMap((menu) =>
    menu.items.filter(isCommand).map(({ titles, ...item }) => ({
      ...item,
      title: titles?.[system] ?? item.title,
      menu: menu.title as MenuName,
    })),
  );
}

/** The commands of this system's menus. */
export const COMMAND_SPECS: readonly CommandSpec[] = commandSpecs();

const BY_ID = new Map(COMMAND_SPECS.map((spec) => [spec.id, spec]));

/** The command `id`; it throws for an id the table does not have, which is a mistake in the code. */
export function commandSpec(id: string): CommandSpec {
  const spec = BY_ID.get(id);
  if (!spec) throw new Error(`no command "${id}"`);
  return spec;
}

/** The keys of the command `id` (a `formatKeys` spec), for a tooltip to show. */
export const commandKeys = (id: string): string | undefined => commandSpec(id).keys;

/**
 * Where a command is listed: its menu, by the name the menu bar shows. macOS's app menu is named
 * after the app; elsewhere its commands end the File menu (see src-tauri/src/menu.rs).
 */
export const menuLabel = (menu: MenuName, system: System = SYSTEM): string =>
  menu !== "App" ? menu : system === "macos" ? "SlopSlide" : "File";

// ---------------------------------------------------------------------------------------------
// Keys: a key pressed, written as a spec, to tell which command's keys it was.

/** A key as pressed: in the app (a keyboard event) or in a slide preview, which forwards it. */
export interface PressedKeys {
  key: string;
  code?: string;
  mod: boolean;
  shift: boolean;
  alt?: boolean;
}

/** Keys by their place on the keyboard, which Shift and Alt do not change. */
const CODE_KEYS: Record<string, string> = {
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Minus: "-",
  Equal: "plus",
  Enter: "enter",
  NumpadEnter: "enter",
  Backspace: "backspace",
};

/** Keys by what they type, for keys that came without their place (from a slide preview). */
const TYPED_KEYS: Record<string, string> = {
  "|": "\\",
  "{": "[",
  "}": "]",
  "<": ",",
  ">": ".",
  "?": "/",
  _: "-",
  "=": "plus",
  "+": "plus",
  Enter: "enter",
  Backspace: "backspace",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** The key itself, without modifiers, as a spec names it. */
function keyName({ key, code }: PressedKeys): string {
  const letter = code ? /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code) : null;
  if (letter) return (letter[1] ?? letter[2]!).toLowerCase();
  if (code && CODE_KEYS[code]) return CODE_KEYS[code];
  return TYPED_KEYS[key] ?? key.toLowerCase();
}

/** A spec with its parts in one order, so that two specs of the same keys are the same text. */
export function normalKeys(spec: string): string {
  const parts = spec.toLowerCase().split("+");
  // "mod+plus" and "ctrl++" end in an empty part for the "+" key.
  const key = spec.endsWith("++") ? "plus" : parts.at(-1)!;
  const modifiers = ["ctrl", "alt", "shift", "mod"].filter((modifier) => parts.slice(0, -1).includes(modifier));
  return [...modifiers, key].join("+");
}

/** The pressed keys as a spec in the order `normalKeys` gives. */
export function pressedSpec(pressed: PressedKeys): string {
  const modifiers = [pressed.alt && "alt", pressed.shift && "shift", pressed.mod && "mod"].filter(Boolean);
  return [...modifiers, keyName(pressed)].join("+");
}

/** The command whose keys were pressed, among `specs`; null for none. */
export function commandForKeys(pressed: PressedKeys, specs: readonly CommandSpec[] = COMMAND_SPECS): string | null {
  const spec = pressedSpec(pressed);
  return specs.find((command) => command.keys && normalKeys(command.keys) === spec)?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Menu echoes: the page owns every key. On macOS the menu bar shows the keys too and is offered a
// key the page did not keep to itself, so a key pressed once can come back as a menu choice; that
// echo is not run again.

/** How long after a key a menu choice of the same keys counts as its echo, not a click. */
export const ECHO_MS = 600;

interface SeenKey {
  spec: string;
  at: number;
  /** Whether the page acted on it (took it, with `preventDefault`). */
  taken: () => boolean;
}

let lastKey: SeenKey | null = null;

/** Notes a key the page saw, and how to tell later whether it acted on it. */
export function noteKey(pressed: PressedKeys, taken: () => boolean, now = Date.now()): void {
  if (!pressed.mod) return;
  lastKey = { spec: pressedSpec(pressed), at: now, taken };
}

/**
 * What a menu choice of `keys` is, coming `now`: "click" for a choice made with the pointer or
 * through the menu bar's own keyboard, "taken" for the echo of a key the page acted on, "left"
 * for the echo of one it left alone (one it does not use where it was pressed, such as ⌘Z in a
 * text field, which the field's own undo is for).
 */
export function menuChoice(keys: string | undefined, now = Date.now()): "click" | "taken" | "left" {
  if (!keys || !lastKey || now - lastKey.at > ECHO_MS || normalKeys(keys) !== lastKey.spec) return "click";
  const seen = lastKey;
  lastKey = null;
  return seen.taken() ? "taken" : "left";
}

/** Forgets the key last seen (for tests). */
export function forgetKeys(): void {
  lastKey = null;
}

// ---------------------------------------------------------------------------------------------
// Search: what the palette finds for what is typed.

/** A command found, how well, and which letters of its title matched (to mark them). */
export interface Found<T> {
  item: T;
  score: number;
  /** Indexes into the title. */
  marks: number[];
}

/**
 * Where `query`'s letters occur in `text` in order, preferring the starts of words and runs of
 * letters; null when they do not all occur. A higher score is a better match.
 */
export function fuzzyMatch(query: string, text: string): { score: number; marks: number[] } | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, marks: [] };
  const marks: number[] = [];
  let score = 0;
  let from = 0;
  for (let i = 0; i < q.length; i++) {
    const char = q[i]!;
    if (char === " ") continue;
    // A word start or the next letter of a run beats a letter somewhere in a word.
    const run = marks.length > 0 && t[marks.at(-1)! + 1] === char ? marks.at(-1)! + 1 : -1;
    const wordStart = findWordStart(t, char, from);
    const at = run >= 0 ? run : wordStart >= 0 ? wordStart : t.indexOf(char, from);
    if (at < 0) return null;
    score += at === run ? 3 : at === wordStart ? (at === 0 ? 6 : 4) : 1;
    marks.push(at);
    from = at + 1;
  }
  // Shorter titles match better, and a title that starts with the query best of all.
  if (t.startsWith(q)) score += 10;
  return { score: score - t.length * 0.01, marks };
}

const isWordStart = (text: string, at: number) => at === 0 || /[\s\-/(]/.test(text[at - 1]!);

function findWordStart(text: string, char: string, from: number): number {
  for (let at = text.indexOf(char, from); at >= 0; at = text.indexOf(char, at + 1)) {
    if (isWordStart(text, at)) return at;
  }
  return -1;
}

/**
 * The items `query` finds, the best first: by their title, or by their title with their group
 * ("view zoom" finds View's Zoom in). Those used most recently come first among equals, and with
 * no query, before the rest, which stay in their order.
 */
export function searchCommands<T extends { id: string; title: string; group: string }>(
  items: readonly T[],
  query: string,
  recent: readonly string[] = [],
): Found<T>[] {
  const q = query.trim();
  const recency = (item: T) => {
    const at = recent.indexOf(item.id);
    return at < 0 ? 0 : (recent.length - at) / recent.length;
  };
  if (!q) {
    const used = recent.flatMap((id) => items.filter((item) => item.id === id));
    const rest = items.filter((item) => !recent.includes(item.id));
    return [...used, ...rest].map((item) => ({ item, score: 0, marks: [] }));
  }
  const found: Found<T>[] = [];
  for (const item of items) {
    const byTitle = fuzzyMatch(q, item.title);
    // "file close" finds File's Close deck: the group's name, then the title; the better match counts.
    const withGroup = groupMatch(q, item);
    const match = byTitle && (!withGroup || byTitle.score >= withGroup.score) ? byTitle : withGroup;
    if (match) found.push({ item, score: match.score + recency(item) * 2, marks: match.marks });
  }
  return found.sort((a, b) => b.score - a.score);
}

/** A match of `query` against "group title", its marks only those in the title. */
function groupMatch(query: string, item: { title: string; group: string }) {
  const prefix = `${item.group} `;
  const match = fuzzyMatch(query, prefix + item.title);
  if (!match) return null;
  const marks = match.marks.filter((at) => at >= prefix.length).map((at) => at - prefix.length);
  return { score: match.score - 2, marks };
}

// ---------------------------------------------------------------------------------------------
// Recent commands, for the palette to offer first.

const RECENT_KEY = "slopslide.recentCommands";
export const RECENT_MAX = 5;

/** The commands run last, the latest first. */
export function loadRecent(): string[] {
  return loadJson(RECENT_KEY, [], (saved) =>
    Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string" && BY_ID.has(id)) : [],
  );
}

/** Notes that `id` was run; nothing is lost when it cannot be remembered. */
export function noteRecent(id: string): void {
  const next = [id, ...loadRecent().filter((other) => other !== id)].slice(0, RECENT_MAX);
  try {
    saveJson(RECENT_KEY, next);
  } catch {
    // Storage is full or unavailable: the palette just offers no recent commands.
  }
}

// ---------------------------------------------------------------------------------------------
// The shortcut help's rows of the commands.

/** The help's rows of the commands listed under `section`: their keys, and what they do. */
export function helpRows(section: string, specs: readonly CommandSpec[] = COMMAND_SPECS): [string, string][] {
  return specs
    .filter((spec) => spec.keys && spec.help === section)
    .map((spec) => [`{${spec.keys}}`, spec.describe ?? spec.title.replace(/…$/, "")]);
}

/** A command's name with its keys, as a tooltip shows it: "Zoom in (⌘=)". */
export function titleWithKeys(id: string): string {
  const spec = commandSpec(id);
  return spec.keys ? `${spec.title} (${formatKeys(spec.keys)})` : spec.title;
}
