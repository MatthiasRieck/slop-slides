import { listen } from "@tauri-apps/api/event";

import { type AgentEventEnvelope, api, type WorkspaceChanged } from "../lib/api";
import { basename, dirname } from "../lib/utils";
import { applyAgentEvent } from "./chat";
import { showErrorIn } from "./errors";
import { adoptReview } from "./review";
import type { AppStore } from "./types";

/** Follows the backend's events: the agent's, changes in the open workspace, and a folder opened from Finder. */
export async function initEventBridge(app: AppStore) {
  // Listing Codex models starts its app server; don't hold up the rest of the bridge.
  void app.getState().refreshProviders();
  await listen<AgentEventEnvelope>("agent-event", ({ payload }) => {
    if (payload.chat === app.getState().chatKey) applyAgentEvent(app, payload.event);
  });
  await listen<WorkspaceChanged>("workspace-changed", ({ payload }) => {
    if (payload.root === app.getState().workspace?.path) applyWorkspaceChanged(app, payload.paths);
  });
  // A folder opened with the app from Finder may be waiting for this window: one opened before
  // the window was up, or one sent to it later.
  await listen("folder-pending", () => void openPendingFolder(app));
  await openPendingFolder(app);
}

/** Opens the folder from Finder waiting for this window, if there is one. */
async function openPendingFolder(app: AppStore) {
  try {
    const path = await api.takePendingFolder();
    if (path) await app.getState().openWorkspace(path);
  } catch (error) {
    showErrorIn(app, error);
  }
}

/** Follows changes in the open workspace: the file tree, the open deck, the open page. */
function applyWorkspaceChanged(app: AppStore, paths: string[]) {
  const { openedFile, deck } = app.getState();
  app.setState((s) => ({ workspaceChange: { paths, rev: (s.workspaceChange?.rev ?? 0) + 1 } }));
  if (!openedFile) return;
  if (deck) {
    // The deck's own files, relative to its folder.
    const folder = dirname(openedFile.path);
    const inFolder = folder
      ? paths.filter((p) => p.startsWith(`${folder}/`)).map((p) => p.slice(folder.length + 1))
      : paths;
    return applyDeckChanged(app, inFolder, basename(openedFile.path));
  }
  if (paths.includes(openedFile.path)) app.setState((s) => ({ fileRev: s.fileRev + 1 }));
}

/** How long the deck file stays unchanged before it is reloaded. */
const RELOAD_DELAY = 120;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

/** `paths` are relative to the deck's folder; `file` is the deck file's name. */
function applyDeckChanged(app: AppStore, paths: string[], file: string) {
  if (paths.some((p) => p.startsWith("assets/"))) {
    app.setState((s) => ({ assetsRev: s.assetsRev + 1 }));
  }
  if (!paths.includes(file)) return;
  // Edits arrive in bursts while the agent works; reload once they settle.
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const { deck } = app.getState();
    if (!deck) return;
    try {
      const next = await api.loadDeck(deck.id);
      const before = new Map(deck.slides.map((s) => [s.id, s.hash]));
      const changed = next.slides.find((s) => before.get(s.id) !== s.hash);
      app.getState().setDeck(next);
      adoptReview(app, next);
      // Follow the agent to the slide it is working on.
      if (changed && app.getState().running) app.setState({ selected: changed.id });
    } catch {
      // The deck file is mid-write; the next change event retries.
    }
  }, RELOAD_DELAY);
}
