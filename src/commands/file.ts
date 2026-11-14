// The File menu's commands, and the app's settings in macOS's app menu: what the top bar's file
// menu and the start screen do, from anywhere.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { importPowerPoint } from "../components/export/importPowerPoint";
import { chooseDeck, chooseWorkspace, pickPptx } from "../components/openDialogs";
import { api } from "../lib/api";
import type { ExportFormat } from "../lib/exportOptions";
import { showError } from "../store";
import { openExportDialog, useExports } from "../store/exports";
import { type CommandAction, type CommandActions, type CommandContext, needs, WHY } from "./types";

const folder = (ctx: CommandContext) => (ctx.app.workspace ? true : WHY.noFolder);

/** Closes this window, asking first about what closing it would lose (see `useCloseGuard`). */
export function closeWindow() {
  return getCurrentWindow()
    .close()
    .catch((error) => showError(error, { doing: "Could not close the window" }));
}

/** Exports the deck as `format`, through the export dialog the Export menu opens. */
const exportAs = (format: ExportFormat): CommandAction => ({
  enabled: (ctx) => {
    const ready = needs(ctx, "slide");
    if (ready !== true) return ready;
    return format === "video" && useExports.getState().runs.some((run) => run.format === "video")
      ? "A video is being exported; one at a time"
      : true;
  },
  run: () => openExportDialog(format),
});

export const FILE_COMMANDS: CommandActions = {
  "app.settings": { run: (ctx) => ctx.app.openAppSettings() },
  "deck.new": { enabled: folder, run: (ctx) => ctx.app.setNewDeckOpen(true) },
  "window.new": {
    run: () => api.newWindow().catch((error) => showError(error, { doing: "Could not open a new window" })),
  },
  "file.openDeck": { run: () => chooseDeck() },
  "file.openFolder": { run: () => chooseWorkspace() },
  "file.importPptx": {
    enabled: folder,
    run: async () => {
      const path = await pickPptx();
      if (path) await importPowerPoint(path);
    },
  },
  // Its keys close the window when nothing is open in it (see `runShellCommand`).
  "file.close": {
    enabled: (ctx) => (ctx.app.openedFile ? true : WHY.noFile),
    run: (ctx) => ctx.app.closeDeck(),
  },
  "file.closeWindow": { run: () => closeWindow() },
  "file.closeFolder": { enabled: folder, run: (ctx) => ctx.app.closeWorkspace() },
  "file.save": { enabled: (ctx) => needs(ctx, "deck"), run: (ctx) => ctx.app.confirmSaved() },
  "deck.duplicate": {
    enabled: (ctx) => needs(ctx, "deck"),
    run: (ctx) => {
      if (ctx.app.openedFile) return ctx.app.duplicateDeck(ctx.app.openedFile.absolute, { open: true });
    },
  },
  "deck.reveal": {
    enabled: (ctx) => (ctx.app.openedFile || ctx.app.workspace ? true : WHY.noFolder),
    run: (ctx) => {
      const path = ctx.app.openedFile?.absolute ?? ctx.app.workspace?.path;
      if (path) return revealItemInDir(path).catch((error) => showError(error, { doing: "Could not show it" }));
    },
  },
  "deck.trash": {
    enabled: (ctx) => needs(ctx, "deck"),
    run: (ctx) => {
      const { openedFile, deck } = ctx.app;
      if (openedFile && deck) return ctx.app.trashDeck(openedFile.absolute, deck.title || "Untitled");
    },
  },
  "deck.settings": { enabled: (ctx) => needs(ctx, "deck"), run: (ctx) => ctx.app.openDeckSettings() },
  "export.pdf": exportAs("pdf"),
  "export.pptx": exportAs("pptx"),
  "export.html": exportAs("html"),
  "export.images": exportAs("images"),
  "export.video": exportAs("video"),
};
