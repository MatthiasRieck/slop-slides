import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";

/**
 * Where the app runs. In the window, it talks to the backend over Tauri IPC. On a phone or
 * tablet, the desktop app serves it (src-tauri/src/remote.rs) and puts this config in the
 * page; commands then go over HTTP and events arrive as server-sent events.
 */
export interface RemoteConfig {
  /** Path prefix of the backend, `/s/<token>`. */
  base: string;
}

declare global {
  interface Window {
    __SLOPSLIDE_REMOTE__?: RemoteConfig;
  }
}

/** Set when the app runs on another device, served by the desktop app. */
export const remote: RemoteConfig | null = typeof window === "undefined" ? null : (window.__SLOPSLIDE_REMOTE__ ?? null);
export const isRemote = remote !== null;

/** A random id. `crypto.randomUUID` needs HTTPS, which devices on the local network don't have. */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Not a secure context.
    }
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** This window or device, to tell its own saves from others' (`chat-changed`). */
export const clientId = randomId();

/** Runs a backend command. Rejects with the error message, as Tauri does. */
export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (remote) return remoteInvoke<T>(remote.base, command, args);
  return args === undefined ? tauriInvoke<T>(command) : tauriInvoke<T>(command, args);
}

export async function remoteInvoke<T>(base: string, command: string, args?: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}/api/${command}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args ?? {}),
    });
  } catch {
    throw "Lost the connection to SlopSlide on your computer.";
  }
  if (response.status === 404) throw "SlopSlide on your computer stopped sharing. Scan its QR code again.";
  const text = await response.text();
  if (!response.ok) throw text || `${command} failed (${response.status})`;
  return (text ? JSON.parse(text) : undefined) as T;
}

type Handler = (event: { payload: unknown }) => void;

/** Sent to listeners when a device reconnects and may have missed events. */
export const RESYNC_EVENT = "resync";

const handlers = new Map<string, Set<Handler>>();
let source: EventSource | null = null;

function connect(base: string) {
  if (source) return;
  source = new EventSource(`${base}/events`);
  let dropped = false;
  source.onmessage = (message) => {
    let data: { event: string; payload: unknown };
    try {
      data = JSON.parse(message.data as string) as typeof data;
    } catch {
      return;
    }
    for (const handler of handlers.get(data.event) ?? []) handler({ payload: data.payload });
  };
  source.onerror = () => {
    dropped = true;
  };
  source.onopen = () => {
    if (!dropped) return;
    dropped = false;
    for (const handler of handlers.get(RESYNC_EVENT) ?? []) handler({ payload: null });
  };
}

/** Listens for a backend event; resolves to a function that stops listening. */
export async function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
  if (!remote) {
    // The window never misses events, so it never needs to catch up.
    if (event === RESYNC_EVENT) return () => {};
    return tauriListen<T>(event, handler);
  }
  connect(remote.base);
  const set = handlers.get(event) ?? new Set();
  handlers.set(event, set);
  const wrapped = handler as Handler;
  set.add(wrapped);
  return () => set.delete(wrapped);
}

/** Asks a yes/no question; the window's native dialog, or the browser's on a device. */
export async function confirmDialog(
  message: string,
  options: { title: string; kind?: "info" | "warning"; okLabel?: string },
): Promise<boolean> {
  if (!remote) {
    try {
      return await ask(message, options);
    } catch {
      // Fall back to the browser's dialog.
    }
  }
  return window.confirm(message);
}

/** Uploads a file from a device into the deck's assets; resolves to its deck-relative path. */
export async function uploadAsset(deckId: string, file: File): Promise<string> {
  if (!remote) throw new Error("uploads are for devices");
  const url = `${remote.base}/upload/${encodeURIComponent(deckId)}?name=${encodeURIComponent(file.name)}`;
  const response = await fetch(url, { method: "POST", body: file });
  const text = await response.text();
  if (!response.ok) throw text || `upload failed (${response.status})`;
  return JSON.parse(text) as string;
}

/** Where a device downloads the exported deck. */
export function exportUrl(deckId: string): string {
  return `${remote?.base ?? ""}/export/${encodeURIComponent(deckId)}`;
}
