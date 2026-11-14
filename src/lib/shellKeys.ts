// The workbench's own keyboard shortcuts: which keys ask for what. They are commands of the
// registry (./commands.json), whose keys the menu bar, the palette and the shortcut help show;
// acting on them is hooks/useShellKeys.ts, through the registry.
import { type CommandSpec, commandForKeys, commandSpec, type PressedKeys } from "./commands";

/**
 * What a shell shortcut asks for: a mode, a panel shown or hidden, the app's settings, another
 * deck or folder, the word that everything is saved, closing the deck or the window, and the
 * command palette.
 */
export type ShellCommand =
  | "view"
  | "edit"
  | "git"
  | "sidebar"
  | "rail"
  | "appSettings"
  | "openDeck"
  | "openFolder"
  | "save"
  | "close"
  | "closeWindow"
  | "palette";

/** The registry's command each shell shortcut is. */
export const SHELL_COMMAND_IDS: Record<ShellCommand, string> = {
  view: "view.view",
  edit: "view.edit",
  git: "view.changes",
  sidebar: "view.sidebar",
  rail: "view.rail",
  appSettings: "app.settings",
  openDeck: "file.openDeck",
  openFolder: "file.openFolder",
  save: "file.save",
  close: "file.close",
  closeWindow: "file.closeWindow",
  palette: "help.palette",
};

const SHELL = Object.entries(SHELL_COMMAND_IDS) as [ShellCommand, string][];
const SPECS: CommandSpec[] = SHELL.map(([, id]) => commandSpec(id));

/** The keys of each command, as `formatKeys` specs. */
export const SHELL_SHORTCUTS = Object.fromEntries(
  SHELL.map(([command, id]) => [command, commandSpec(id).keys!]),
) as Record<ShellCommand, string>;

/** A key as pressed: in the app (a keyboard event) or in a slide preview, which forwards it. */
export type PressedKey = PressedKeys;

/** The command the pressed key asks for; null when it is not a shell shortcut. */
export function shellCommand(pressed: PressedKey): ShellCommand | null {
  if (!pressed.mod) return null;
  const id = commandForKeys(pressed, SPECS);
  return SHELL.find(([, other]) => other === id)?.[0] ?? null;
}
