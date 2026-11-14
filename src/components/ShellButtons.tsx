import { Keyboard, Settings } from "lucide-react";

import { formatKeys } from "../lib/keys";
import { SHELL_SHORTCUTS } from "../lib/shellKeys";
import { openShortcutHelp, useApp } from "../store";
import { ToolButton } from "./Button";

/**
 * The two app-level buttons: the app's settings and the keyboard shortcuts. They sit in the
 * sidebar's footer, and at the top bar's right end while the sidebar is hidden, so there is
 * always a way to both.
 */
export function ShellButtons() {
  const settingsOpen = useApp((s) => s.appSettingsOpen);
  return (
    <>
      <ToolButton
        variant="panel"
        size="md"
        label="App settings…"
        shortcut={SHELL_SHORTCUTS.appSettings}
        active={settingsOpen}
        onClick={() => useApp.getState().openAppSettings()}
      >
        <Settings className="size-4" />
      </ToolButton>
      <ToolButton
        variant="panel"
        size="md"
        label="Keyboard shortcuts"
        title={`Keyboard shortcuts (?, ${formatKeys("mod+/")})`}
        onClick={openShortcutHelp}
      >
        <Keyboard className="size-4" />
      </ToolButton>
    </>
  );
}
