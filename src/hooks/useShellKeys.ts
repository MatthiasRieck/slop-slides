import { useEffect } from "react";

import { useChanges } from "../changesStore";
import { chooseWorkspace } from "../components/openDialogs";
import { isMod } from "../lib/keys";
import { type PressedKey, type ShellCommand, shellCommand } from "../lib/shellKeys";
import { useApp } from "../store";

/**
 * Does what a shell shortcut asks for; false when it does not apply to what is open: a mode
 * without a deck (Git also without a repository), a panel without a folder open, anything
 * during a show, whose keys are the show's.
 */
export function runShellCommand(command: ShellCommand): boolean {
  const app = useApp.getState();
  if (app.presenting) return false;
  const { deck, workspace } = app;
  switch (command) {
    case "view":
    case "edit":
      if (!deck) return false;
      app.setMode(command);
      return true;
    case "git":
      if (!deck || useChanges.getState().repository !== deck.id) return false;
      app.setMode("git");
      return true;
    case "sidebar":
      if (!workspace) return false;
      app.setSidebarOpen(!app.sidebarOpen);
      return true;
    case "rail":
      if (!deck) return false;
      app.setRailOpen(!app.railOpen);
      return true;
    case "appSettings":
      if (!workspace) return false;
      app.setSidebarTab("settings");
      return true;
    case "openFolder":
      void chooseWorkspace();
      return true;
  }
}

const isFrame = (source: MessageEventSource | null) =>
  Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === source);

/**
 * The shell's keyboard shortcuts (see ../lib/shellKeys.ts): ⌘1 / ⌘2 / ⌘3 for View, Edit and Git,
 * ⌘\ and ⇧⌘\ to show or hide the sidebar and the slide list, ⌘, for the app's settings and ⌘O to
 * open a folder. They work while typing too (the chat's composer has the focus most of the time,
 * and no field has a use for these keys), unless what the key was pressed in took it: the model
 * menu picks with ⌘1–9 in its own field. Those pressed in a slide preview count as well, which
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
