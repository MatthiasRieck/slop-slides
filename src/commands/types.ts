// What a command does and when it can, by its id in src/lib/commands.json, and the state each
// decides that from.
import { useChanges } from "../changesStore";
import { slideReport } from "../components/stage/editorState";
import type { EditSelection } from "../lib/editTools";
import { type DeckMode, deckMode, editingSlide, useApp } from "../store";
import type { AppState } from "../store/types";
import { type StageTarget, stageTarget } from "./stage";

/** The app as the commands see it when asked whether they can run, and when run. */
export interface CommandContext {
  app: AppState;
  /** The deck's mode; null with no deck open. */
  mode: DeckMode | null;
  /** The slide editor is at work on the slide shown (Edit mode, and the slide is not locked). */
  editing: boolean;
  /** What is selected on the slide, while the editor is at work. */
  selection: EditSelection | null;
  /** How many elements are selected on the slide. */
  selected: number;
  /** The open deck is kept in a Git repository, so it has a Changes mode. */
  repository: boolean;
  /** The stage, while it shows a slide. */
  stage: StageTarget | null;
}

/** The context as it is now. */
export function commandContext(): CommandContext {
  const app = useApp.getState();
  const editing = editingSlide(app);
  const report = editing ? slideReport() : null;
  const selection = report?.selection ?? null;
  return {
    app,
    mode: app.deck ? deckMode(app) : null,
    editing,
    selection,
    selected: selection ? Math.max(1, report!.layers.filter((layer) => layer.selected).length) : 0,
    repository: !!app.deck && useChanges.getState().repository === app.deck.id,
    stage: stageTarget(),
  };
}

/**
 * What a command does. `enabled` says whether it can run now: true, or why not, in words for the
 * person who tried (the palette shows it beside the greyed command). Without it, a command can
 * always run. `checked` is whether a command that is on or off is on.
 */
export interface CommandAction {
  enabled?: (ctx: CommandContext) => true | string;
  checked?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => unknown;
}

export type CommandActions = Record<string, CommandAction>;

// Why a command cannot run, said the same way everywhere.
export const WHY = {
  showing: "Not during a show",
  noFolder: "Open a folder first",
  noDeck: "Open a deck first",
  noFile: "Open a deck or a file first",
  noSlide: "Add a slide first",
  notOnStage: "Only in View and Edit",
  notEditing: "Only in Edit, on a slide that is not locked",
  nothingSelected: "Select something on the slide first",
  noText: "Select text or a text box first",
  locked: "The selection is locked",
} as const;

/** The checks most commands start with, in order: the first that fails says why. */
export function needs(ctx: CommandContext, ...checks: ("deck" | "slide" | "stage" | "editing" | "selection")[]) {
  for (const check of checks) {
    if (check === "deck" && !ctx.app.deck) return WHY.noDeck;
    if (check === "slide" && !ctx.app.deck?.slides.length) return ctx.app.deck ? WHY.noSlide : WHY.noDeck;
    if (check === "stage" && ctx.mode !== "view" && ctx.mode !== "edit")
      return ctx.app.deck ? WHY.notOnStage : WHY.noDeck;
    if (check === "editing" && !ctx.editing) return ctx.app.deck ? WHY.notEditing : WHY.noDeck;
    if (check === "selection" && !ctx.selection) return WHY.nothingSelected;
  }
  return true;
}
