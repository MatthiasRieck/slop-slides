// What the store's tests share: a fresh store for each test, a scripted backend, and the deck
// and chat they start from. Each test file calls `beforeEach(resetBackend)`.
import { vi } from "vitest";

import type { AgentEvent, HistoryEntry } from "../lib/api";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask, backend, calls, type Handler, invoke, listen } from "../test/tauri";
import type { AssistantMessage, UserMessage } from "./messages";

/** Handlers registered through `listen`, by event name. */
export const listeners = new Map<string, (event: { payload: unknown }) => void>();
listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
  listeners.set(name, handler);
  return () => {};
});

/** Forgets the backend's answers and calls, and the listeners, of the test before. */
export function resetBackend() {
  invoke.mockReset().mockResolvedValue(undefined);
  ask.mockReset();
  listeners.clear();
}

/** A store module loaded afresh, its module state with it; by default with the workspace `/decks/talk` open. */
export async function freshModule(withWorkspace = true) {
  vi.resetModules();
  const module = await import("../store");
  if (withWorkspace) module.useApp.setState({ workspace: { path: "/decks/talk", name: "talk" } });
  return module;
}

export async function freshStore(withWorkspace = true) {
  return (await freshModule(withWorkspace)).useApp;
}

export type TestStore = Awaited<ReturnType<typeof freshStore>>;

// The scripted backend, kept with the Tauri mocks; here too for the store's tests.
export { backend, calls, type Handler };

/** The prompts sent to the agent, in order. */
export const prompts = () => calls("send_message").map((c) => (c.args as { prompt: string }).prompt);

/** A fresh store with the event bridge up (the backend answering `handlers`), and `emit` to send it agent events. */
export async function withBridge(handlers: Record<string, Handler> = {}) {
  const module = await freshModule();
  backend({ list_providers: () => [], ...handlers });
  await module.initEventBridge();
  const emit = (event: AgentEvent, workspace = "/decks/talk") =>
    listeners.get("agent-event")!({ payload: { workspace, event } });
  return { useApp: module.useApp, emit };
}

/** The deck in `/decks/talk/deck.html`, with the slides `intro`, `#2` and `outro`. */
export const DECK = deckFor(DECK_HTML);

export const userMessage = (text: string): UserMessage => ({
  id: `u-${text}`,
  role: "user",
  text,
  slide: null,
  attachments: [],
  createdAt: 1,
});

export const assistantMessage = (patch: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: "a-1",
  role: "assistant",
  parts: [],
  status: "done",
  thinking: false,
  error: null,
  costUsd: null,
  durationMs: null,
  createdAt: 2,
  ...patch,
});

/** An entry of the deck's history, named and identified by `label`. */
export const historyEntry = (
  label: string,
  source: HistoryEntry["source"] = "edit",
  message?: string,
): HistoryEntry => ({
  id: label,
  source,
  label,
  time: 0,
  ...(message && { message }),
});

/** What the deck's history says undo and redo would do. */
export const historyStatus = (undo: HistoryEntry | null = null, redo: HistoryEntry | null = null) => ({
  undo,
  redo,
  current: "v",
});
