import { EDIT_TOOL_KEYS, type EditStyle, type EditTool, familyOf } from "../../lib/editTools";
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

/** ⌘Z undoes, ⇧⌘Z / ⌘Y redo; true when the key was one of them. */
export function runHistoryKey(key: string, shift: boolean) {
  const lower = key.toLowerCase();
  if (lower === "z" && !shift) void useApp.getState().undo();
  else if ((lower === "z" && shift) || lower === "y") void useApp.getState().redo();
  else return false;
  return true;
}
