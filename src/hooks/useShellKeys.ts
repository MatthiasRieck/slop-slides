import { useEffect } from "react";

import { runCommand } from "../commands";
import { isMod } from "../lib/keys";
import { type PressedKey, SHELL_COMMAND_IDS, type ShellCommand, shellCommand } from "../lib/shellKeys";
import { useApp } from "../store";

/**
 * Does what a shell shortcut asks for, as the registry's command (see ../commands/); false when
 * it does not apply to what is open: a mode without a deck (Changes also without a repository),
 * a panel without a folder open, anything during a show, whose keys are the show's. The app's
 * settings, opening a deck or a folder, closing the window and the palette apply on the start
 * screen too.
 */
export function runShellCommand(command: ShellCommand): boolean {
  if (useApp.getState().presenting) return false;
  // ⌘W closes the deck, and with nothing open the window, as in any document app.
  if (command === "close") return runCommand("file.close") || runCommand("file.closeWindow");
  return runCommand(SHELL_COMMAND_IDS[command]);
}

const isFrame = (source: MessageEventSource | null) =>
  Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === source);

/**
 * The shell's keyboard shortcuts (see ../lib/shellKeys.ts): ⌘1 / ⌘2 / ⌘3 for View, Edit and
 * Changes, ⌘\ and ⇧⌘\ to show or hide the sidebar and the slide list, ⌘, for the app's settings,
 * ⌘O to open a deck and ⇧⌘O a folder, ⌘S for the word that everything is saved (the HTML and SVG
 * editors take that key for their own saving first), ⌘W to close the deck (with none open, the
 * window), ⇧⌘W to close the window and ⇧⌘P for the command palette. They work while typing too (the chat's
 * composer has the focus most of the time, and no field has a use for these keys), unless what
 * the key was pressed in took it: the model menu picks with ⌘1–9 in its own field. Those pressed in a slide preview count as well, which
 * forwards them as `slop:key`.
 */
export function useShellKeys() {
  useEffect(() => {
    const run = (pressed: PressedKey) => {
      const command = shellCommand(pressed);
      return command !== null && runShellCommand(command);
    };
    const onKey = (event: KeyboardEvent) => {
      // Taken already, by the field or widget it was pressed in.
      if (event.defaultPrevented) return;
      const pressed = { key: event.key, code: event.code, mod: isMod(event), shift: event.shiftKey, alt: event.altKey };
      if (run(pressed)) event.preventDefault();
    };
    const onMessage = (event: MessageEvent) => {
      const { type, key, mod, shift } = event.data ?? {};
      if (type !== "slop:key" || typeof key !== "string" || !isFrame(event.source)) return;
      run({ key, mod: Boolean(mod), shift: Boolean(shift) });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);
}
