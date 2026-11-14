// The Help menu's commands: the keyboard shortcuts and the command palette.
import { openPalette } from "./palette";
import type { CommandActions } from "./types";

export const HELP_COMMANDS: CommandActions = {
  "help.shortcuts": { run: (ctx) => ctx.app.setShortcutHelpOpen(true) },
  "help.palette": { run: () => openPalette() },
};
