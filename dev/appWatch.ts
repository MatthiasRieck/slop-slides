import path from "node:path";

/**
 * Deck HTML is user data, including decks opened from inside this checkout.
 * Its own file watcher refreshes the slide. Vite must only reload for the app shell:
 * reloading the entire webview loses the in-memory workspace and shows Home.
 */
export function ignoreDeckHtml(appEntry: string) {
  const entry = path.resolve(appEntry);
  return (file: string) => /\.html?$/i.test(file) && path.resolve(file) !== entry;
}
