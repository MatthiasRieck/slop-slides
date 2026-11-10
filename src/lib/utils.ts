import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const isMac = navigator.userAgent.includes("Mac");
export const isWindows = navigator.userAgent.includes("Windows");
/** What revealing a file in the system's file manager is called here. */
export const revealLabel = revealLabelFor(navigator.userAgent);

/** `n` and the word for that many, like `1 slide` or `3 slides`; `many` is `one` with an s unless given. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function revealLabelFor(userAgent: string): string {
  if (userAgent.includes("Mac")) return "Show in Finder";
  if (userAgent.includes("Windows")) return "Show in File Explorer";
  return "Show in folder";
}
/** Dev-only: the UI is running in a plain browser via dev/browserPreview.ts. */
const inBrowserPreview = import.meta.env.DEV && !("__TAURI_INTERNALS__" in window);

/** URL of a file served by the backend's `slop://` protocol, as `<prefix>/<path>`. */
function servedUrl(prefix: string, path: string, query?: string): string {
  const encoded = [prefix, ...path.split("/")].map(encodeURIComponent).join("/");
  // WebView2 (Windows) and Android expose custom schemes as http://<scheme>.localhost.
  const base = inBrowserPreview ? "/__deck" : isWindows ? "http://slop.localhost" : "slop://localhost";
  return `${base}/${encoded}${query ? `?${query}` : ""}`;
}

/** First path segments the backend serves files under (see src-tauri/src/protocol.rs). */
const FILE_PREFIX = ".file";
const SESSION_PREFIX = ".session";
const HEAD_PREFIX = ".head";

/** A filesystem path for transport: strip Windows verbatim prefixes, but retain UNC roots. */
function urlPath(absolute: string): string {
  // Rust canonicalize() returns \\?\C:\… or \\?\UNC\server\share\… on Windows.
  const path = absolute
    .replaceAll("\\", "/")
    .replace(/^\/\/\?\/UNC\//, "//")
    .replace(/^\/\/\?\/(?=[A-Za-z]:\/)/, "");
  return path.startsWith("//") ? path : path.replace(/^\//, "");
}

/** URL of a file in the open workspace, by its absolute path. */
export function fileUrl(absolute: string, query?: string): string {
  return servedUrl(FILE_PREFIX, urlPath(absolute), query);
}

/** The folder holding a file (`/`-separated, as the path came). */
export function dirname(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at < 0 ? "" : path.slice(0, at);
}

/** The file name at the end of a path. */
export function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
}

/**
 * URL of a file next to the deck (an attached asset), by its path relative to the deck file.
 * A deck's id is its file's absolute path.
 */
export function deckFileUrl(deckId: string, path: string, query?: string): string {
  return fileUrl(`${dirname(deckId)}/${path}`, query);
}

/** Files the app keeps in the deck's session (screenshots) come as absolute paths. */
export function isSessionFile(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/** Chat attachments are workspace-relative; screenshots are absolute session paths. */
export function workspaceChatFileUrl(workspace: string, path: string): string {
  if (isSessionFile(path)) return servedUrl(SESSION_PREFIX, urlPath(path));
  return fileUrl(`${workspace}/${path}`);
}

/**
 * One slide of a deck rendered by the embedded player, for editor previews. With `pan`, the
 * backend adds the pasteboard to pan and zoom around the slide; with `edit` (any value; changing
 * it reloads the slide), the slide editor, which comes with the pasteboard.
 */
export function slideUrl(
  deckId: string,
  slideId: string,
  version: string,
  still = false,
  edit?: string,
  pan = false,
): string {
  const editing = edit === undefined ? "" : `&edit=${encodeURIComponent(edit)}`;
  const query = `embed&slide=${encodeURIComponent(slideId)}&v=${version}${still ? "&static" : ""}${pan ? "&pan" : ""}${editing}`;
  return fileUrl(deckId, query);
}

/**
 * One slide of the deck as of the last commit, as a still preview. `print` brings its player
 * runtime up to date, as the commit's may be too old for the embedded preview.
 */
export function headSlideUrl(deckId: string, slideId: string, commit: string): string {
  const query = `embed&slide=${encodeURIComponent(slideId)}&v=${commit}&static&print`;
  return servedUrl(HEAD_PREFIX, urlPath(deckId), query);
}

/** First path segment the backend serves templates under (see src-tauri/src/protocol.rs). */
const TEMPLATE_PREFIX = ".template";

/** One slide of a template, as a still preview (final animation frame). */
export function templateSlideUrl(templateId: string, slideId: string): string {
  return servedUrl(TEMPLATE_PREFIX, `${templateId}/deck.html`, `embed&slide=${encodeURIComponent(slideId)}&static`);
}

/** A slide id as a readable name: `pricing-tiers` → "Pricing tiers". */
export function layoutLabel(slideId: string): string {
  const words = slideId.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : slideId;
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
