// Keyboard shortcuts: which modifier commands, how a shortcut is written on this platform, and
// whether a key pressed somewhere belongs to what it was pressed in.
import { isMac } from "./utils";

/** The modifiers of a key or pointer event. */
type Modifiers = Pick<KeyboardEvent, "metaKey" | "ctrlKey">;

/** Whether the platform's command modifier is held: ⌘ on macOS, Ctrl elsewhere. */
export function isMod(event: Modifiers, mac = isMac): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/** The modifiers a shortcut can name. */
type Modifier = "ctrl" | "alt" | "shift" | "mod";

/** How the modifiers are written, in the order they go: macOS ends on ⌘, the others start with Ctrl. */
const MAC_MODIFIERS: [Modifier, string][] = [
  ["ctrl", "⌃"],
  ["alt", "⌥"],
  ["shift", "⇧"],
  ["mod", "⌘"],
];
const OTHER_MODIFIERS: [Modifier, string][] = [
  ["mod", "Ctrl"],
  ["ctrl", "Ctrl"],
  ["alt", "Alt"],
  ["shift", "Shift"],
];
const isModifier = (part: string): part is Modifier => MAC_MODIFIERS.some(([modifier]) => modifier === part);

/** Keys with a name of their own, as macOS writes them and as the others do. */
const NAMED_KEYS: Record<string, [mac: string, other: string]> = {
  enter: ["↵", "Enter"],
  backspace: ["⌫", "Backspace"],
  delete: ["⌦", "Delete"],
  escape: ["Esc", "Esc"],
  space: ["Space", "Space"],
  tab: ["Tab", "Tab"],
  up: ["↑", "↑"],
  down: ["↓", "↓"],
  left: ["←", "←"],
  right: ["→", "→"],
  arrows: ["Arrows", "Arrows"],
  pageup: ["Page Up", "Page Up"],
  pagedown: ["Page Down", "Page Down"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  plus: ["+", "+"],
};

/**
 * A shortcut as the platform writes it: `formatKeys("mod+shift+z")` is "⇧⌘Z" on macOS and
 * "Ctrl+Shift+Z" elsewhere. The spec is `+`-separated, in any order and case: the modifiers
 * `mod` (⌘, or Ctrl), `shift`, `alt` and `ctrl`, then one key, by name (`enter`, `backspace`,
 * `delete`, `escape`, `space`, `tab`, `up`, `down`, `left`, `right`, `arrows`, `pageup`,
 * `pagedown`, `home`, `end`, `plus`) or as it is (`z`, `0`, `?`, `f5`). The modifiers alone
 * (`shift`) name what is held while doing something else.
 */
export function formatKeys(spec: string, mac = isMac): string {
  const parts = spec
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const held = (mac ? MAC_MODIFIERS : OTHER_MODIFIERS).filter(([modifier]) => parts.includes(modifier));
  // Ctrl is both the command modifier and itself off macOS; it is written once.
  const modifiers = [...new Set(held.map(([, name]) => name))];
  const key = parts.find((part) => !isModifier(part));
  const keyName =
    key === undefined
      ? []
      : [NAMED_KEYS[key]?.[mac ? 0 : 1] ?? (key.length === 1 ? key.toUpperCase() : capitalized(key))];
  return [...modifiers, ...keyName].join(mac ? "" : "+");
}

const capitalized = (word: string) => word[0]!.toUpperCase() + word.slice(1);

/** Where text is typed or a value picked with the keys: every key pressed there is its own. */
const TEXT_FIELDS = "input, textarea, select, [contenteditable]";

/** Widgets that move through their own parts with the keys, wherever in them the focus is. */
const KEYBOARD_WIDGETS = "[role=slider], [role=menu], [role=dialog], [role=tree], [role=tablist], [role=listbox]";

const within = (target: EventTarget | null, selector: string) =>
  Boolean((target as Element | null)?.closest?.(selector));

/**
 * Whether `target` is where text is typed: a field, a select or editable text. Every key
 * pressed there is its own, shortcuts with a modifier included (⌘Z undoes the typing).
 */
export function isTextField(target: EventTarget | null): boolean {
  return within(target, TEXT_FIELDS);
}

/**
 * Whether a plain key pressed on `target` belongs to it rather than to the app's shortcuts: a
 * text field, a slider, or anything in a menu, dialog, tree, tab list or list box, which the
 * arrows, letters and Escape work within. Shortcuts with a modifier only need {@link isTextField}.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  return within(target, `${TEXT_FIELDS}, ${KEYBOARD_WIDGETS}`);
}

/**
 * Whether a key belongs to what it was pressed in, so that the app's shortcuts leave it alone:
 * any key in a text field, and a key without ⌘ or Ctrl in a keyboard widget (see
 * {@link isTypingTarget}).
 */
export function keepsKey(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey ? isTextField(event.target) : isTypingTarget(event.target);
}
