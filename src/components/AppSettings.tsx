import { useApp } from "../store";
import { Dialog } from "./Dialog";
import { SettingsPanel } from "./SettingsPanel";

/**
 * The app's settings, in a dialog over the window. It is mounted once, for the whole app, and
 * opens from `openAppSettings` in the store: the gear in the sidebar or the top bar, ⌘, and the
 * start screen. Escape, its Close button or a press beside it closes it.
 */
export function AppSettings() {
  const open = useApp((s) => s.appSettingsOpen);
  if (!open) return null;
  return (
    <Dialog
      label="App settings"
      onClose={() => useApp.getState().closeAppSettings()}
      size="lg"
      className="h-[26rem]"
      title="App settings"
      closeOnBackdrop
      closeButton
      backdropTestId="app-settings-backdrop"
    >
      <SettingsPanel />
    </Dialog>
  );
}
