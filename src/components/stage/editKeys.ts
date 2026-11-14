import {
  EDIT_TOOL_KEYS,
  type EditStyle,
  type EditTool,
  familyOf,
  type StackOrder,
  type TextAlign,
} from "../../lib/editTools";
import { useApp } from "../../store";

const TOOL_NAMES: Record<EditTool, true> = {
  select: true,
  text: true,
  rect: true,
  rounded: true,
  ellipse: true,
  triangle: true,
  star: true,
  bubble: true,
  diamond: true,
  chevron: true,
  "block-arrow": true,
  "double-arrow": true,
  hexagon: true,
  octagon: true,
  pentagon: true,
  parallelogram: true,
  trapezoid: true,
  plus: true,
  cylinder: true,
  document: true,
  heart: true,
  bracket: true,
  brace: true,
  draw: true,
  line: true,
  arrow: true,
  elbow: true,
  curve: true,
  paint: true,
};

/** Whether the editor named one of its tools. */
export const isEditTool = (name: string): name is EditTool => name in TOOL_NAMES;

/** Picks the editor's tool, with the style of what it adds. */
export function toolMessage(tool: EditTool, styles: Record<string, EditStyle>) {
  const family = familyOf(tool);
  return { type: "slop:edit-tool", tool, style: family ? styles[family] : undefined };
}

/**
 * Edit mode's plain keys: a tool's shortcut picks it, Escape puts the tool away or else leaves
 * edit mode. `fromApp` when pressed in the app rather than forwarded by the slide, where
 * Escape belongs to whatever has focus. True when the key was one of them.
 */
export function runEditKey(key: string, fromApp = false) {
  const app = useApp.getState();
  const tool = EDIT_TOOL_KEYS[key.toLowerCase()];
  if (tool && key.length === 1) {
    app.setEditTool(tool);
  } else if (key === "Escape" && app.editTool !== "select") {
    app.setEditTool("select");
  } else if (key === "Escape" && !fromApp) {
    app.setEditing(false);
  } else {
    return false;
  }
  return true;
}

/** What a shortcut on the selection asks for when it is pressed with the focus in the app, not in the slide. */
export type EditShortcut =
  /** A message for the slide editor. */
  | { post: Record<string, unknown> }
  /** The selection's lock, turned over: the app knows whether it is locked. */
  | { lock: true }
  /** The copied look, which the app keeps, onto the selection. */
  | { pasteStyle: true }
  /** The toolbar's Link popover. */
  | { panel: "link" };

/** The keys of a keyboard event that tell a shortcut. */
export type ShortcutKey = Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey">;

/** Which of a pair of keys was pressed (1 for the second, -1 for the first), shifted or not; 0 for neither. */
function keyOfPair(event: ShortcutKey, first: string, second: string, firstCode: string, secondCode: string) {
  if (second.includes(event.key) || event.code === secondCode) return 1;
  if (first.includes(event.key) || event.code === firstCode) return -1;
  return 0;
}

const ALIGN_KEYS: Record<string, TextAlign> = { l: "left", e: "center", r: "right", j: "justify" };

/**
 * The shortcut on the selection that a key pressed with ⌘ / Ctrl is, as the slide editor has
 * them (`runShortcut` in src-tauri/assets/editor/): restacking (] and [, with Shift to the front
 * and back), text alignment (Shift+L / E / R / J) and size (Shift+. / Shift+,), flips (Shift+H /
 * Shift+V), the lock (Alt+L), copying and pasting a look (Alt+C / Alt+V) and the link popover (K).
 * Null for any other key. With Alt held a key types something else, so there it goes by its place.
 */
export function editShortcut(event: ShortcutKey): EditShortcut | null {
  const code = event.altKey ? /^Key([A-Z])$/.exec(event.code ?? "") : null;
  const letter = code ? code[1]!.toLowerCase() : event.key.toLowerCase();
  if (event.altKey) {
    if (event.shiftKey) return null;
    if (letter === "l") return { lock: true };
    if (letter === "c") return { post: { type: "slop:edit-copy-style" } };
    return letter === "v" ? { pasteStyle: true } : null;
  }
  const bracket = keyOfPair(event, "[{", "]}", "BracketLeft", "BracketRight");
  if (bracket) {
    const to: StackOrder = event.shiftKey ? (bracket > 0 ? "front" : "back") : bracket > 0 ? "forward" : "backward";
    return { post: { type: "slop:edit-order", to } };
  }
  if (!event.shiftKey) return letter === "k" ? { panel: "link" } : null;
  const align = ALIGN_KEYS[letter];
  if (align) return { post: { type: "slop:edit-style", style: { align } } };
  const size = keyOfPair(event, ",<", ".>", "Comma", "Period");
  if (size) return { post: { type: "slop:edit-font-step", step: size } };
  if (letter === "h" || letter === "v") return { post: { type: "slop:edit-flip", axis: letter === "h" ? "x" : "y" } };
  return null;
}

/** ⌘Z undoes, ⇧⌘Z / ⌘Y redo; true when the key was one of them. */
export function runHistoryKey(key: string, shift: boolean) {
  const lower = key.toLowerCase();
  if (lower === "z" && !shift) void useApp.getState().undo();
  else if ((lower === "z" && shift) || lower === "y") void useApp.getState().redo();
  else return false;
  return true;
}
