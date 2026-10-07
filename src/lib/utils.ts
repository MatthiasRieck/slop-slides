import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

import { remote } from "./platform";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const isMac = navigator.userAgent.includes("Mac");
/** The window's title bar overlays the macOS traffic lights; a browser on a device has none. */
export const hasTrafficLights = isMac && !remote;
const isWindows = navigator.userAgent.includes("Windows");
/** Dev-only: the UI is running in a plain browser via dev/browserPreview.ts. */
const inBrowserPreview = import.meta.env.DEV && !("__TAURI_INTERNALS__" in window) && !remote;

/** URL of a deck file served by the backend's `slop://` protocol. */
export function deckFileUrl(deckId: string, path: string, query?: string): string {
  const encoded = [deckId, ...path.split("/")].map(encodeURIComponent).join("/");
  // WebView2 (Windows) and Android expose custom schemes as http://<scheme>.localhost. A device
  // gets the files from the desktop app's server (src-tauri/src/remote.rs).
  const base = remote
    ? `${remote.base}/deck`
    : inBrowserPreview
      ? "/__deck"
      : isWindows
        ? "http://slop.localhost"
        : "slop://localhost";
  return `${base}/${encoded}${query ? `?${query}` : ""}`;
}

/**
 * One slide of a deck rendered by the embedded player, for editor previews. With `pan`, the
 * backend adds the pasteboard to pan and zoom around the slide; with `edit` (any value; changing
 * it reloads the slide), the slide editor, which comes with the pasteboard.
 */
export function slideUrl(deckId: string, slideId: string, version: string, still = false, edit?: string, pan = false): string {
  const editing = edit === undefined ? "" : `&edit=${encodeURIComponent(edit)}`;
  const query = `embed&slide=${encodeURIComponent(slideId)}&v=${version}${still ? "&static" : ""}${pan ? "&pan" : ""}${editing}`;
  return deckFileUrl(deckId, "deck.html", query);
}

/** Whether `url` is a slide preview on the pasteboard, with or without the editor (see {@link slideUrl}). */
export const isPasteboardUrl = (url: string) => /&(pan(&|$)|edit=)/.test(url);

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
