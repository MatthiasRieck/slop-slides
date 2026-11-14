// The command registry: every command of src/lib/commands.json with what it does. The menu bar,
// the command palette and the shell's shortcuts all run commands through here, so each does the
// same thing, and is offered in the same cases, wherever it is asked for.
import { COMMAND_SPECS, type CommandSpec, commandSpec } from "../lib/commands";
import { showError } from "../store";
import { EDIT_COMMANDS } from "./edit";
import { FILE_COMMANDS } from "./file";
import { HELP_COMMANDS } from "./help";
import { SLIDE_COMMANDS } from "./slide";
import { type CommandAction, type CommandContext, commandContext, WHY } from "./types";
import { VIEW_COMMANDS } from "./view";

export type { CommandContext } from "./types";
export { commandContext } from "./types";

/** A command: its name, menu and keys, and what it does. */
export type Command = CommandSpec & CommandAction;

/** What each command does, by its id. */
export const ACTIONS: Record<string, CommandAction> = {
  ...FILE_COMMANDS,
  ...EDIT_COMMANDS,
  ...VIEW_COMMANDS,
  ...SLIDE_COMMANDS,
  ...HELP_COMMANDS,
};

/** Every command, in menu order. */
export const COMMANDS: readonly Command[] = COMMAND_SPECS.map((spec) => {
  const action = ACTIONS[spec.id];
  if (!action) throw new Error(`the command "${spec.id}" does nothing`);
  return { ...spec, ...action };
});

const BY_ID = new Map(COMMANDS.map((command) => [command.id, command]));

/** The command `id`. */
export const command = (id: string): Command => BY_ID.get(id) ?? { ...commandSpec(id), run: () => {} };

/** What can be done during a show: the show has the keys and the window, but another window is a window of its own. */
const DURING_SHOW = new Set(["window.new", "file.closeWindow"]);

/** Whether `command` can run in `ctx`: true, or why not. */
export function commandEnabled(command: Command, ctx: CommandContext): true | string {
  if (ctx.app.presenting && !DURING_SHOW.has(command.id)) return WHY.showing;
  return command.enabled?.(ctx) ?? true;
}

/** Whether `command` is on, for one that is on or off. */
export const commandChecked = (command: Command, ctx: CommandContext): boolean =>
  !!command.check && !!command.checked?.(ctx);

/**
 * Runs the command `id` if it can run now; false when it cannot (or there is no such command).
 * What goes wrong while it runs is said in a message.
 */
export function runCommand(id: string, ctx: CommandContext = commandContext()): boolean {
  const found = BY_ID.get(id);
  if (!found || commandEnabled(found, ctx) !== true) return false;
  try {
    const done = found.run(ctx);
    if (done instanceof Promise) done.catch((error) => showError(error, { doing: `Could not do “${found.title}”` }));
  } catch (error) {
    showError(error, { doing: `Could not do “${found.title}”` });
  }
  return true;
}

/** The menu bar's state in `ctx`, as compact as it goes: the commands that cannot run, and those that are on. */
export interface MenuState {
  disabled: string[];
  checked: string[];
}

export function menuState(ctx: CommandContext): MenuState {
  return {
    disabled: COMMANDS.filter((command) => commandEnabled(command, ctx) !== true).map((command) => command.id),
    checked: COMMANDS.filter((command) => commandChecked(command, ctx)).map((command) => command.id),
  };
}
