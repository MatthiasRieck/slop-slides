import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const ask = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
/** Handlers registered through `listen`, by event name. */
const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return () => {};
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...args: unknown[]) => ask(...args) }));

import type { AgentEvent, Deck } from "./lib/api";
import type { AssistantMessage, ChatMessage, UserMessage } from "./store";
import { DECK_HTML, deckFor } from "./test/fixtures";

async function freshStore() {
  return (await freshModule()).useApp;
}

async function freshModule() {
  vi.resetModules();
  return import("./store");
}

type Handler = (args: Record<string, unknown>) => unknown;

/** Answers `invoke(command, args)` from a table; unknown commands resolve to undefined. */
function backend(handlers: Record<string, Handler>) {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => handlers[command]?.(args ?? {}));
}

const calls = (command: string) =>
  invoke.mock.calls.filter(([c]) => c === command).map(([, args]) => args as Record<string, unknown>);

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  ask.mockReset();
  listeners.clear();
});

describe("slide selection", () => {
  it("select changes the slide and bumps revealRev, even for the same slide", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML) });
    const rev = useApp.getState().revealRev;
    useApp.getState().select("outro");
    expect(useApp.getState().selected).toBe("outro");
    expect(useApp.getState().revealRev).toBe(rev + 1);
    // Clicking the selected thumbnail again must still reveal it in the HTML view.
    useApp.getState().select("outro");
    expect(useApp.getState().revealRev).toBe(rev + 2);
  });

  it("selectRelative moves within bounds and bumps revealRev", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBe("#2");
    useApp.getState().selectRelative(5);
    expect(useApp.getState().selected).toBe("outro");
    useApp.getState().selectRelative(-10);
    expect(useApp.getState().selected).toBe("intro");
    expect(useApp.getState().revealRev).toBe(3);
  });

  it("selectRelative does nothing without slides", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: { ...deckFor(""), slides: [] }, selected: null });
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBeNull();
    expect(useApp.getState().revealRev).toBe(0);
  });

  it("setDeck keeps the selection when the slide survives, else picks the first", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "outro" });
    useApp.getState().setDeck(deckFor(DECK_HTML, "2"));
    expect(useApp.getState().selected).toBe("outro");
    useApp.getState().setDeck(deckFor(DECK_HTML.replace(` id="outro"`, ` id="end"`)));
    expect(useApp.getState().selected).toBe("intro");
  });
});

describe("stage view", () => {
  it("defaults to slides", async () => {
    const useApp = await freshStore();
    expect(useApp.getState().view).toBe("slides");
  });

  it("restores the last view from localStorage", async () => {
    localStorage.setItem("slopslide.view", "code");
    const useApp = await freshStore();
    expect(useApp.getState().view).toBe("code");
  });

  it("ignores unknown stored values", async () => {
    localStorage.setItem("slopslide.view", "bogus");
    const useApp = await freshStore();
    expect(useApp.getState().view).toBe("slides");
  });

  it("setView switches and persists", async () => {
    const useApp = await freshStore();
    useApp.getState().setView("code");
    expect(useApp.getState().view).toBe("code");
    expect(localStorage.getItem("slopslide.view")).toBe("code");
    useApp.getState().setView("slides");
    expect(localStorage.getItem("slopslide.view")).toBe("slides");
  });
});

describe("closing a deck with unsaved HTML edits", () => {
  it("closes immediately when there are no edits", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: false });
    await useApp.getState().closeDeck();
    expect(ask).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("close_deck");
    expect(useApp.getState().deck).toBeNull();
  });

  it("stays open when the user keeps their edits", async () => {
    const useApp = await freshStore();
    ask.mockResolvedValue(false);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    await useApp.getState().closeDeck();
    expect(ask).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith("close_deck");
    expect(useApp.getState().deck).not.toBeNull();
    expect(useApp.getState().codeDirty).toBe(true);
  });

  it("closes and clears the dirty flag when the user discards", async () => {
    const useApp = await freshStore();
    ask.mockResolvedValue(true);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    await useApp.getState().closeDeck();
    expect(invoke).toHaveBeenCalledWith("close_deck");
    expect(useApp.getState().deck).toBeNull();
    expect(useApp.getState().codeDirty).toBe(false);
  });

  it("falls back to window.confirm when the native dialog is unavailable", async () => {
    const useApp = await freshStore();
    ask.mockRejectedValue(new Error("no dialog plugin"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    await useApp.getState().closeDeck();
    expect(confirm).toHaveBeenCalledOnce();
    expect(useApp.getState().deck).not.toBeNull();
    confirm.mockRestore();
  });
});

const DECK = deckFor(DECK_HTML);

const userMessage = (text: string): UserMessage => ({
  id: `u-${text}`,
  role: "user",
  text,
  slide: null,
  attachments: [],
  createdAt: 1,
});

const assistantMessage = (patch: Partial<AssistantMessage> = {}): AssistantMessage => ({
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

describe("opening and creating decks", () => {
  it("openDeck loads the deck, its chat and whether the agent is running", async () => {
    const useApp = await freshStore();
    const chat: ChatMessage[] = [userMessage("hi"), assistantMessage()];
    backend({ open_deck: () => DECK, load_chat: () => chat, agent_running: () => true });
    useApp.setState({ assetsRev: 4, presenting: true, selected: "stale" });
    await useApp.getState().openDeck("talk");
    expect(calls("open_deck")).toEqual([{ id: "talk" }]);
    expect(calls("load_chat")).toEqual([{ id: "talk" }]);
    const state = useApp.getState();
    expect(state.deck).toEqual(DECK);
    expect(state.selected).toBe("intro");
    expect(state.messages).toEqual(chat);
    expect(state.running).toBe(true);
    expect(state.assetsRev).toBe(0);
    expect(state.presenting).toBe(false);
  });

  it("settles a transcript that was saved mid-turn", async () => {
    const useApp = await freshStore();
    const streaming = assistantMessage({ status: "streaming", thinking: true });
    backend({ open_deck: () => DECK, load_chat: () => [userMessage("hi"), streaming], agent_running: () => false });
    await useApp.getState().openDeck("talk");
    expect(useApp.getState().messages[1]).toEqual({ ...streaming, status: "interrupted", thinking: false });
  });

  it("starts with an empty transcript when the chat file is missing or not a list", async () => {
    const useApp = await freshStore();
    backend({ open_deck: () => DECK, load_chat: () => null, agent_running: () => false });
    useApp.setState({ messages: [userMessage("old deck")] });
    await useApp.getState().openDeck("talk");
    expect(useApp.getState().messages).toEqual([]);
    backend({ open_deck: () => DECK, load_chat: () => ({ bogus: true }), agent_running: () => false });
    await useApp.getState().openDeck("talk");
    expect(useApp.getState().messages).toEqual([]);
  });

  it("selects nothing in an empty deck", async () => {
    const useApp = await freshStore();
    backend({ open_deck: () => ({ ...DECK, slides: [] }), load_chat: () => null, agent_running: () => false });
    await useApp.getState().openDeck("talk");
    expect(useApp.getState().selected).toBeNull();
  });

  it("openDeck reports failures instead of throwing", async () => {
    const useApp = await freshStore();
    backend({
      open_deck: () => {
        throw "deck not found: talk";
      },
    });
    await useApp.getState().openDeck("talk");
    expect(useApp.getState().error).toBe("deck not found: talk");
    expect(useApp.getState().deck).toBeNull();
  });

  it("createDeck creates and opens the new deck", async () => {
    const useApp = await freshStore();
    backend({ create_deck: () => DECK, load_chat: () => null, agent_running: () => false });
    await useApp.getState().createDeck("Talk");
    expect(calls("create_deck")).toEqual([{ title: "Talk" }]);
    expect(useApp.getState().deck).toEqual(DECK);
  });

  it("createDeck reports failures", async () => {
    const useApp = await freshStore();
    backend({
      create_deck: () => {
        throw new Error("disk full");
      },
    });
    await useApp.getState().createDeck("Talk");
    expect(useApp.getState().error).toBe("disk full");
  });

  it("closeDeck resets the editor state", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro", messages: [userMessage("x")], running: true, presenting: true });
    await useApp.getState().closeDeck();
    expect(useApp.getState()).toMatchObject({ deck: null, selected: null, messages: [], running: false, presenting: false });
  });
});

describe("model choice", () => {
  it("defaults to the CLI's default model", async () => {
    const useApp = await freshStore();
    expect(useApp.getState().model).toBe("");
  });

  it("persists and restores the chosen model", async () => {
    let useApp = await freshStore();
    useApp.getState().setModel("opus");
    expect(useApp.getState().model).toBe("opus");
    useApp = await freshStore();
    expect(useApp.getState().model).toBe("opus");
  });
});

describe("sending a message", () => {
  const prompt = () => (calls("send_message")[0]!.args as { prompt: string }).prompt;

  it("does nothing without a deck or while the agent runs", async () => {
    const useApp = await freshStore();
    await useApp.getState().send("hi", { includeSlide: true, attachments: [] });
    useApp.setState({ deck: DECK, running: true });
    await useApp.getState().send("hi", { includeSlide: true, attachments: [] });
    expect(calls("send_message")).toEqual([]);
    expect(useApp.getState().messages).toEqual([]);
  });

  it("adds the user message and a streaming reply, and marks the agent running", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "outro" });
    await useApp.getState().send("Make it blue", { includeSlide: true, attachments: ["assets/a.png"] });
    const [user, reply] = useApp.getState().messages as [UserMessage, AssistantMessage];
    expect(user).toMatchObject({ role: "user", text: "Make it blue", slide: "outro", attachments: ["assets/a.png"] });
    expect(reply).toMatchObject({ role: "assistant", status: "streaming", thinking: true, parts: [] });
    expect(user.id).not.toBe(reply.id);
    expect(useApp.getState().running).toBe(true);
  });

  it("tells the agent which slide is selected", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "#2" });
    await useApp.getState().send("Make it blue", { includeSlide: true, attachments: [] });
    expect(prompt()).toBe(
      `[context]\nCurrent slide: <section id="#2"> in deck.html (slide 2 of 3)\n[/context]\n\nMake it blue`,
    );
  });

  it("sends the bare text when there is no context to add", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    await useApp.getState().send("Whole deck please", { includeSlide: false, attachments: [] });
    expect(prompt()).toBe("Whole deck please");
    expect(useApp.getState().messages[0]).toMatchObject({ slide: null });
  });

  it("mentions an empty deck and attached files", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: { ...DECK, slides: [] }, selected: null });
    await useApp.getState().send("Start", { includeSlide: true, attachments: ["assets/a.png", "assets/b.csv"] });
    expect(prompt()).toBe(
      "[context]\nThe deck has no slides yet.\nAttached files: assets/a.png, assets/b.csv\n[/context]\n\nStart",
    );
  });

  it("passes the model, or null for the default", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, model: "" });
    await useApp.getState().send("a", { includeSlide: false, attachments: [] });
    useApp.setState({ running: false, model: "haiku" });
    await useApp.getState().send("b", { includeSlide: false, attachments: [] });
    expect(calls("send_message").map((c) => (c.args as { model: unknown }).model)).toEqual([null, "haiku"]);
    expect(calls("send_message")[0]!.args).toMatchObject({ deckId: "talk" });
  });

  it("shows a failed send on the reply and saves the transcript", async () => {
    const useApp = await freshStore();
    backend({
      send_message: () => {
        throw "Claude Code was not found.";
      },
    });
    useApp.setState({ deck: DECK });
    await useApp.getState().send("hi", { includeSlide: false, attachments: [] });
    const reply = useApp.getState().messages[1] as AssistantMessage;
    expect(reply).toMatchObject({ status: "error", thinking: false, error: "Claude Code was not found." });
    expect(useApp.getState().running).toBe(false);
    expect(calls("save_chat")).toEqual([{ id: "talk", chat: useApp.getState().messages }]);
  });

  it("interrupt asks the backend to stop this deck's agent", async () => {
    const useApp = await freshStore();
    useApp.getState().interrupt();
    expect(calls("interrupt_agent")).toEqual([]);
    useApp.setState({ deck: DECK });
    useApp.getState().interrupt();
    expect(calls("interrupt_agent")).toEqual([{ id: "talk" }]);
  });

  it("resetChat clears the transcript", async () => {
    const useApp = await freshStore();
    await useApp.getState().resetChat();
    expect(calls("reset_chat")).toEqual([]);
    useApp.setState({ deck: DECK, messages: [userMessage("x")], running: true });
    await useApp.getState().resetChat();
    expect(calls("reset_chat")).toEqual([{ id: "talk" }]);
    expect(useApp.getState().messages).toEqual([]);
    expect(useApp.getState().running).toBe(false);
  });
});

describe("agent events", () => {
  async function bridged(messages: ChatMessage[] = [userMessage("hi"), assistantMessage({ status: "streaming", thinking: true })]) {
    const store = await freshModule();
    backend({ agent_status: () => ({ claudePath: "/bin/claude", libraryPath: "/lib" }) });
    await store.initEventBridge();
    store.useApp.setState({ deck: DECK, messages, running: true });
    const emit = (event: AgentEvent, deckId = "talk") => listeners.get("agent-event")!({ payload: { deckId, event } });
    const reply = () => store.useApp.getState().messages.findLast((m) => m.role === "assistant") as AssistantMessage;
    return { useApp: store.useApp, emit, reply };
  }

  it("initEventBridge records where Claude Code is, or null when it cannot tell", async () => {
    const { useApp } = await bridged();
    expect(useApp.getState().claudePath).toBe("/bin/claude");
    const store = await freshModule();
    backend({
      agent_status: () => {
        throw new Error("no");
      },
    });
    await store.initEventBridge();
    expect(store.useApp.getState().claudePath).toBeNull();
  });

  it("streams text into the last reply", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "started", sessionId: "s" });
    emit({ type: "textStart" });
    expect(reply()).toMatchObject({ thinking: false, parts: [{ kind: "text", text: "" }] });
    emit({ type: "textDelta", text: "Hel" });
    emit({ type: "textDelta", text: "lo" });
    expect(reply().parts).toEqual([{ kind: "text", text: "Hello" }]);
  });

  it("starts a text part when a delta arrives without textStart", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "toolUse", id: "t1", name: "Read", input: {} });
    emit({ type: "textDelta", text: "after tool" });
    expect(reply().parts.map((p) => p.kind)).toEqual(["tool", "text"]);
  });

  it("shows thinking again between blocks", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "textDelta", text: "x" });
    expect(reply().thinking).toBe(false);
    emit({ type: "thinking" });
    expect(reply().thinking).toBe(true);
  });

  it("tracks tool calls and drops empty text before them", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "textStart" });
    emit({ type: "textDelta", text: "  \n" });
    emit({ type: "toolUse", id: "t1", name: "Edit", input: { file_path: "/d/deck.html" } });
    emit({ type: "toolUse", id: "t2", name: "Read", input: {} });
    expect(reply().parts).toEqual([
      { kind: "tool", id: "t1", name: "Edit", input: { file_path: "/d/deck.html" }, status: "running" },
      { kind: "tool", id: "t2", name: "Read", input: {}, status: "running" },
    ]);
    emit({ type: "toolResult", id: "t2", isError: true });
    emit({ type: "toolResult", id: "t1", isError: false });
    expect(reply().parts.map((p) => p.kind === "tool" && p.status)).toEqual(["done", "error"]);
  });

  it("keeps text that has content when a tool starts", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "textDelta", text: "Editing now." });
    emit({ type: "toolUse", id: "t1", name: "Edit", input: {} });
    expect(reply().parts[0]).toEqual({ kind: "text", text: "Editing now." });
  });

  it("uses the result text when nothing was streamed", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "result", isError: false, text: "All done.", costUsd: 0.12, durationMs: 3400 });
    expect(reply()).toMatchObject({ parts: [{ kind: "text", text: "All done." }], costUsd: 0.12, durationMs: 3400, error: null });
  });

  it("does not repeat the result text after streamed text", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "textDelta", text: "All done." });
    emit({ type: "result", isError: false, text: "All done.", costUsd: null, durationMs: null });
    expect(reply().parts).toEqual([{ kind: "text", text: "All done." }]);
  });

  it("turns an error result into an error message", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "result", isError: true, text: "Credit balance too low", costUsd: null, durationMs: 10 });
    expect(reply()).toMatchObject({ error: "Credit balance too low", parts: [] });
    emit({ type: "result", isError: true, text: null, costUsd: null, durationMs: null });
    expect(reply().error).toBe("The agent reported an error.");
  });

  it("records backend errors", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "error", message: "Claude Code stopped unexpectedly: boom" });
    expect(reply().error).toBe("Claude Code stopped unexpectedly: boom");
  });

  it.each([
    [{ interrupted: false }, null, "done"],
    [{ interrupted: false }, "boom", "error"],
    [{ interrupted: true }, "boom", "interrupted"],
  ] as const)("finished %j with error %j settles as %s", async (finished, error, status) => {
    const { useApp, emit, reply } = await bridged();
    emit({ type: "toolUse", id: "t1", name: "Edit", input: {} });
    if (error) emit({ type: "error", message: error });
    emit({ type: "finished", ...finished });
    expect(reply()).toMatchObject({ status, thinking: false });
    expect(reply().parts[0]).toMatchObject({ status: "done" });
    expect(useApp.getState().running).toBe(false);
    expect(calls("save_chat")).toEqual([{ id: "talk", chat: useApp.getState().messages }]);
  });

  it("only updates the last reply", async () => {
    const first = assistantMessage({ id: "a-0", parts: [{ kind: "text", text: "old" }] });
    const { useApp, emit } = await bridged([first, userMessage("again"), assistantMessage({ id: "a-1", status: "streaming" })]);
    emit({ type: "textDelta", text: "new" });
    expect(useApp.getState().messages[0]).toEqual(first);
  });

  it("ignores events for other decks", async () => {
    const { useApp, emit } = await bridged();
    const before = useApp.getState().messages;
    emit({ type: "textDelta", text: "elsewhere" }, "other-deck");
    emit({ type: "finished", interrupted: false }, "other-deck");
    expect(useApp.getState().messages).toBe(before);
    expect(useApp.getState().running).toBe(true);
  });

  it("tolerates events with no reply to update", async () => {
    const { useApp, emit } = await bridged([]);
    emit({ type: "textDelta", text: "x" });
    emit({ type: "finished", interrupted: false });
    expect(useApp.getState().messages).toEqual([]);
    expect(useApp.getState().running).toBe(false);
  });
});

describe("deck file changes", () => {
  async function watching(next: () => Deck | Promise<Deck>) {
    vi.useFakeTimers();
    const store = await freshModule();
    backend({ agent_status: () => null, load_deck: () => next() });
    await store.initEventBridge();
    store.useApp.setState({ deck: DECK, selected: "intro", running: false, assetsRev: 0 });
    const changed = (paths: string[], deckId = "talk") => listeners.get("deck-changed")!({ payload: { deckId, paths } });
    return { useApp: store.useApp, changed };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads every preview when attached assets change", async () => {
    const { useApp, changed } = await watching(() => DECK);
    changed(["assets/photo.png"]);
    expect(useApp.getState().assetsRev).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls("load_deck")).toEqual([]);
  });

  it("reloads the deck once a burst of edits settles", async () => {
    const edited = deckFor(DECK_HTML, "2");
    const { useApp, changed } = await watching(() => edited);
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(100);
    changed(["deck.html", "assets/a.png"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls("load_deck")).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(calls("load_deck")).toEqual([{ id: "talk" }]);
    expect(useApp.getState().deck).toEqual(edited);
    expect(useApp.getState().assetsRev).toBe(1);
  });

  it("follows the agent to the slide it changed", async () => {
    const edited = { ...DECK, slides: DECK.slides.map((s) => (s.id === "outro" ? { ...s, hash: "new" } : s)) };
    const { useApp, changed } = await watching(() => edited);
    useApp.setState({ running: true });
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(120);
    expect(useApp.getState().selected).toBe("outro");
  });

  it("keeps the user's selection when they are editing themselves", async () => {
    const edited = { ...DECK, slides: DECK.slides.map((s) => (s.id === "outro" ? { ...s, hash: "new" } : s)) };
    const { useApp, changed } = await watching(() => edited);
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(120);
    expect(useApp.getState().selected).toBe("intro");
  });

  it("follows the agent to a newly added slide", async () => {
    const added = { ...DECK, slides: [...DECK.slides, { id: "fresh", hash: "f", hidden: false }] };
    const { useApp, changed } = await watching(() => added);
    useApp.setState({ running: true });
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(120);
    expect(useApp.getState().selected).toBe("fresh");
  });

  it("ignores a deck.html that cannot be read mid-write", async () => {
    const { useApp, changed } = await watching(() => {
      throw "stream did not contain valid UTF-8";
    });
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(120);
    expect(useApp.getState().deck).toEqual(DECK);
    expect(useApp.getState().error).toBeNull();
  });

  it("does nothing when the deck was closed meanwhile", async () => {
    const { useApp, changed } = await watching(() => DECK);
    changed(["deck.html"]);
    useApp.setState({ deck: null });
    await vi.advanceTimersByTimeAsync(120);
    expect(calls("load_deck")).toEqual([]);
  });

  it("ignores other decks and unrelated files", async () => {
    const { useApp, changed } = await watching(() => DECK);
    changed(["deck.html", "assets/a.png"], "other-deck");
    changed(["notes.md"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls("load_deck")).toEqual([]);
    expect(useApp.getState().assetsRev).toBe(0);
  });
});

describe("lint", () => {
  const issue = (patch: Record<string, unknown> = {}) => ({
    rule: "unclosed-tag",
    severity: "error",
    message: "<div> is never closed.",
    line: 12,
    slide: "intro",
    ...patch,
  });

  it("refreshLint stores the backend's issues", async () => {
    const useApp = await freshStore();
    backend({ lint_deck: () => [issue()] });
    useApp.setState({ deck: deckFor(DECK_HTML) });
    await useApp.getState().refreshLint();
    expect(calls("lint_deck")).toEqual([{ id: "talk" }]);
    expect(useApp.getState().lint).toEqual([issue()]);
  });

  it("does nothing without a deck", async () => {
    const useApp = await freshStore();
    await useApp.getState().refreshLint();
    expect(calls("lint_deck")).toEqual([]);
    expect(useApp.getState().lint).toBeNull();
  });

  it("keeps only the newest of overlapping checks", async () => {
    const useApp = await freshStore();
    const answers: ((issues: unknown) => void)[] = [];
    invoke.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
    useApp.setState({ deck: deckFor(DECK_HTML) });
    const first = useApp.getState().refreshLint();
    const second = useApp.getState().refreshLint();
    answers[1]!([]);
    await second;
    answers[0]!([issue()]);
    await first;
    expect(useApp.getState().lint).toEqual([]);
  });

  it("drops results for a deck that is no longer open", async () => {
    const useApp = await freshStore();
    let answer: (issues: unknown) => void = () => {};
    invoke.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    useApp.setState({ deck: deckFor(DECK_HTML) });
    const pending = useApp.getState().refreshLint();
    useApp.setState({ deck: { ...deckFor(DECK_HTML), id: "other" } });
    answer([issue()]);
    await pending;
    expect(useApp.getState().lint).toBeNull();
  });

  it("clears the status when linting fails", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), lint: [] });
    backend({
      lint_deck: () => {
        throw new Error("deck not found: talk");
      },
    });
    await useApp.getState().refreshLint();
    expect(useApp.getState().lint).toBeNull();
  });

  it("resets lint and composer text when the deck closes", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), lint: [], composerFill: { text: "x", rev: 1 } });
    await useApp.getState().closeDeck();
    expect(useApp.getState().lint).toBeNull();
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("fillComposer bumps its revision even for identical text", async () => {
    const useApp = await freshStore();
    useApp.getState().fillComposer("fix it");
    useApp.getState().fillComposer("fix it");
    expect(useApp.getState().composerFill).toEqual({ text: "fix it", rev: 2 });
  });

  it("lintFixPrompt lists every issue and asks the agent to verify with its tool", async () => {
    const { lintFixPrompt } = await freshModule();
    const prompt = lintFixPrompt([
      issue() as never,
      issue({ severity: "warning", rule: "title", message: "Needs a title.", line: 1, slide: null }) as never,
    ]);
    expect(prompt).toContain("- line 12 error [unclosed-tag] (slide `intro`): <div> is never closed.");
    expect(prompt).toContain("- line 1 warning [title]: Needs a title.");
    expect(prompt).toMatch(/run the lint_deck tool to verify/);
  });
});
