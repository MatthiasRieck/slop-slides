import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const isMac = navigator.userAgent.includes("Mac");
const isWindows = navigator.userAgent.includes("Windows");
/** Dev-only: the UI is running in a plain browser via dev/browserPreview.ts. */
const inBrowserPreview = import.meta.env.DEV && !("__TAURI_INTERNALS__" in window);

/** URL of a deck file served by the backend's `slop://` protocol. */
export function deckFileUrl(deckId: string, path: string, query?: string): string {
  const encoded = [deckId, ...path.split("/")].map(encodeURIComponent).join("/");
  // WebView2 (Windows) and Android expose custom schemes as http://<scheme>.localhost.
  const base = inBrowserPreview ? "/__deck" : isWindows ? "http://slop.localhost" : "slop://localhost";
  return `${base}/${encoded}${query ? `?${query}` : ""}`;
}

/**
 * One slide of a deck rendered by the embedded player, for editor previews. With `edit`
 * (any value; changing it reloads the slide), the backend adds the slide editor.
 */
export function slideUrl(deckId: string, slideId: string, version: string, still = false, edit?: string): string {
  const editing = edit === undefined ? "" : `&edit=${encodeURIComponent(edit)}`;
  const query = `embed&slide=${encodeURIComponent(slideId)}&v=${version}${still ? "&static" : ""}${editing}`;
  return deckFileUrl(deckId, "deck.html", query);
}

/** Whether `url` is a slide preview with the editor (see {@link slideUrl}). */
export const isEditUrl = (url: string) => url.includes("&edit=");

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
