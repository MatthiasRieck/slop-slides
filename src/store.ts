import { listen } from "@tauri-apps/api/event";
import { ask } from "@tauri-apps/plugin-dialog";
import { create } from "zustand";

import {
  api,
  errorMessage,
  type AgentEvent,
  type AgentEventEnvelope,
  type Deck,
  type DeckChanged,
  type LintIssue,
} from "./lib/api";
import { inkBounds, SLIDE_SIZE, type Stroke } from "./lib/ink";

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
  /** The user drew on the slide before sending; absent in chats saved before sketches. */
  sketch?: Sketch | null;
  createdAt: number;
}

/** What the agent is told about a drawing on the current slide. */
export interface Sketch {
  /** Deck-relative path of the slide screenshot with the drawing; null if it failed. */
  image: string | null;
  /** The marked area in slide pixels. */
  bounds: { left: number; top: number; right: number; bottom: number };
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

export const MODELS = [
  { id: "", label: "Default" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
] as const;

export type StageView = "slides" | "code";

interface AppState {
  deck: Deck | null;
  /** Id of the selected slide. */
  selected: string | null;
  /** Bumped whenever the user picks a slide, so views can reveal it even if unchanged. */
  revealRev: number;
  /** Whether the stage shows the rendered slide or deck.html's source. */
  view: StageView;
  /** The HTML view holds edits that are not saved to deck.html yet. */
  codeDirty: boolean;
  /** Bumped when attached assets change, reloading every slide preview. */
  assetsRev: number;
  messages: ChatMessage[];
  running: boolean;
  model: string;
  presenting: boolean;
  claudePath: string | null | undefined;
  error: string | null;
  /** Lint result for the saved deck.html; null until the first check finishes. */
  lint: LintIssue[] | null;
  /** Text to put in the chat composer, with a counter so the same text can be sent twice. */
  composerFill: { text: string; rev: number } | null;
  /** Ink drawn on slides in the editor, by slide id; sent along with the next message. */
  sketches: Record<string, Stroke[]>;
  /** Slides being saved as images into `dir`, one at a time; null when not exporting. */
  imageExport: { dir: string; slides: string[] } | null;

  openDeck: (id: string) => Promise<void>;
  createDeck: (title: string) => Promise<void>;
  closeDeck: () => Promise<void>;
  setDeck: (deck: Deck) => void;
  select: (slide: string | null) => void;
  selectRelative: (delta: number) => void;
  setView: (view: StageView) => void;
  setCodeDirty: (dirty: boolean) => void;
  setModel: (model: string) => void;
  setPresenting: (presenting: boolean) => void;
  setError: (error: string | null) => void;
  refreshLint: () => Promise<void>;
  fillComposer: (text: string) => void;
  setSketches: (update: (all: Record<string, Stroke[]>) => Record<string, Stroke[]>) => void;
  clearSketch: (slide: string) => void;
  startImageExport: (dir: string) => void;
  endImageExport: () => void;
  send: (text: string, options: { includeSlide: boolean; attachments: string[] }) => Promise<void>;
  interrupt: () => void;
  resetChat: () => Promise<void>;
}

const newId = () => crypto.randomUUID();
let lintRun = 0;

export const useApp = create<AppState>((set, get) => ({
  deck: null,
  selected: null,
  revealRev: 0,
  view: localStorage.getItem("slopslide.view") === "code" ? "code" : "slides",
  codeDirty: false,
  assetsRev: 0,
  messages: [],
  running: false,
  model: localStorage.getItem("slopslide.model") ?? "",
  presenting: false,
  claudePath: undefined,
  error: null,
  lint: null,
  composerFill: null,
  sketches: {},
  imageExport: null,

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
    if (get().codeDirty && !(await confirmDiscardEdits())) return;
    await api.closeDeck();
    set({ codeDirty: false, deck: null, selected: null, messages: [], running: false, presenting: false, lint: null, composerFill: null, sketches: {}, imageExport: null });
  },

  setDeck: (deck) => {
    const { selected } = get();
    const stillThere = deck.slides.some((s) => s.id === selected);
    set({ deck, selected: stillThere ? selected : (deck.slides[0]?.id ?? null) });
  },

  select: (slide) => set((s) => ({ selected: slide, revealRev: s.revealRev + 1 })),

  selectRelative: (delta) => {
    const { deck, selected } = get();
    if (!deck || deck.slides.length === 0) return;
    const index = deck.slides.findIndex((s) => s.id === selected);
    const next = Math.min(deck.slides.length - 1, Math.max(0, index + delta));
    set((s) => ({ selected: deck.slides[next]?.id ?? null, revealRev: s.revealRev + 1 }));
  },

  setView: (view) => {
    localStorage.setItem("slopslide.view", view);
    set({ view });
  },

  setCodeDirty: (codeDirty) => set({ codeDirty }),

  setModel: (model) => {
    localStorage.setItem("slopslide.model", model);
    set({ model });
  },

  setPresenting: (presenting) => set({ presenting }),

  setError: (error) => set({ error }),

  refreshLint: async () => {
    const { deck } = get();
    if (!deck) return;
    const run = ++lintRun;
    try {
      const issues = await api.lintDeck(deck.id);
      // Ignore answers that a newer check (or another deck) has overtaken.
      if (run === lintRun && get().deck?.id === deck.id) set({ lint: Array.isArray(issues) ? issues : null });
    } catch {
      if (run === lintRun) set({ lint: null });
    }
  },

  fillComposer: (text) => set((s) => ({ composerFill: { text, rev: (s.composerFill?.rev ?? 0) + 1 } })),

  setSketches: (update) => set((s) => ({ sketches: update(s.sketches) })),

  clearSketch: (slide) =>
    set((s) => {
      const { [slide]: _, ...rest } = s.sketches;
      return { sketches: rest };
    }),

  startImageExport: (dir) => {
    const { deck } = get();
    if (deck && deck.slides.length > 0) set({ imageExport: { dir, slides: deck.slides.map((s) => s.id) } });
  },

  endImageExport: () => set({ imageExport: null }),

  send: async (text, { includeSlide, attachments }) => {
    const { deck, selected, running, model } = get();
    if (!deck || running) return;
    const slide = includeSlide ? selected : null;
    const strokes = slide ? (get().sketches[slide] ?? []) : [];
    const bounds = inkBounds(strokes);
    let user: UserMessage = {
      id: newId(),
      role: "user",
      text,
      slide,
      attachments,
      sketch: bounds ? { image: null, bounds } : null,
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
    if (slide && user.sketch) {
      // Screenshot the slide with the ink still on it, then put the ink away.
      const captured: UserMessage = { ...user, sketch: { ...user.sketch, image: await captureSlide(deck.id) } };
      user = captured;
      set((s) => ({ messages: s.messages.map((m) => (m.id === captured.id ? captured : m)) }));
      get().clearSketch(slide);
    }
    try {
      await api.sendMessage(deck.id, buildPrompt(deck, user), model || null);
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

async function confirmDiscardEdits(): Promise<boolean> {
  const message = "You have unsaved changes to deck.html. Discard them?";
  try {
    return await ask(message, { title: "Unsaved changes", kind: "warning", okLabel: "Discard" });
  } catch {
    return window.confirm(message);
  }
}

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
    lint: null,
    composerFill: null,
    sketches: {},
    imageExport: null,
  });
}

/** Marks the slide on the stage to screenshot when sending a sketch. */
export const SKETCH_TARGET_ATTR = "data-sketch-target";

/** Screenshot of the slide on the stage, ink included; null when it cannot be taken. */
async function captureSlide(deckId: string): Promise<string | null> {
  const target = document.querySelector(`[${SKETCH_TARGET_ATTR}]`);
  if (!target) return null;
  const { x, y, width, height } = target.getBoundingClientRect();
  try {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return await api.captureSketch(deckId, { x, y, width, height }, viewport);
  } catch (error) {
    // The marked area still tells the agent where to look.
    console.warn("slide screenshot failed:", errorMessage(error));
    return null;
  }
}

/** Chat instructions asking the agent to fix `issues` and verify with its lint tool. */
export function lintFixPrompt(issues: LintIssue[]): string {
  const lines = issues.map(
    (i) => `- line ${i.line} ${i.severity} [${i.rule}]${i.slide ? ` (slide \`${i.slide}\`)` : ""}: ${i.message}`,
  );
  return [
    "deck.html does not pass the HTML lint. Fix these issues without changing how the slides look:",
    "",
    ...lines,
    "",
    "Then run the lint_deck tool to verify, and repeat until it reports no issues.",
  ].join("\n");
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
  if (message.sketch) {
    const { image, bounds } = message.sketch;
    if (image) {
      context.push(`Sketch: ${image} (screenshot of the current slide with the user's marks drawn on top)`);
    }
    context.push(
      `Marked area: x ${bounds.left}–${bounds.right}, y ${bounds.top}–${bounds.bottom} of the ${SLIDE_SIZE.width}×${SLIDE_SIZE.height} slide`,
    );
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
  const status = await api.agentStatus().catch(() => null);
  useApp.setState({ claudePath: status?.claudePath ?? null });
  await listen<AgentEventEnvelope>("agent-event", ({ payload }) => {
    if (payload.deckId === useApp.getState().deck?.id) applyAgentEvent(payload.event);
  });
  await listen<DeckChanged>("deck-changed", ({ payload }) => {
    if (payload.deckId === useApp.getState().deck?.id) applyDeckChanged(payload.paths);
  });
}
