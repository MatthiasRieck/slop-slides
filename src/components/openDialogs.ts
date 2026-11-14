// The system's dialogs for opening things: a folder, a deck, a PowerPoint file to import.
import { open } from "@tauri-apps/plugin-dialog";

import { useApp } from "../store";

/** Asks for a folder and opens it as the workspace. */
export async function chooseWorkspace() {
  const path = await open({ directory: true, title: "Open a folder" });
  if (path && !Array.isArray(path)) await useApp.getState().openWorkspace(path);
}

/** Asks for a deck file and opens it in its folder, which becomes the workspace. */
export async function chooseDeck() {
  const path = await open({
    title: "Open a deck",
    filters: [{ name: "HTML deck", extensions: ["html", "htm"] }],
  });
  if (path && !Array.isArray(path)) await useApp.getState().openDeckFile(path);
}

/** Asks for a PowerPoint file to import; null when the user cancels. */
export async function pickPptx(): Promise<string | null> {
  const path = await open({
    title: "Import PowerPoint",
    filters: [{ name: "PowerPoint presentation", extensions: ["pptx", "pptm", "potx"] }],
  });
  return path && !Array.isArray(path) ? path : null;
}
