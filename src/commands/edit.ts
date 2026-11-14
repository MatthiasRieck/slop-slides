// The Edit, Insert, Format and Arrange menus' commands: the deck's undo, and what the edit
// toolbar and the editor's context menu do to the slide, sent to the slide editor through the
// stage (see ./stage.ts).
import type { EditMenuAction } from "../components/EditContextMenu";
import type { AgentInsert, EditTool, TextAlign } from "../lib/editTools";
import { type CommandAction, type CommandActions, type CommandContext, needs, WHY } from "./types";

/** The selection can be changed: something is selected and it is not locked. */
function changeable(ctx: CommandContext): true | string {
  const ready = needs(ctx, "editing", "selection");
  if (ready !== true) return ready;
  return ctx.selection?.locked ? WHY.locked : true;
}

/** Text can be styled: what is selected holds text. */
function hasText(ctx: CommandContext): true | string {
  const ready = changeable(ctx);
  if (ready !== true) return ready;
  return ctx.selection?.text ? true : WHY.noText;
}

/** Sends `message` to the slide editor. */
const post = (ctx: CommandContext, message: Record<string, unknown>) => ctx.stage?.post(message);

/** A choice of the editor's context menu, on the selection. */
const onSelection = (action: EditMenuAction, enabled = changeable): CommandAction => ({
  enabled,
  run: (ctx) => ctx.stage?.menuAction(action),
});

/** A message to the editor about the selected text. */
const onText = (message: Record<string, unknown>): CommandAction => ({
  enabled: hasText,
  run: (ctx) => post(ctx, message),
});

const toggle = (key: string) => onText({ type: "slop:edit-toggle-style", key });
const align = (to: TextAlign) => onText({ type: "slop:edit-style", style: { align: to } });

/** Picks an edit tool, to add an element of its kind. */
const tool = (name: EditTool): CommandAction => ({
  enabled: (ctx) => needs(ctx, "editing"),
  run: (ctx) => ctx.app.setEditTool(name),
});

/** Asks the agent for an element of `kind`, with a screenshot of the slide. */
const ask = (kind: AgentInsert): CommandAction => ({
  enabled: (ctx) => needs(ctx, "editing"),
  run: (ctx) => ctx.stage?.askForInsert(kind),
});

/** Undo or redo: the typing in the slide while it is typed, else the deck's last change. */
const history = (redo: boolean): CommandAction => ({
  enabled: (ctx) => {
    if (ctx.selection?.editing) return true;
    const step = redo ? ctx.app.history?.redo : ctx.app.history?.undo;
    if (!step) return redo ? "Nothing to redo" : "Nothing to undo";
    return ctx.app.running ? "Once the agent is done" : true;
  },
  run: (ctx) => {
    if (ctx.selection?.editing) return post(ctx, { type: "slop:edit-undo", redo });
    return redo ? ctx.app.redo() : ctx.app.undo();
  },
});

/** At least `count` elements are selected and none is locked, as grouping or spacing them out takes. */
const atLeast =
  (count: number, words: string) =>
  (ctx: CommandContext): true | string => {
    const ready = changeable(ctx);
    if (ready !== true) return ready;
    return ctx.selected >= count ? true : `Select ${words} or more elements first`;
  };

export const EDIT_COMMANDS: CommandActions = {
  "edit.undo": history(false),
  "edit.redo": history(true),
  "edit.duplicate": onSelection("duplicate"),
  "edit.delete": onSelection("delete"),
  "edit.find": { enabled: (ctx) => needs(ctx, "stage"), run: (ctx) => ctx.app.openFind() },

  "insert.text": tool("text"),
  "insert.rect": tool("rect"),
  "insert.ellipse": tool("ellipse"),
  "insert.draw": tool("draw"),
  "insert.line": tool("line"),
  "insert.arrow": tool("arrow"),
  "insert.image": { enabled: (ctx) => needs(ctx, "editing"), run: (ctx) => ctx.stage?.pickImage(false) },
  "insert.table": ask("table"),
  "insert.chart": ask("chart"),
  "insert.icon": ask("icon"),

  "format.bold": toggle("bold"),
  "format.italic": toggle("italic"),
  "format.underline": toggle("underline"),
  "format.strike": toggle("strike"),
  "format.alignLeft": align("left"),
  "format.alignCenter": align("center"),
  "format.alignRight": align("right"),
  "format.justify": align("justify"),
  "format.bigger": onText({ type: "slop:edit-font-step", step: 1 }),
  "format.smaller": onText({ type: "slop:edit-font-step", step: -1 }),
  "format.link": { enabled: hasText, run: (ctx) => ctx.app.askForEditPanel("link") },
  "format.copyStyle": onSelection("copy-style", (ctx) => needs(ctx, "editing", "selection")),
  "format.pasteStyle": {
    enabled: (ctx) => {
      const ready = changeable(ctx);
      if (ready !== true) return ready;
      return ctx.app.copiedStyle ? true : "Copy a style first";
    },
    run: (ctx) => ctx.stage?.menuAction("paste-style"),
  },

  "arrange.front": onSelection("front"),
  "arrange.forward": onSelection("forward"),
  "arrange.backward": onSelection("backward"),
  "arrange.back": onSelection("back"),
  "arrange.group": onSelection("group", atLeast(2, "two")),
  "arrange.ungroup": onSelection("ungroup", (ctx) => {
    const ready = changeable(ctx);
    if (ready !== true) return ready;
    return ctx.selection?.group ? true : "Select a group first";
  }),
  "arrange.alignLeft": onSelection("align-left"),
  "arrange.alignCenter": onSelection("align-center"),
  "arrange.alignRight": onSelection("align-right"),
  "arrange.alignTop": onSelection("align-top"),
  "arrange.alignMiddle": onSelection("align-middle"),
  "arrange.alignBottom": onSelection("align-bottom"),
  "arrange.distributeH": onSelection("distribute-h", atLeast(3, "three")),
  "arrange.distributeV": onSelection("distribute-v", atLeast(3, "three")),
  "arrange.flipH": onSelection("flip-x", flippable),
  "arrange.flipV": onSelection("flip-y", flippable),
  "arrange.rotateRight": onSelection("rotate-right"),
  "arrange.rotateLeft": onSelection("rotate-left"),
  "arrange.lock": {
    enabled: (ctx) => needs(ctx, "editing", "selection"),
    checked: (ctx) => !!ctx.selection?.locked,
    run: (ctx) => post(ctx, { type: "slop:edit-lock", locked: !ctx.selection?.locked }),
  },
};

/** What is selected can be flipped: images, drawings, lines and shapes like a triangle, or several of them. */
function flippable(ctx: CommandContext): true | string {
  const ready = changeable(ctx);
  if (ready !== true) return ready;
  return ctx.selection?.flippable || ctx.selection?.group || ctx.selected > 1 ? true : "This element cannot be flipped";
}
