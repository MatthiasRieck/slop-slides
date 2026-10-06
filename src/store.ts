import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  api,
  errorMessage,
  type AgentEvent,
  type AgentEventEnvelope,
  type Deck,
  type DeckChanged,
} from "./lib/api";
import {
  defaultModel,
  pickEffort,
  type Provider,
  type ProviderInfo,
} from "./lib/models";

export type ChatPart =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: "running" | "done" | "error";
    };

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  slide: string | null;
  attachments: string[];
  createdAt: number;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  parts: ChatPart[];
  status: "streaming" | "done" | "interrupted" | "error";
  thinking: boolean;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: number;
}

export type ChatMessage = UserMessage | AssistantMessage;

export interface ModelSelection {
  provider: Provider;
  model: string;
  /** Shown until the provider list arrives. */
  label: string;
  effort: string;
}

const SELECTION_KEY = "slopslide.selection";
const FAVORITES_KEY = "slopslide.favoriteModels";

const DEFAULT_SELECTION: ModelSelection = {
  provider: "claude",
  model: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  effort: "medium",
};

function loadSelection(): ModelSelection {
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "null") as Partial<ModelSelection> | null;
    if (saved?.provider && saved.model && saved.label && saved.effort) return saved as ModelSelection;
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_SELECTION;
}

function saveSelection(selection: ModelSelection) {
  localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
  useApp.setState({ selection });
}

/** Moves a selection that is no longer offered onto an installed provider's default model. */
function reconcileSelection(selection: ModelSelection, providers: ProviderInfo[]): ModelSelection {
  const current = providers.find((p) => p.id === selection.provider);
  const model = current?.models.find((m) => m.id === selection.model);
  if (model) return { ...selection, label: model.label, effort: pickEffort(model, selection.effort) };
  // A provider whose models could not be listed keeps the saved choice rather than losing it.
  if (current?.installed && current.error) return selection;
  const fallback = [current, ...providers].find((p) => p?.installed && p.models.length > 0);
  const next = fallback && defaultModel(fallback);
  if (!fallback || !next) return selection;
  return {
    provider: fallback.id,
    model: next.id,
    label: next.label,
    effort: pickEffort(next, selection.effort),
  };
}

function loadFavorites(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]");
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

interface AppState {
  deck: Deck | null;
  /** Id of the selected slide. */
  selected: string | null;
  /** Bumped when attached assets change, reloading every slide preview. */
  assetsRev: number;
  messages: ChatMessage[];
  running: boolean;
  selection: ModelSelection;
  /** `provider:model` keys starred in the model picker. */
  favoriteModels: string[];
  presenting: boolean;
  /** Installed agent CLIs and their models; `undefined` while loading. */
  providers: ProviderInfo[] | undefined;
  error: string | null;

  openDeck: (id: string) => Promise<void>;
  createDeck: (title: string) => Promise<void>;
  closeDeck: () => Promise<void>;
  setDeck: (deck: Deck) => void;
  select: (slide: string | null) => void;
  selectRelative: (delta: number) => void;
  setModel: (provider: Provider, model: string) => void;
  setEffort: (effort: string) => void;
  refreshProviders: () => Promise<void>;
  toggleFavoriteModel: (key: string) => void;
  setPresenting: (presenting: boolean) => void;
  setError: (error: string | null) => void;
  send: (text: string, options: { includeSlide: boolean; attachments: string[] }) => Promise<void>;
  interrupt: () => void;
  resetChat: () => Promise<void>;
}

const newId = () => crypto.randomUUID();

export const useApp = create<AppState>((set, get) => ({
  deck: null,
  selected: null,
  assetsRev: 0,
  messages: [],
  running: false,
  selection: loadSelection(),
  favoriteModels: loadFavorites(),
  presenting: false,
  providers: undefined,
  error: null,

  openDeck: async (id) => {
    try {
      const deck = await api.openDeck(id);
      await loadDeckState(deck);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  createDeck: async (title) => {
    try {
      const deck = await api.createDeck(title);
      await loadDeckState(deck);
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  closeDeck: async () => {
    await api.closeDeck();
    set({ deck: null, selected: null, messages: [], running: false, presenting: false });
  },

  setDeck: (deck) => {
    const { selected } = get();
    const stillThere = deck.slides.some((s) => s.id === selected);
    set({ deck, selected: stillThere ? selected : (deck.slides[0]?.id ?? null) });
  },

  select: (slide) => set({ selected: slide }),

  selectRelative: (delta) => {
    const { deck, selected } = get();
    if (!deck || deck.slides.length === 0) return;
    const index = deck.slides.findIndex((s) => s.id === selected);
    const next = Math.min(deck.slides.length - 1, Math.max(0, index + delta));
    set({ selected: deck.slides[next]?.id ?? null });
  },

  setModel: (provider, id) => {
    const model = get()
      .providers?.find((p) => p.id === provider)
      ?.models.find((m) => m.id === id);
    if (!model) return;
    const effort = pickEffort(model, get().selection.effort);
    saveSelection({ provider, model: id, label: model.label, effort });
  },

  setEffort: (effort) => saveSelection({ ...get().selection, effort }),

  refreshProviders: async () => {
    set({ providers: undefined });
    const providers = await api.listProviders().catch(() => []);
    set({ providers });
    if (providers.length > 0) saveSelection(reconcileSelection(get().selection, providers));
  },

  toggleFavoriteModel: (key) => {
    const { favoriteModels } = get();
    const next = favoriteModels.includes(key)
      ? favoriteModels.filter((k) => k !== key)
      : [...favoriteModels, key];
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    set({ favoriteModels: next });
  },

  setPresenting: (presenting) => set({ presenting }),

  setError: (error) => set({ error }),

  send: async (text, { includeSlide, attachments }) => {
    const { deck, selected, running, selection } = get();
    if (!deck || running) return;
    const slide = includeSlide ? selected : null;
    const user: UserMessage = {
      id: newId(),
      role: "user",
      text,
      slide,
      attachments,
      createdAt: Date.now(),
    };
    const assistant: AssistantMessage = {
      id: newId(),
      role: "assistant",
      parts: [],
      status: "streaming",
      thinking: true,
      error: null,
      costUsd: null,
      durationMs: null,
      createdAt: Date.now(),
    };
    set((s) => ({ messages: [...s.messages, user, assistant], running: true }));
    try {
      const { provider, model, effort } = selection;
      await api.sendMessage(deck.id, buildPrompt(deck, user), { provider, model, effort });
    } catch (error) {
      updateAssistant(assistant.id, (m) => ({
        ...m,
        status: "error",
        thinking: false,
        error: errorMessage(error),
      }));
      set({ running: false });
      persistChat();
    }
  },

  interrupt: () => {
    const { deck } = get();
    if (deck) void api.interruptAgent(deck.id);
  },

  resetChat: async () => {
    const { deck } = get();
    if (!deck) return;
    await api.resetChat(deck.id);
    set({ messages: [], running: false });
  },
}));

async function loadDeckState(deck: Deck) {
  const [chat, running] = await Promise.all([api.loadChat(deck.id), api.agentRunning(deck.id)]);
  const messages = Array.isArray(chat) ? (chat as ChatMessage[]) : [];
  useApp.setState({
    deck,
    selected: deck.slides[0]?.id ?? null,
    assetsRev: 0,
    messages: messages.map(settleInterrupted),
    running,
    presenting: false,
  });
}

/** A transcript saved mid-turn (app quit) cannot resume streaming. */
function settleInterrupted(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || message.status !== "streaming") return message;
  return { ...message, status: "interrupted", thinking: false };
}

function buildPrompt(deck: Deck, message: UserMessage): string {
  const context: string[] = [];
  if (message.slide) {
    const index = deck.slides.findIndex((s) => s.id === message.slide);
    context.push(
      `Current slide: <section id="${message.slide}"> in deck.html (slide ${index + 1} of ${deck.slides.length})`,
    );
  } else if (deck.slides.length === 0) {
    context.push("The deck has no slides yet.");
  }
  if (message.attachments.length > 0) {
    context.push(`Attached files: ${message.attachments.join(", ")}`);
  }
  if (context.length === 0) return message.text;
  return `[context]\n${context.join("\n")}\n[/context]\n\n${message.text}`;
}

function updateAssistant(id: string, update: (m: AssistantMessage) => AssistantMessage) {
  useApp.setState((s) => ({
    messages: s.messages.map((m) => (m.id === id && m.role === "assistant" ? update(m) : m)),
  }));
}

function updateLastAssistant(update: (m: AssistantMessage) => AssistantMessage) {
  const last = useApp.getState().messages.findLast((m) => m.role === "assistant");
  if (last) updateAssistant(last.id, update);
}

function persistChat() {
  const { deck, messages } = useApp.getState();
  if (deck) void api.saveChat(deck.id, messages);
}

function applyAgentEvent(event: AgentEvent) {
  switch (event.type) {
    case "started":
      return;
    case "thinking":
      return updateLastAssistant((m) => ({ ...m, thinking: true }));
    case "textStart":
      return updateLastAssistant((m) => ({
        ...m,
        thinking: false,
        parts: [...m.parts, { kind: "text", text: "" }],
      }));
    case "textDelta":
      return updateLastAssistant((m) => {
        const parts = [...m.parts];
        const last = parts.at(-1);
        if (last?.kind === "text") parts[parts.length - 1] = { ...last, text: last.text + event.text };
        else parts.push({ kind: "text", text: event.text });
        return { ...m, thinking: false, parts };
      });
    case "toolUse":
      return updateLastAssistant((m) => ({
        ...m,
        thinking: false,
        parts: [
          ...m.parts.filter((p) => p.kind !== "text" || p.text.trim() !== ""),
          { kind: "tool", id: event.id, name: event.name, input: event.input, status: "running" },
        ],
      }));
    case "toolResult":
      return updateLastAssistant((m) => ({
        ...m,
        parts: m.parts.map((p) =>
          p.kind === "tool" && p.id === event.id
            ? { ...p, status: event.isError ? "error" : "done" }
            : p,
        ),
      }));
    case "result":
      return updateLastAssistant((m) => {
        const hasText = m.parts.some((p) => p.kind === "text" && p.text.trim() !== "");
        const parts: ChatPart[] =
          !hasText && !event.isError && event.text
            ? [...m.parts, { kind: "text", text: event.text }]
            : m.parts;
        return {
          ...m,
          parts,
          costUsd: event.costUsd,
          durationMs: event.durationMs,
          error: event.isError ? (event.text ?? "The agent reported an error.") : m.error,
        };
      });
    case "error":
      return updateLastAssistant((m) => ({ ...m, error: event.message }));
    case "finished":
      updateLastAssistant((m) => ({
        ...m,
        thinking: false,
        status: event.interrupted ? "interrupted" : m.error ? "error" : "done",
        parts: m.parts.map((p) =>
          p.kind === "tool" && p.status === "running" ? { ...p, status: "done" } : p,
        ),
      }));
      useApp.setState({ running: false });
      persistChat();
      return;
  }
}

let reloadTimer: ReturnType<typeof setTimeout> | undefined;

function applyDeckChanged(paths: string[]) {
  if (paths.some((p) => p.startsWith("assets/"))) {
    useApp.setState((s) => ({ assetsRev: s.assetsRev + 1 }));
  }
  if (!paths.includes("deck.html")) return;
  // Edits arrive in bursts while the agent works; reload once they settle.
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    const { deck } = useApp.getState();
    if (!deck) return;
    try {
      const next = await api.loadDeck(deck.id);
      const before = new Map(deck.slides.map((s) => [s.id, s.hash]));
      const changed = next.slides.find((s) => before.get(s.id) !== s.hash);
      useApp.getState().setDeck(next);
      // Follow the agent to the slide it is working on.
      if (changed && useApp.getState().running) useApp.setState({ selected: changed.id });
    } catch {
      // deck.html is mid-write; the next change event retries.
    }
  }, 120);
}

export async function initEventBridge() {
  // Listing Codex models starts its app server; don't hold up the rest of the bridge.
  void useApp.getState().refreshProviders();
  await listen<AgentEventEnvelope>("agent-event", ({ payload }) => {
    if (payload.deckId === useApp.getState().deck?.id) applyAgentEvent(payload.event);
  });
  await listen<DeckChanged>("deck-changed", ({ payload }) => {
    if (payload.deckId === useApp.getState().deck?.id) applyDeckChanged(payload.paths);
  });
}
