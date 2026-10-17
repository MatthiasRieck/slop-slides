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
import type { ProviderInfo } from "./lib/models";
import type { AssistantMessage, ChatMessage, UserMessage } from "./store";
import { DECK_HTML, deckFor } from "./test/fixtures";

async function freshStore(withWorkspace = true) {
  return (await freshModule(withWorkspace)).useApp;
}

async function freshModule(withWorkspace = true) {
  vi.resetModules();
  const module = await import("./store");
  if (withWorkspace) module.useApp.setState({ workspace: { path: "/decks/talk", name: "talk" } });
  return module;
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

describe("sidebar", () => {
  it("is open by default", async () => {
    const useApp = await freshStore();
    expect(useApp.getState().sidebarOpen).toBe(true);
  });

  it("restores a collapsed sidebar from localStorage", async () => {
    localStorage.setItem("slopslide.sidebarOpen", "false");
    const useApp = await freshStore();
    expect(useApp.getState().sidebarOpen).toBe(false);
  });

  it("setSidebarOpen switches and persists", async () => {
    const useApp = await freshStore();
    useApp.getState().setSidebarOpen(false);
    expect(useApp.getState().sidebarOpen).toBe(false);
    expect(localStorage.getItem("slopslide.sidebarOpen")).toBe("false");
    useApp.getState().setSidebarOpen(true);
    expect(useApp.getState().sidebarOpen).toBe(true);
    expect(localStorage.getItem("slopslide.sidebarOpen")).toBe("true");
  });

  it("shows the chat tab first, and opens on the tab picked", async () => {
    localStorage.clear();
    let useApp = await freshStore();
    expect(useApp.getState().sidebarTab).toBe("chat");
    useApp.getState().setSidebarOpen(false);
    useApp.getState().setSidebarTab("files");
    expect(useApp.getState()).toMatchObject({ sidebarTab: "files", sidebarOpen: true });
    useApp = await freshStore();
    expect(useApp.getState().sidebarTab).toBe("files");
    localStorage.setItem("slopslide.sidebarTab", "bogus");
    useApp = await freshStore();
    expect(useApp.getState().sidebarTab).toBe("chat");
  });
});

describe("workspaces", () => {
  const WS = { path: "/ws", name: "ws" };
  const TALK = { ...deckFor(DECK_HTML), id: "/ws/talks/q3.html", path: "/ws/talks/q3.html" };
  const opened = (path: string, kind: string) => ({ path, absolute: `/ws/${path}`, kind });

  beforeEach(() => localStorage.clear());

  function workspaceBackend(extra: Record<string, Handler> = {}) {
    backend({
      open_workspace: ({ path }) => ({ path, name: String(path).split("/").pop() }),
      open_deck: () => TALK,
      create_deck: () => ({ ...TALK, id: "/ws/new-deck/deck.html", path: "/ws/new-deck/deck.html" }),
      open_file: ({ path }) => {
        const kinds: Record<string, string> = { "talks/q3.html": "deck", "site/index.html": "webpage", "notes.md": "file" };
        if (!kinds[String(path)]) throw `file not found: ${String(path)}`;
        return opened(String(path), kinds[String(path)]!);
      },
      load_chat: () => null,
      agent_running: () => false,
      ...extra,
    });
  }

  it("opens a folder on the files tab when nothing was open in it before", async () => {
    const useApp = await freshStore(false);
    workspaceBackend();
    useApp.setState({ sidebarTab: "chat" });
    await useApp.getState().openWorkspace("/ws");
    expect(useApp.getState().workspace).toEqual(WS);
    expect(useApp.getState().openedFile).toBeNull();
    expect(useApp.getState().sidebarTab).toBe("files");
  });

  it("opens a deck in the editor and other pages as they are", async () => {
    const useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openWorkspace("/ws");
    await useApp.getState().openPath("talks/q3.html");
    expect(calls("open_deck")).toEqual([{ id: "/ws/talks/q3.html" }]);
    expect(useApp.getState().deck).toEqual(TALK);
    expect(useApp.getState().openedFile).toEqual({ path: "talks/q3.html", absolute: "/ws/talks/q3.html", kind: "deck" });

    await useApp.getState().openPath("site/index.html");
    expect(useApp.getState().deck).toBeNull();
    expect(useApp.getState().openedFile).toEqual(opened("site/index.html", "webpage"));
    expect(calls("open_deck")).toHaveLength(1);

    await useApp.getState().openPath("site/index.html");
    expect(calls("open_file")).toHaveLength(2);
  });

  it("reports a file that cannot be opened and keeps the open one", async () => {
    const useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openWorkspace("/ws");
    await useApp.getState().openPath("notes.md");
    await useApp.getState().openPath("gone.html");
    expect(useApp.getState().error).toBe("file not found: gone.html");
    expect(useApp.getState().openedFile).toEqual(opened("notes.md", "file"));
  });

  it("keeps the deck open when the user keeps unsaved HTML edits", async () => {
    const useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openWorkspace("/ws");
    await useApp.getState().openPath("talks/q3.html");
    useApp.setState({ codeDirty: true });
    ask.mockResolvedValue(false);
    await useApp.getState().openPath("site/index.html");
    expect(useApp.getState().deck).toEqual(TALK);
    expect(await useApp.getState().closeWorkspace()).toBe(false);
    expect(useApp.getState().workspace).toEqual(WS);
    expect(calls("close_workspace")).toEqual([]);
  });

  it("reopens the file last open in a folder", async () => {
    let useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openWorkspace("/ws");
    await useApp.getState().openPath("site/index.html");
    expect(await useApp.getState().closeWorkspace()).toBe(true);
    expect(calls("close_workspace")).toHaveLength(1);
    expect(useApp.getState()).toMatchObject({ workspace: null, openedFile: null, deck: null });

    useApp = await freshStore(false);
    await useApp.getState().openWorkspace("/ws");
    expect(useApp.getState().openedFile).toEqual(opened("site/index.html", "webpage"));
    await useApp.getState().openPath("talks/q3.html");

    useApp = await freshStore(false);
    await useApp.getState().openWorkspace("/ws");
    expect(useApp.getState().deck).toEqual(TALK);
  });

  it("forgets a last file that is gone", async () => {
    localStorage.setItem("slopslide.lastFile:/ws", "gone.html");
    const useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openWorkspace("/ws");
    expect(useApp.getState().openedFile).toBeNull();
    expect(useApp.getState().error).toBeNull();
    expect(localStorage.getItem("slopslide.lastFile:/ws")).toBeNull();
  });

  it("switches folders, closing the open one first", async () => {
    const useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openWorkspace("/ws");
    await useApp.getState().openPath("talks/q3.html");
    await useApp.getState().openWorkspace("/other");
    expect(calls("close_workspace")).toHaveLength(1);
    expect(useApp.getState()).toMatchObject({ workspace: { path: "/other", name: "other" }, deck: null, openedFile: null });
    await useApp.getState().openWorkspace("/other");
    expect(calls("open_workspace")).toHaveLength(2);
  });

  it("reports a folder that cannot be opened", async () => {
    const useApp = await freshStore(false);
    backend({ open_workspace: () => Promise.reject("not a folder: /nope") });
    await useApp.getState().openWorkspace("/nope");
    expect(useApp.getState().workspace).toBeNull();
    expect(useApp.getState().error).toBe("not a folder: /nope");
  });

  it("creates decks in the open folder and opens them", async () => {
    const useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openWorkspace("/ws");
    await useApp.getState().createDeck("New deck");
    expect(calls("create_deck")).toEqual([{ title: "New deck", template: null }]);
    expect(useApp.getState().openedFile).toEqual({ path: "new-deck/deck.html", absolute: "/ws/new-deck/deck.html", kind: "deck" });
    expect(localStorage.getItem("slopslide.lastFile:/ws")).toBe("new-deck/deck.html");
  });

  it("names paths relative to the workspace folder", async () => {
    const { relativePath } = await freshModule(false);
    expect(relativePath(WS, "/ws/talks/q3.html")).toBe("talks/q3.html");
    expect(relativePath({ path: "/ws/", name: "ws" }, "/ws/a.html")).toBe("a.html");
    expect(relativePath({ path: "C:\\ws", name: "ws" }, "C:\\ws\\talks\\q3.html")).toBe("talks/q3.html");
    expect(relativePath(WS, "/wsx/a.html")).toBeNull();
    expect(relativePath(null, "/ws/a.html")).toBeNull();
  });
});

describe("slide rail", () => {
  it("is open by default", async () => {
    const useApp = await freshStore();
    expect(useApp.getState().railOpen).toBe(true);
  });

  it("restores a collapsed rail from localStorage", async () => {
    localStorage.setItem("slopslide.railOpen", "false");
    const useApp = await freshStore();
    expect(useApp.getState().railOpen).toBe(false);
  });

  it("setRailOpen switches and persists", async () => {
    const useApp = await freshStore();
    useApp.getState().setRailOpen(false);
    expect(useApp.getState().railOpen).toBe(false);
    expect(localStorage.getItem("slopslide.railOpen")).toBe("false");
    useApp.getState().setRailOpen(true);
    expect(useApp.getState().railOpen).toBe(true);
    expect(localStorage.getItem("slopslide.railOpen")).toBe("true");
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
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: false, sketches: { intro: [{ tool: "pen", color: "#fff", points: [[0, 0]] }] } });
    useApp.setState({ openedFile: { path: "talk/deck.html", absolute: DECK_HTML_PATH, kind: "deck" } });
    expect(await useApp.getState().closeDeck()).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(useApp.getState().deck).toBeNull();
    expect(useApp.getState().openedFile).toBeNull();
    expect(useApp.getState().sketches).toEqual({});
  });

  it("stays open when the user keeps their edits", async () => {
    const useApp = await freshStore();
    ask.mockResolvedValue(false);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    expect(await useApp.getState().closeDeck()).toBe(false);
    expect(ask).toHaveBeenCalledOnce();
    expect(useApp.getState().deck).not.toBeNull();
    expect(useApp.getState().codeDirty).toBe(true);
  });

  it("closes and clears the dirty flag when the user discards", async () => {
    const useApp = await freshStore();
    ask.mockResolvedValue(true);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    expect(await useApp.getState().closeDeck()).toBe(true);
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
const DECK_HTML_PATH = DECK.id;

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
    const useApp = await freshStore(false);
    const chat: ChatMessage[] = [userMessage("hi"), assistantMessage()];
    backend({ open_workspace: () => ({ path: "/decks/talk", name: "talk" }), open_deck: () => DECK, load_chat: () => chat, agent_running: () => true });
    useApp.setState({ assetsRev: 4, presenting: true, selected: "stale", sketches: { intro: [{ tool: "pen", color: "#fff", points: [[0, 0]] }] } });
    await useApp.getState().openWorkspace("/decks/talk");
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(calls("open_deck")).toEqual([{ id: "/decks/talk/deck.html" }]);
    expect(calls("load_chat")).toEqual([{ id: "/decks/talk" }]);
    const state = useApp.getState();
    expect(state.deck).toEqual(DECK);
    expect(state.selected).toBe("intro");
    expect(state.messages).toEqual(chat);
    expect(state.running).toBe(true);
    expect(state.assetsRev).toBe(0);
    expect(state.presenting).toBe(false);
    expect(state.sketches).toEqual({});
  });

  it("settles a transcript that was saved mid-turn", async () => {
    const useApp = await freshStore(false);
    const streaming = assistantMessage({ status: "streaming", thinking: true, compacting: true });
    backend({ open_workspace: () => ({ path: "/decks/talk", name: "talk" }), open_deck: () => DECK, load_chat: () => [userMessage("hi"), streaming], agent_running: () => false });
    await useApp.getState().openWorkspace("/decks/talk");
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(useApp.getState().messages[1]).toEqual({ ...streaming, status: "interrupted", thinking: false, compacting: false });
  });

  it("starts with an empty transcript when the chat file is missing or not a list", async () => {
    const useApp = await freshStore(false);
    backend({ open_workspace: () => ({ path: "/decks/talk", name: "talk" }), open_deck: () => DECK, load_chat: () => null, agent_running: () => false });
    useApp.setState({ messages: [userMessage("old deck")] });
    await useApp.getState().openWorkspace("/decks/talk");
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(useApp.getState().messages).toEqual([]);
    await useApp.getState().closeWorkspace();
    backend({ open_workspace: () => ({ path: "/decks/talk", name: "talk" }), open_deck: () => DECK, load_chat: () => ({ bogus: true }), agent_running: () => false });
    await useApp.getState().openWorkspace("/decks/talk");
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(useApp.getState().messages).toEqual([]);
  });

  it("selects nothing in an empty deck", async () => {
    const useApp = await freshStore();
    backend({ open_deck: () => ({ ...DECK, slides: [] }), load_chat: () => null, agent_running: () => false });
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(useApp.getState().selected).toBeNull();
  });

  it("openDeck reports failures instead of throwing", async () => {
    const useApp = await freshStore();
    backend({
      open_deck: () => {
        throw "deck not found: talk";
      },
    });
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(useApp.getState().error).toBe("deck not found: talk");
    expect(useApp.getState().deck).toBeNull();
  });

  it("createDeck creates and opens the new deck", async () => {
    const useApp = await freshStore();
    backend({ create_deck: () => DECK, load_chat: () => null, agent_running: () => false });
    await useApp.getState().createDeck("Talk");
    expect(calls("create_deck")).toEqual([{ title: "Talk", template: null }]);
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
    expect(useApp.getState()).toMatchObject({ deck: null, selected: null, messages: [userMessage("x")], running: true, presenting: false });
  });
});

describe("slide image export", () => {
  it("remembers the folder and which slides to save", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK });
    useApp.getState().startImageExport("/out/Talk");
    expect(useApp.getState().imageExport).toEqual({ dir: "/out/Talk", slides: ["intro", "#2", "outro"] });
    useApp.getState().endImageExport();
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("does not start without slides", async () => {
    const useApp = await freshStore();
    useApp.getState().startImageExport("/out/Talk");
    useApp.setState({ deck: { ...DECK, slides: [] } });
    useApp.getState().startImageExport("/out/Talk");
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("is abandoned when the deck closes or another opens", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, imageExport: { dir: "/out", slides: ["intro"] } });
    await useApp.getState().closeDeck();
    expect(useApp.getState().imageExport).toBeNull();
    backend({ open_workspace: () => ({ path: "/decks/talk", name: "talk" }), open_deck: () => DECK, load_chat: () => [], agent_running: () => false });
    useApp.setState({ imageExport: { dir: "/out", slides: ["intro"] } });
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(useApp.getState().imageExport).toBeNull();
  });
});

describe("model choice", () => {
  const PROVIDERS: ProviderInfo[] = [
    {
      id: "claude",
      installed: true,
      path: "/bin/claude",
      models: [
        { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true, efforts: ["low", "medium", "high", "max"], defaultEffort: "medium", contextWindows: ["200k", "1m"], defaultContextWindow: "1m" },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", isDefault: false, efforts: ["low", "medium", "high", "max"], defaultEffort: "medium", contextWindows: ["200k", "1m"], defaultContextWindow: "200k" },
      ],
      error: null,
    },
    {
      id: "codex",
      installed: true,
      path: "/bin/codex",
      models: [{ id: "gpt-6-astra", label: "GPT-6-Astra", isDefault: true, efforts: ["low", "high"], defaultEffort: "high", contextWindows: [], defaultContextWindow: null }],
      error: null,
    },
  ];

  it("defaults to Claude Opus 5.5 at medium effort", async () => {
    const useApp = await freshStore();
    expect(useApp.getState().selection).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      effort: "medium",
      contextWindow: "1m",
    });
  });

  it("persists and restores the chosen model, keeping a supported effort", async () => {
    let useApp = await freshStore();
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("codex", "gpt-6-astra");
    // Codex's model has no "medium", so its own default applies.
    expect(useApp.getState().selection).toEqual({ provider: "codex", model: "gpt-6-astra", label: "GPT-6-Astra", effort: "high", contextWindow: null });
    useApp.getState().setEffort("low");
    useApp = await freshStore();
    expect(useApp.getState().selection).toMatchObject({ provider: "codex", model: "gpt-6-astra", effort: "low" });
  });

  it("locks a started chat to its provider while allowing model changes", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, providers: PROVIDERS });
    await useApp.getState().send("hello", { includeSlide: false, attachments: [] });
    useApp.getState().setModel("codex", "gpt-6-astra");
    expect(useApp.getState().selection.provider).toBe("claude");
    useApp.getState().setModel("claude", "claude-sonnet-5");
    expect(useApp.getState().selection.model).toBe("claude-sonnet-5");
    useApp.setState({ running: false });
    await useApp.getState().resetChat();
    useApp.getState().setModel("codex", "gpt-6-astra");
    expect(useApp.getState().selection.provider).toBe("codex");
  });

  it("keeps a chat's provider when its CLI becomes unavailable", async () => {
    const useApp = await freshStore();
    useApp.setState({ sessionProvider: "claude" });
    backend({ list_providers: () => PROVIDERS.map((p) => p.id === "claude" ? { ...p, installed: false, models: [] } : p) });
    await useApp.getState().refreshProviders();
    expect(useApp.getState().selection.provider).toBe("claude");
  });

  it("restores the workspace provider and keeps it across file switches", async () => {
    const useApp = await freshStore(false);
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("codex", "gpt-6-astra");
    backend({ open_workspace: () => ({ path: "/decks/talk", name: "talk" }), open_deck: () => DECK, session_provider: () => "claude", load_chat: () => [] });
    await useApp.getState().openWorkspace("/decks/talk");
    expect(calls("session_provider")).toEqual([{ id: "/decks/talk" }]);
    expect(useApp.getState().selection).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
    await useApp.getState().openDeck(DECK.id);
    await useApp.getState().closeDeck();
    expect(useApp.getState().sessionProvider).toBe("claude");
    useApp.getState().setModel("codex", "gpt-6-astra");
    expect(useApp.getState().selection.provider).toBe("claude");
    await useApp.getState().resetChat();
    expect(useApp.getState().sessionProvider).toBeNull();
    useApp.getState().setModel("codex", "gpt-6-astra");
    expect(useApp.getState().selection.provider).toBe("codex");
    useApp.setState({ sessionProvider: "codex" });
    await useApp.getState().closeWorkspace();
    expect(useApp.getState().sessionProvider).toBeNull();
  });

  it("ignores models that are not offered", async () => {
    const useApp = await freshStore();
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("codex", "nope");
    expect(useApp.getState().selection.provider).toBe("claude");
  });

  it("moves a selection whose provider is not installed onto an installed default", async () => {
    localStorage.setItem(
      "slopslide.selection",
      JSON.stringify({ provider: "codex", model: "gone", label: "Gone", effort: "max" }),
    );
    const useApp = await freshStore();
    const providers = PROVIDERS.map((p) => (p.id === "codex" ? { ...p, installed: false, models: [] } : p));
    backend({ list_providers: () => providers });
    await useApp.getState().refreshProviders();
    expect(useApp.getState().providers).toEqual(providers);
    expect(useApp.getState().selection).toEqual({ provider: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5", effort: "max", contextWindow: "1m" });
  });

  it("keeps the saved model when its provider could not list models", async () => {
    const saved = { provider: "codex", model: "gpt-6-astra", label: "GPT-6-Astra", effort: "high" };
    localStorage.setItem("slopslide.selection", JSON.stringify(saved));
    const useApp = await freshStore();
    const failing = PROVIDERS.map((p) => (p.id === "codex" ? { ...p, models: [], error: "not signed in" } : p));
    backend({ list_providers: () => failing });
    await useApp.getState().refreshProviders();
    expect(useApp.getState().selection).toEqual({ ...saved, contextWindow: null });
  });

  it("starts each model on its default context window and persists a change", async () => {
    let useApp = await freshStore();
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("claude", "claude-sonnet-5");
    expect(useApp.getState().selection.contextWindow).toBe("200k");
    useApp.getState().setContextWindow("1m");
    useApp = await freshStore();
    expect(useApp.getState().selection).toMatchObject({ model: "claude-sonnet-5", contextWindow: "1m" });
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("claude", "claude-opus-5-5");
    expect(useApp.getState().selection.contextWindow).toBe("1m");
  });

  it("reconciles a saved context window with the model's options", async () => {
    localStorage.setItem(
      "slopslide.selection",
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5", label: "Claude Sonnet 5", effort: "high" }),
    );
    const useApp = await freshStore();
    backend({ list_providers: () => PROVIDERS });
    await useApp.getState().refreshProviders();
    expect(useApp.getState().selection.contextWindow).toBe("200k");
  });

  it("toggles and persists favorite models", async () => {
    let useApp = await freshStore();
    useApp.getState().toggleFavoriteModel("codex:gpt-6-astra");
    useApp = await freshStore();
    expect(useApp.getState().favoriteModels).toEqual(["codex:gpt-6-astra"]);
    useApp.getState().toggleFavoriteModel("codex:gpt-6-astra");
    expect(useApp.getState().favoriteModels).toEqual([]);
  });
});

describe("sending a message", () => {
  const prompt = () => (calls("send_message")[0]!.args as { prompt: string }).prompt;

  it("does nothing without a workspace or while the agent runs", async () => {
    const useApp = await freshStore(false);
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
      `[context]\nOpen file: deck.html (deck)\nCurrent slide: <section id="#2"> in deck.html (slide 2 of 3)\n[/context]\n\nMake it blue`,
    );
  });

  it("names a deck file that is not deck.html for the agent", async () => {
    const useApp = await freshStore();
    useApp.setState({ workspace: { path: "/ws", name: "ws" }, deck: { ...DECK, id: "/ws/talks/q3.html", path: "/ws/talks/q3.html" }, selected: "#2" });
    await useApp.getState().send("Make it blue", { includeSlide: true, attachments: [] });
    expect(prompt()).toBe(
      `[context]\nOpen file: talks/q3.html (deck)\nCurrent slide: <section id="#2"> in talks/q3.html (slide 2 of 3)\n[/context]\n\nMake it blue`,
    );
  });

  it("tells the agent when the selected slide is locked", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="outro"`, `id="outro" data-locked`)), selected: "outro" });
    await useApp.getState().send("Make it blue", { includeSlide: true, attachments: [] });
    expect(prompt()).toBe(
      `[context]\nOpen file: deck.html (deck)\nCurrent slide: <section id="outro"> in deck.html (slide 3 of 3)\nThe current slide is locked (data-locked): do not change it.\n[/context]\n\nMake it blue`,
    );
  });

  it("sends the bare text when there is no context to add", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    await useApp.getState().send("Whole deck please", { includeSlide: false, attachments: [] });
    expect(prompt()).toBe("[context]\nOpen file: deck.html (deck)\n[/context]\n\nWhole deck please");
    expect(useApp.getState().messages[0]).toMatchObject({ slide: null });
  });

  it("mentions an empty deck and attached files", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: { ...DECK, slides: [] }, selected: null });
    await useApp.getState().send("Start", { includeSlide: true, attachments: ["assets/a.png", "assets/b.csv"] });
    expect(prompt()).toBe(
      "[context]\nOpen file: deck.html (deck)\nThe deck has no slides yet.\nAttached files: assets/a.png, assets/b.csv\n[/context]\n\nStart",
    );
  });

  it("passes the selected provider, model, effort, and context window", async () => {
    const useApp = await freshStore();
    useApp.setState({
      deck: DECK,
      selection: { provider: "codex", model: "gpt-6-astra", label: "GPT-6-Astra", effort: "high", contextWindow: null },
    });
    await useApp.getState().send("a", { includeSlide: false, attachments: [] });
    expect(calls("send_message")[0]!.args).toEqual({
      workspace: "/decks/talk",
      prompt: "[context]\nOpen file: deck.html (deck)\n[/context]\n\na",
      provider: "codex",
      model: "gpt-6-astra",
      effort: "high",
      contextWindow: null,
      permissionMode: "ask",
      compact: false,
    });
  });

  it("sends no effort for a model that takes none", async () => {
    const useApp = await freshStore();
    useApp.setState({
      deck: DECK,
      providers: [
        {
          id: "copilot",
          installed: true,
          path: "/bin/copilot",
          models: [
            { id: "auto", label: "Auto", isDefault: false, efforts: [], defaultEffort: null, contextWindows: [], defaultContextWindow: null },
          ],
          error: null,
        },
      ],
      selection: { provider: "copilot", model: "auto", label: "Auto", effort: "medium", contextWindow: null },
    });
    await useApp.getState().send("a", { includeSlide: false, attachments: [] });
    expect(calls("send_message")[0]!.args).toMatchObject({ provider: "copilot", model: "auto", effort: "" });
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
    expect(calls("save_chat")).toEqual([{ id: "/decks/talk", chat: useApp.getState().messages }]);
  });

  describe("with a sketch on the slide", () => {
    // Pen strokes from (0.25, 0.5) to (0.5, 0.25) of the slide: x 480–960, y 270–540, padded by 4px.
    const mark = {
      tool: "pen" as const,
      color: "#ef4444",
      points: [
        [0.25, 0.5],
        [0.5, 0.25],
      ] as [number, number][],
    };
    let target: HTMLElement;

    beforeEach(() => {
      target = document.createElement("div");
      target.setAttribute("data-sketch-target", "");
      target.getBoundingClientRect = () => new DOMRect(40, 60, 800, 450);
      document.body.appendChild(target);
    });
    afterEach(() => target.remove());

    it("screenshots the slide with the ink, which stays on the slide as a review", async () => {
      const useApp = await freshStore();
      let inkWhenCaptured: unknown;
      backend({
        capture_sketch: () => {
          inkWhenCaptured = useApp.getState().sketches.outro;
          return "/home/.slopslides/sessions/1-ab/sketches/1-ab.png";
        },
      });
      useApp.setState({ deck: DECK, selected: "outro", sketches: { outro: [mark], intro: [mark] } });
      await useApp.getState().send("Move this up", { includeSlide: true, attachments: [] });
      expect(calls("capture_sketch")).toEqual([
        {
          id: "/decks/talk/deck.html",
          rect: { x: 40, y: 60, width: 800, height: 450 },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        },
      ]);
      expect(inkWhenCaptured).toEqual([mark]);
      expect(useApp.getState().sketches).toEqual({ outro: [mark], intro: [mark] });
      expect(prompt()).toBe(
        [
          "[context]",
        "Open file: deck.html (deck)",
          'Current slide: <section id="outro"> in deck.html (slide 3 of 3)',
          "Sketch: /home/.slopslides/sessions/1-ab/sketches/1-ab.png (screenshot of the current slide with the user's marks drawn on top)",
          "Marked area: x 476–964, y 266–544 of the 1920×1080 slide",
          "[/context]",
          "",
          "Move this up",
        ].join("\n"),
      );
      expect(useApp.getState().messages[0]).toMatchObject({
        sketch: { image: "/home/.slopslides/sessions/1-ab/sketches/1-ab.png", bounds: { left: 476, top: 266, right: 964, bottom: 544 } },
      });
    });

    it("reports the marked area in pixels of the deck's slide size", async () => {
      const useApp = await freshStore();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      backend({
        capture_sketch: () => {
          throw "no screenshots here";
        },
      });
      const square = { width: 1080, height: 1080, unit: "px" as const, pixelWidth: 1080, pixelHeight: 1080 };
      useApp.setState({ deck: { ...DECK, size: square }, selected: "outro", sketches: { outro: [mark] } });
      await useApp.getState().send("Fix", { includeSlide: true, attachments: [] });
      // x 270–540, y 270–540, padded by 4px.
      expect(prompt()).toContain("Marked area: x 266–544, y 266–544 of the 1080×1080 slide");
      vi.restoreAllMocks();
    });

    it("still describes the marked area when the screenshot fails", async () => {
      const useApp = await freshStore();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      backend({
        capture_sketch: () => {
          throw "slide screenshots are not supported on this platform yet";
        },
      });
      useApp.setState({ deck: DECK, selected: "outro", sketches: { outro: [mark] } });
      await useApp.getState().send("Fix", { includeSlide: true, attachments: [] });
      expect(prompt()).not.toContain("Sketch:");
      expect(prompt()).toContain("Marked area: x 476–964, y 266–544 of the 1920×1080 slide");
      expect(useApp.getState().messages[0]).toMatchObject({ sketch: { image: null } });
      expect(useApp.getState().sketches).toEqual({ outro: [mark] });
      expect(calls("send_message")).toHaveLength(1);
      vi.restoreAllMocks();
    });

    it("skips the screenshot when the slide is not on screen", async () => {
      const useApp = await freshStore();
      target.remove();
      useApp.setState({ deck: DECK, selected: "outro", sketches: { outro: [mark] } });
      await useApp.getState().send("Fix", { includeSlide: true, attachments: [] });
      expect(calls("capture_sketch")).toEqual([]);
      expect(prompt()).toContain("Marked area:");
    });

    it("leaves the sketch alone when the message is not about the slide", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "outro", sketches: { outro: [mark] } });
      await useApp.getState().send("Whole deck", { includeSlide: false, attachments: [] });
      expect(calls("capture_sketch")).toEqual([]);
      expect(prompt()).toBe("[context]\nOpen file: deck.html (deck)\n[/context]\n\nWhole deck");
      expect(useApp.getState().messages[0]).toMatchObject({ sketch: null });
      expect(useApp.getState().sketches).toEqual({ outro: [mark] });
    });

    it("sends the marks once, and again after they change", async () => {
      const useApp = await freshStore();
      backend({ capture_sketch: () => "/home/.slopslides/sessions/1-ab/sketches/1.png" });
      useApp.setState({ deck: DECK, selected: "outro", sketches: { outro: [mark] } });
      const send = async (text: string) => {
        await useApp.getState().send(text, { includeSlide: true, attachments: [] });
        useApp.setState({ running: false });
      };
      await send("Fix");
      await send("And the title");
      const prompts = () => calls("send_message").map((c) => (c.args as { prompt: string }).prompt);
      expect(calls("capture_sketch")).toHaveLength(1);
      expect(prompts()[1]).not.toContain("Marked area");
      useApp.getState().setSketches((all) => ({ ...all, outro: [mark, mark] }));
      await send("Also this");
      expect(calls("capture_sketch")).toHaveLength(2);
      expect(prompts()[2]).toContain("Marked area");
    });

    it("skipSketch keeps the current marks out of the next message", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "outro", sketches: { outro: [mark] } });
      useApp.getState().skipSketch("outro");
      await useApp.getState().send("Fix", { includeSlide: true, attachments: [] });
      expect(calls("capture_sketch")).toEqual([]);
      expect(prompt()).not.toContain("Marked area");
      expect(useApp.getState().sketches).toEqual({ outro: [mark] });
    });

    it("does not send hidden review marks", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "outro", sketches: { outro: [mark] }, reviewVisible: false });
      await useApp.getState().send("Fix", { includeSlide: true, attachments: [] });
      expect(calls("capture_sketch")).toEqual([]);
      expect(useApp.getState().messages[0]).toMatchObject({ sketch: null });
    });

    it("ignores another slide's sketch and emptied sketches", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "outro", sketches: { intro: [mark], outro: [] } });
      await useApp.getState().send("Fix", { includeSlide: true, attachments: [] });
      expect(calls("capture_sketch")).toEqual([]);
      expect(prompt()).not.toContain("Marked area");
    });
  });

  it("clearSketch and setSketches edit ink per slide", async () => {
    const useApp = await freshStore();
    const ink = [{ tool: "pen" as const, color: "#fff", points: [[0, 0]] as [number, number][] }];
    useApp.getState().setSketches((all) => ({ ...all, a: ink, b: ink }));
    useApp.getState().clearSketch("a");
    useApp.getState().clearSketch("missing");
    expect(useApp.getState().sketches).toEqual({ b: ink });
  });

  describe("review marks", () => {
    const ink = [{ tool: "pen" as const, color: "#fff", points: [[0.5, 0.5]] as [number, number][] }];

    afterEach(() => {
      vi.useRealTimers();
    });

    it("are saved to deck.html once drawing pauses, without empty slides", async () => {
      vi.useFakeTimers();
      const useApp = await freshStore();
      useApp.setState({ deck: DECK });
      useApp.getState().setSketches((all) => ({ ...all, intro: ink }));
      useApp.getState().setSketches((all) => ({ ...all, outro: ink }));
      useApp.getState().clearSketch("outro");
      useApp.getState().setSketches((all) => ({ ...all, "#2": [] }));
      await vi.advanceTimersByTimeAsync(300);
      expect(calls("save_review")).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(calls("save_review")).toEqual([{ id: "/decks/talk/deck.html", review: { intro: ink } }]);
    });

    it("are saved right away when the deck closes", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK });
      useApp.getState().setSketches(() => ({ intro: ink }));
      let deckWhenSaved: unknown = "not saved";
      invoke.mockImplementation(async (command: string) => {
        if (command === "save_review") deckWhenSaved = useApp.getState().deck;
      });
      await useApp.getState().closeDeck();
      expect(calls("save_review")).toEqual([{ id: "/decks/talk/deck.html", review: { intro: ink } }]);
      expect(deckWhenSaved).toBe(DECK);
      expect(useApp.getState().deck).toBeNull();
    });

    it("are not saved when they end up as the file has them", async () => {
      const { useApp, flushReviewSave } = await freshModule();
      useApp.setState({ deck: DECK });
      useApp.getState().setSketches(() => ({ intro: ink }));
      useApp.getState().clearSketch("intro");
      await flushReviewSave();
      expect(calls("save_review")).toEqual([]);
    });

    it("report a failed save", async () => {
      const { useApp, flushReviewSave } = await freshModule();
      backend({
        save_review: () => {
          throw "disk full";
        },
      });
      useApp.setState({ deck: DECK });
      useApp.getState().setSketches(() => ({ intro: ink }));
      await flushReviewSave();
      expect(useApp.getState().error).toBe("Could not save the review marks: disk full");
    });

    it("are loaded with the deck", async () => {
      const useApp = await freshStore();
      backend({ open_deck: () => ({ ...DECK, review: { intro: ink } }), load_chat: () => [], agent_running: () => false });
      await useApp.getState().openDeck("/decks/talk/deck.html");
      expect(useApp.getState().sketches).toEqual({ intro: ink });
    });

    it("visibility is remembered", async () => {
      localStorage.removeItem("slopslide.reviewVisible");
      let useApp = await freshStore();
      expect(useApp.getState().reviewVisible).toBe(true);
      useApp.getState().setReviewVisible(false);
      useApp = await freshStore();
      expect(useApp.getState().reviewVisible).toBe(false);
      localStorage.removeItem("slopslide.reviewVisible");
    });
  });

  it("interrupt asks the backend to stop the workspace agent", async () => {
    const useApp = await freshStore(false);
    useApp.getState().interrupt();
    expect(calls("interrupt_agent")).toEqual([]);
    useApp.setState({ workspace: { path: "/decks/talk", name: "talk" } });
    useApp.getState().interrupt();
    expect(calls("interrupt_agent")).toEqual([{ id: "/decks/talk" }]);
  });

  it("records which provider writes the reply", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selection: { ...useApp.getState().selection, provider: "copilot" } });
    await useApp.getState().send("hi", { includeSlide: false, attachments: [] });
    expect(useApp.getState().messages[1]).toMatchObject({ role: "assistant", provider: "copilot" });
    expect(calls("send_message")[0]!.args).toMatchObject({ compact: false });
  });

  describe("compacting", () => {
    it("asks the agent to compact, without slide context, and shows it as a command", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro" });
      await useApp.getState().compact();
      expect(calls("send_message")[0]!.args).toMatchObject({ prompt: "/compact", compact: true, provider: "claude" });
      const [user, reply] = useApp.getState().messages as [UserMessage, AssistantMessage];
      expect(user).toMatchObject({ text: "/compact", command: "compact", slide: null, attachments: [] });
      expect(reply).toMatchObject({ status: "streaming", provider: "claude" });
      expect(useApp.getState().running).toBe(true);
    });

    it("does nothing without a workspace or while the agent runs", async () => {
      const useApp = await freshStore(false);
      await useApp.getState().compact();
      useApp.setState({ deck: DECK, running: true });
      await useApp.getState().compact();
      expect(calls("send_message")).toEqual([]);
      expect(useApp.getState().messages).toEqual([]);
    });

    it("treats a typed /compact as the command", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro" });
      await useApp.getState().send("  /compact ", { includeSlide: true, attachments: [] });
      expect(calls("send_message")[0]!.args).toMatchObject({ prompt: "/compact", compact: true });
      expect(useApp.getState().messages[0]).toMatchObject({ command: "compact", slide: null });
    });

    it("shows a refused compaction on the reply", async () => {
      const useApp = await freshStore();
      backend({
        send_message: () => {
          throw "The agent is still working on this deck.";
        },
      });
      useApp.setState({ deck: DECK });
      await useApp.getState().compact();
      expect(useApp.getState().messages[1]).toMatchObject({ status: "error", error: "The agent is still working on this deck." });
      expect(useApp.getState().running).toBe(false);
    });
  });

  it("resetChat clears the workspace transcript", async () => {
    const useApp = await freshStore(false);
    await useApp.getState().resetChat();
    expect(calls("reset_chat")).toEqual([]);
    useApp.setState({ workspace: { path: "/decks/talk", name: "talk" }, messages: [userMessage("x")], running: false });
    await useApp.getState().resetChat();
    expect(calls("reset_chat")).toEqual([{ id: "/decks/talk" }]);
    expect(useApp.getState().messages).toEqual([]);
    expect(useApp.getState().running).toBe(false);
  });
});

describe("agent events", () => {
  async function bridged(messages: ChatMessage[] = [userMessage("hi"), assistantMessage({ status: "streaming", thinking: true })]) {
    const store = await freshModule();
    backend({ list_providers: () => [] });
    await store.initEventBridge();
    store.useApp.setState({ deck: DECK, messages, running: true });
    const emit = (event: AgentEvent, workspace = "/decks/talk") => listeners.get("agent-event")!({ payload: { workspace, event } });
    const reply = () => store.useApp.getState().messages.findLast((m) => m.role === "assistant") as AssistantMessage;
    return { useApp: store.useApp, emit, reply };
  }

  it("tracks approvals, resolves only the matching request, and expires unanswered requests", async () => {
    const { emit, reply } = await bridged();
    const approval = { id: "r1", title: "Run", reason: null, details: "ls", acceptLabel: "Allow once", decisions: ["accept", "decline"] as const };
    emit({ type: "approvalRequested", approval: { ...approval, decisions: [...approval.decisions] } });
    emit({ type: "approvalRequested", approval: { ...approval, id: "r2", decisions: [...approval.decisions] } });
    emit({ type: "approvalResolved", id: "r1" });
    expect(reply().parts).toMatchObject([{ status: "resolved" }, { status: "pending" }]);
    emit({ type: "finished", interrupted: true });
    expect(reply().parts).toMatchObject([{ status: "resolved" }, { status: "expired" }]);
  });

  it("updates automatic reviews rather than adding duplicate cards", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "approvalReview", id: "review-1", status: "inProgress", detail: null });
    emit({ type: "approvalReview", id: "review-1", status: "approved", detail: "Within scope" });
    expect(reply().parts).toEqual([{ kind: "approvalReview", id: "review-1", status: "approved", detail: "Within scope" }]);
  });

  it("ignores approval events for other decks", async () => {
    const { emit, reply } = await bridged();
    emit({ type: "approvalRequested", approval: { id: "r", title: "Run", reason: null, details: "ls", acceptLabel: "Allow once", decisions: ["accept"] } }, "another-deck");
    expect(reply().parts).toEqual([]);
  });

  it("initEventBridge loads the installed providers, or none when the check fails", async () => {
    const store = await freshModule();
    const providers = [{ id: "claude", installed: false, path: null, models: [], error: null }];
    backend({ list_providers: () => providers });
    await store.initEventBridge();
    await vi.waitFor(() => expect(store.useApp.getState().providers).toEqual(providers));
    const failing = await freshModule();
    backend({
      list_providers: () => {
        throw new Error("no");
      },
    });
    await failing.initEventBridge();
    await vi.waitFor(() => expect(failing.useApp.getState().providers).toEqual([]));
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
    expect(calls("save_chat")).toEqual([{ id: "/decks/talk", chat: useApp.getState().messages }]);
  });

  it("only updates the last reply", async () => {
    const first = assistantMessage({ id: "a-0", parts: [{ kind: "text", text: "old" }] });
    const { useApp, emit } = await bridged([first, userMessage("again"), assistantMessage({ id: "a-1", status: "streaming" })]);
    emit({ type: "textDelta", text: "new" });
    expect(useApp.getState().messages[0]).toEqual(first);
  });

  describe("context usage", () => {
    it("records the context size on the reply, keeping what a report leaves out", async () => {
      const { emit, reply } = await bridged([userMessage("hi"), assistantMessage({ status: "streaming", provider: "claude" })]);
      emit({ type: "usage", contextTokens: 20_000, contextWindow: null });
      expect(reply().context).toEqual({ provider: "claude", tokens: 20_000, window: null });
      emit({ type: "usage", contextTokens: null, contextWindow: 200_000 });
      expect(reply().context).toEqual({ provider: "claude", tokens: 20_000, window: 200_000 });
    });

    it("carries the window over from an earlier reply of the same provider", async () => {
      const earlier = assistantMessage({ id: "a-0", provider: "claude", context: { provider: "claude", tokens: 5, window: 1_000_000 } });
      const other = assistantMessage({ id: "a-1", provider: "copilot", context: { provider: "copilot", tokens: 9, window: 128_000 } });
      const { emit, reply } = await bridged([earlier, other, userMessage("hi"), assistantMessage({ id: "a-2", status: "streaming", provider: "claude" })]);
      emit({ type: "usage", contextTokens: 60_000, contextWindow: null });
      expect(reply().context).toEqual({ provider: "claude", tokens: 60_000, window: 1_000_000 });
    });

    it("falls back to the selected provider for replies saved before providers were recorded", async () => {
      const { useApp, emit, reply } = await bridged();
      useApp.setState({ selection: { ...useApp.getState().selection, provider: "copilot" } });
      emit({ type: "usage", contextTokens: 1, contextWindow: 2 });
      expect(reply().context).toEqual({ provider: "copilot", tokens: 1, window: 2 });
    });

    it("shows compaction, forgets the old size, and settles when the turn ends", async () => {
      const earlier = assistantMessage({ id: "a-0", provider: "claude", context: { provider: "claude", tokens: 90_000, window: 200_000 } });
      const { emit, reply } = await bridged([earlier, userMessage("/compact"), assistantMessage({ id: "a-1", status: "streaming", thinking: true, provider: "claude" })]);
      emit({ type: "compacting" });
      expect(reply()).toMatchObject({ compacting: true, thinking: false });
      emit({ type: "compacted" });
      expect(reply()).toMatchObject({ compacting: false, compacted: true, context: { provider: "claude", tokens: null, window: 200_000 } });
      emit({ type: "usage", contextTokens: 12_000, contextWindow: 128_000 });
      expect(reply().context).toEqual({ provider: "claude", tokens: 12_000, window: 128_000 });
      emit({ type: "compacting" });
      emit({ type: "finished", interrupted: true });
      expect(reply()).toMatchObject({ compacting: false, status: "interrupted" });
    });
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
  /** The deck is `talk/deck.html` in the workspace `/decks`; `changed` takes deck-relative paths. */
  async function watching(next: () => Deck | Promise<Deck>) {
    vi.useFakeTimers();
    const store = await freshModule();
    backend({ agent_status: () => null, load_deck: () => next() });
    await store.initEventBridge();
    store.useApp.setState({
      workspace: { path: "/decks", name: "decks" },
      openedFile: { path: "talk/deck.html", absolute: DECK_HTML_PATH, kind: "deck" },
      deck: DECK,
      selected: "intro",
      running: false,
      assetsRev: 0,
    });
    const changedIn = (root: string, paths: string[]) => listeners.get("workspace-changed")!({ payload: { root, paths } });
    const changed = (paths: string[]) => changedIn("/decks", paths.map((p) => `talk/${p}`));
    return { useApp: store.useApp, changed, changedIn };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes on review marks changed outside the app", async () => {
    const ink = [{ tool: "pen" as const, color: "#fff", points: [[0.5, 0.5]] as [number, number][] }];
    let review: Deck["review"] = { intro: ink };
    const { useApp, changed } = await watching(() => ({ ...DECK, review }));
    useApp.setState({ sketches: {} });
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(useApp.getState().sketches).toEqual({ intro: ink });
    // The agent cleared the review when asked to.
    review = undefined;
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(useApp.getState().sketches).toEqual({});
  });

  it("keeps marks the user is still drawing over the file's older ones", async () => {
    const ink = [{ tool: "pen" as const, color: "#fff", points: [[0.5, 0.5]] as [number, number][] }];
    const { useApp, changed } = await watching(() => ({ ...DECK, review: {} }));
    useApp.getState().setSketches(() => ({ intro: ink }));
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(130);
    expect(useApp.getState().sketches).toEqual({ intro: ink });
    // Once saved, the file matches what was saved and nothing is taken on.
    await vi.advanceTimersByTimeAsync(400);
    expect(calls("save_review")).toHaveLength(1);
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
    expect(calls("load_deck")).toEqual([{ id: "/decks/talk/deck.html" }]);
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
    const added = { ...DECK, slides: [...DECK.slides, { id: "fresh", hash: "f", hidden: false, locked: false, moved: false }] };
    const { useApp, changed } = await watching(() => added);
    useApp.setState({ running: true });
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(120);
    expect(useApp.getState().selected).toBe("fresh");
  });

  it("ignores a deck file that cannot be read mid-write", async () => {
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

  it("ignores other workspaces, other decks' folders and unrelated files", async () => {
    const { useApp, changed, changedIn } = await watching(() => DECK);
    changedIn("/elsewhere", ["talk/deck.html", "talk/assets/a.png"]);
    changedIn("/decks", ["other/deck.html", "other/assets/a.png", "deck.html", "talk-old/deck.html"]);
    changed(["notes.md", "q3.html"]);
    await vi.advanceTimersByTimeAsync(500);
    expect(calls("load_deck")).toEqual([]);
    expect(useApp.getState().assetsRev).toBe(0);
  });

  it("tells the file tree what changed", async () => {
    const { useApp, changed, changedIn } = await watching(() => DECK);
    changed(["notes.md"]);
    expect(useApp.getState().workspaceChange).toEqual({ paths: ["talk/notes.md"], rev: 1 });
    changedIn("/elsewhere", ["x.md"]);
    expect(useApp.getState().workspaceChange?.rev).toBe(1);
  });

  it("follows a deck with another file name at the workspace root", async () => {
    const edited = deckFor(DECK_HTML, "2");
    const { useApp, changedIn } = await watching(() => edited);
    useApp.setState({ openedFile: { path: "q3.html", absolute: "/decks/q3.html", kind: "deck" }, deck: { ...DECK, id: "/decks/q3.html" } });
    changedIn("/decks", ["talk/deck.html"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls("load_deck")).toEqual([]);
    changedIn("/decks", ["q3.html", "assets/a.png"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls("load_deck")).toEqual([{ id: "/decks/q3.html" }]);
    expect(useApp.getState().assetsRev).toBe(1);
  });

  it("reloads an open page (not a deck) when it changes", async () => {
    const { useApp, changedIn } = await watching(() => DECK);
    useApp.setState({ deck: null, openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" }, fileRev: 0 });
    changedIn("/decks", ["site/style.css"]);
    expect(useApp.getState().fileRev).toBe(0);
    changedIn("/decks", ["site/index.html"]);
    expect(useApp.getState().fileRev).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls("load_deck")).toEqual([]);
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
    expect(calls("lint_deck")).toEqual([{ id: "/decks/talk/deck.html" }]);
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
    useApp.getState().fillComposer("tidy it", { screenshot: "/home/.slopslides/sessions/1-ab/sketches/1.png" });
    expect(useApp.getState().composerFill).toEqual({ text: "tidy it", rev: 3, screenshot: "/home/.slopslides/sessions/1-ab/sketches/1.png" });
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
    expect(prompt).toMatch(/^deck\.html does not pass/);
    expect(lintFixPrompt([], "q3.html")).toMatch(/^q3\.html does not pass/);
  });
});

describe("editing slides on the stage", () => {
  const MOVED = `<section class="slide" id="intro">\n  <h1 data-moved="" style="translate: 4px 0px;">Hello</h1>\n</section>`;
  const ORIGINAL = `<section class="slide" id="intro">\n  <h1>Hello</h1>\n</section>`;
  /** Backend whose `update_slide` swaps in the markup; like the real one, the hash follows the content. */
  function slideBackend() {
    const revs = new Map([[ORIGINAL, 1]]);
    let rev = 1;
    let markup = ORIGINAL;
    backend({
      update_slide: ({ slide, markup: next, base }) => {
        if (base !== `${String(slide)}-${rev}`) throw "The slide changed while you were editing it.";
        const previous = markup;
        markup = String(next);
        if (!revs.has(markup)) revs.set(markup, revs.size + 1);
        rev = revs.get(markup)!;
        const deck = deckFor(DECK_HTML, String(rev));
        return { deck: { ...deck, slides: deck.slides.map((s) => (s.id === slide ? { ...s, moved: markup.includes("data-moved") } : s)) }, previous };
      },
    });
    return { markup: () => markup };
  }

  it("saves an edit against the slide's current hash and remembers how to undo it", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    await useApp.getState().saveSlideEdit("intro", MOVED);
    expect(calls("update_slide")).toEqual([{ id: "/decks/talk/deck.html", slide: "intro", markup: MOVED, base: "intro-1" }]);
    const deck = useApp.getState().deck!;
    expect(deck.slides[0]).toMatchObject({ hash: "intro-2", moved: true });
    expect(useApp.getState().slideUndo).toEqual([{ slide: "intro", markup: ORIGINAL, after: "intro-2" }]);
  });

  it("saves edits one after another, each on top of the last", async () => {
    const useApp = await freshStore();
    const disk = slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    const first = useApp.getState().saveSlideEdit("intro", MOVED);
    const second = useApp.getState().saveSlideEdit("intro", MOVED.replace("Hello", "Hi"));
    await Promise.all([first, second]);
    expect(calls("update_slide").map((c) => c.base)).toEqual(["intro-1", "intro-2"]);
    expect(disk.markup()).toContain("Hi");
    expect(useApp.getState().error).toBeNull();
  });

  it("reports a refused save and reloads the slide from disk", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML, "9"), selected: "intro", editReload: 0 });
    await useApp.getState().saveSlideEdit("intro", MOVED);
    expect(useApp.getState().error).toContain("changed");
    expect(useApp.getState().editReload).toBe(1);
    expect(useApp.getState().slideUndo).toEqual([]);
  });

  it("ignores edits of slides that are gone", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    await useApp.getState().saveSlideEdit("deleted", MOVED);
    expect(calls("update_slide")).toEqual([]);
  });

  it("undo saves the previous markup back and selects the slide", async () => {
    const useApp = await freshStore();
    const disk = slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    await useApp.getState().saveSlideEdit("intro", MOVED);
    useApp.getState().select("outro");
    await useApp.getState().undoSlideEdit();
    expect(disk.markup()).toBe(ORIGINAL);
    expect(calls("update_slide")[1]).toEqual({ id: "/decks/talk/deck.html", slide: "intro", markup: ORIGINAL, base: "intro-2" });
    expect(useApp.getState().selected).toBe("intro");
    expect(useApp.getState().slideUndo).toEqual([]);
    await useApp.getState().undoSlideEdit();
    expect(calls("update_slide")).toHaveLength(2);
  });

  it("refuses to undo once the slide changed again (say, by the agent)", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    await useApp.getState().saveSlideEdit("intro", MOVED);
    useApp.getState().setDeck(deckFor(DECK_HTML, "agent"));
    await useApp.getState().undoSlideEdit();
    expect(calls("update_slide")).toHaveLength(1);
    expect(useApp.getState().error).toContain("cannot be undone");
    expect(useApp.getState().slideUndo).toEqual([]);
  });

  it("redoes an undone edit, and a new edit forgets what could be redone", async () => {
    const useApp = await freshStore();
    const disk = slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    await useApp.getState().saveSlideEdit("intro", MOVED);
    await useApp.getState().undoSlideEdit();
    expect(useApp.getState().slideRedo).toEqual([{ slide: "intro", markup: MOVED, after: "intro-1" }]);
    await useApp.getState().redoSlideEdit();
    expect(disk.markup()).toBe(MOVED);
    expect(calls("update_slide")[2]).toEqual({ id: "/decks/talk/deck.html", slide: "intro", markup: MOVED, base: "intro-1" });
    expect(useApp.getState().slideRedo).toEqual([]);
    expect(useApp.getState().slideUndo).toEqual([{ slide: "intro", markup: ORIGINAL, after: "intro-2" }]);
    await useApp.getState().undoSlideEdit();
    await useApp.getState().saveSlideEdit("intro", MOVED.replace("Hello", "Hi"));
    expect(useApp.getState().slideRedo).toEqual([]);
    await useApp.getState().redoSlideEdit();
    expect(calls("update_slide")).toHaveLength(5);
  });

  it("refuses to redo once the slide changed again", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    await useApp.getState().saveSlideEdit("intro", MOVED);
    await useApp.getState().undoSlideEdit();
    useApp.getState().setDeck(deckFor(DECK_HTML, "agent"));
    await useApp.getState().redoSlideEdit();
    expect(calls("update_slide")).toHaveLength(2);
    expect(useApp.getState().error).toContain("cannot be redone");
  });

  it("discard undoes every edit of the session and leaves edit mode", async () => {
    const useApp = await freshStore();
    const disk = slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setEditing(true);
    await useApp.getState().saveSlideEdit("intro", MOVED);
    await useApp.getState().saveSlideEdit("intro", MOVED.replace("Hello", "Hi"));
    await useApp.getState().discardSlideEdits();
    expect(disk.markup()).toBe(ORIGINAL);
    expect(useApp.getState()).toMatchObject({ editing: false, slideUndo: [], slideRedo: [], error: null });
  });

  it("discard stops at an edit it cannot undo", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setEditing(true);
    await useApp.getState().saveSlideEdit("intro", MOVED);
    useApp.getState().setDeck(deckFor(DECK_HTML, "agent"));
    await useApp.getState().discardSlideEdits();
    expect(calls("update_slide")).toHaveLength(1);
    expect(useApp.getState().error).toContain("cannot be undone");
    expect(useApp.getState().editing).toBe(false);
  });

  it("accepting (leaving edit mode) keeps the edits, and each session starts with fresh history", async () => {
    const useApp = await freshStore();
    const disk = slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setEditing(true);
    await useApp.getState().saveSlideEdit("intro", MOVED);
    useApp.getState().setEditing(true);
    expect(useApp.getState().slideUndo).toHaveLength(1);
    useApp.getState().setEditing(false);
    expect(disk.markup()).toBe(MOVED);
    expect(useApp.getState()).toMatchObject({ editing: false, slideUndo: [], slideRedo: [] });
    useApp.getState().setEditing(true);
    expect(useApp.getState().slideUndo).toEqual([]);
  });

  it("leaves edit mode and forgets undo history when the deck closes", async () => {
    const useApp = await freshStore();
    const entry = { slide: "intro", markup: ORIGINAL, after: "x" };
    useApp.setState({ deck: DECK, editing: true, slideUndo: [entry], slideRedo: [entry] });
    await useApp.getState().closeDeck();
    expect(useApp.getState()).toMatchObject({ editing: false, slideUndo: [], slideRedo: [] });
  });

  it("does not enter edit mode on a locked slide", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)), selected: "intro", editing: false });
    useApp.getState().setEditing(true);
    expect(useApp.getState().editing).toBe(false);
    useApp.getState().select("outro");
    useApp.getState().setEditing(true);
    expect(useApp.getState().editing).toBe(true);
  });

  describe("tidying the layout", () => {
    let target: HTMLElement;
    beforeEach(() => {
      target = document.createElement("div");
      target.setAttribute("data-sketch-target", "");
      target.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
      document.body.appendChild(target);
    });
    afterEach(() => target.remove());

    it("screenshots the slide, leaves edit mode, and prepares the request in the composer", async () => {
      const { useApp, TIDY_PROMPT } = await freshModule();
      backend({ capture_sketch: () => "/home/.slopslides/sessions/1-ab/sketches/2-cd.png" });
      useApp.setState({ deck: DECK, selected: "intro", sidebarOpen: false, composerFill: null, editing: true });
      await useApp.getState().tidyLayout();
      expect(calls("capture_sketch")).toHaveLength(1);
      expect(calls("send_message")).toHaveLength(0);
      expect(useApp.getState().messages).toEqual([]);
      expect(useApp.getState()).toMatchObject({
        sidebarOpen: true,
        editing: false,
        composerFill: { text: TIDY_PROMPT, screenshot: "/home/.slopslides/sessions/1-ab/sketches/2-cd.png" },
      });
    });

    it("does not tidy a locked slide", async () => {
      const { useApp } = await freshModule();
      useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)), selected: "intro", composerFill: null });
      await useApp.getState().tidyLayout();
      expect(calls("capture_sketch")).toEqual([]);
      expect(useApp.getState().composerFill).toBeNull();
    });

    it("still prepares the request when the screenshot fails", async () => {
      const { useApp, TIDY_PROMPT } = await freshModule();
      backend({
        capture_sketch: () => {
          throw "slide screenshots are not supported on this platform yet";
        },
      });
      useApp.setState({ deck: DECK, selected: "intro", composerFill: null });
      await useApp.getState().tidyLayout();
      expect(useApp.getState().composerFill).toEqual({ text: TIDY_PROMPT, rev: 1 });
    });

    it("lists the overflow the editor found in the request", async () => {
      const { useApp, tidyPrompt } = await freshModule();
      backend({ capture_sketch: () => "/home/.slopslides/sessions/1-ab/sketches/4.png" });
      useApp.setState({ deck: DECK, selected: "intro" });
      const overflow = ['<p> "Long" runs past the bottom edge by 80px', "<h1> is cut off by its own box"];
      await useApp.getState().tidyLayout(overflow);
      expect(useApp.getState().composerFill?.text).toBe(tidyPrompt(overflow));
      expect(tidyPrompt(overflow)).toContain(`The editor found overflow:\n- ${overflow[0]}\n- ${overflow[1]}`);
      expect(tidyPrompt()).toBe(tidyPrompt([]));
    });

    it("sends the screenshot handed over with the message", async () => {
      const { useApp, TIDY_PROMPT } = await freshModule();
      useApp.setState({ deck: DECK, selected: "intro" });
      await useApp.getState().send(TIDY_PROMPT, { includeSlide: true, attachments: [], screenshot: "/home/.slopslides/sessions/1-ab/sketches/2-cd.png" });
      expect(calls("capture_sketch")).toHaveLength(0);
      expect((calls("send_message")[0]!.args as { prompt: string }).prompt).toBe(
        [
          "[context]",
        "Open file: deck.html (deck)",
          'Current slide: <section id="intro"> in deck.html (slide 1 of 3)',
          "Screenshot: /home/.slopslides/sessions/1-ab/sketches/2-cd.png (screenshot of the slide with the user's hand edits)",
          "[/context]",
          "",
          TIDY_PROMPT,
        ].join("\n"),
      );
      expect(useApp.getState().messages[0]).toMatchObject({
        text: TIDY_PROMPT,
        slide: "intro",
        sketch: null,
        screenshot: "/home/.slopslides/sessions/1-ab/sketches/2-cd.png",
      });
    });

    it("captures any sketch alongside the handed-over screenshot", async () => {
      const useApp = await freshStore();
      backend({ capture_sketch: () => "/home/.slopslides/sessions/1-ab/sketches/3.png" });
      const ink = [{ tool: "pen" as const, color: "#f00", points: [[0.5, 0.5]] as [number, number][] }];
      useApp.setState({ deck: DECK, selected: "intro", sketches: { intro: ink } });
      await useApp.getState().send("Tidy", { includeSlide: true, attachments: [], screenshot: "/home/.slopslides/sessions/1-ab/sketches/2.png" });
      expect(calls("capture_sketch")).toHaveLength(1);
      expect(useApp.getState().messages[0]).toMatchObject({
        sketch: { image: "/home/.slopslides/sessions/1-ab/sketches/3.png" },
        screenshot: "/home/.slopslides/sessions/1-ab/sketches/2.png",
      });
      expect(useApp.getState().sketches).toEqual({ intro: ink });
    });
  });
});


describe("permissions", () => {
  it("stops a Codex turn and saves a closed transcript before leaving the workspace", async () => {
    const store = await freshStore();
    store.setState({ deck: deckFor(DECK_HTML), running: true, messages: [assistantMessage({ provider: "codex", status: "streaming", parts: [{ kind: "approval", status: "pending", approval: { id: "live", title: "Run", reason: null, details: "ls", acceptLabel: "Allow once", decisions: ["accept"] } }] })] });
    await store.getState().closeWorkspace();
    const order = invoke.mock.calls.map(([command]) => command);
    expect(order.indexOf("interrupt_agent")).toBeLessThan(order.indexOf("save_chat"));
    expect(calls("save_chat")[0]!.chat).toMatchObject([{ status: "interrupted", parts: [{ status: "expired" }] }]);
    expect(store.getState().deck).toBeNull();
  });

  it("keeps the existing background behavior for other providers", async () => {
    const store = await freshStore();
    store.setState({ deck: deckFor(DECK_HTML), running: true, messages: [assistantMessage({ provider: "claude", status: "streaming" })] });
    await store.getState().closeDeck();
    expect(calls("interrupt_agent")).toHaveLength(0);
  });

  const codex = { provider: "codex" as const, model: "m", label: "M", effort: "high", contextWindow: null };
  const claude = { ...codex, provider: "claude" as const };

  it("defaults to Ask, remembers each provider's choice, and rejects invalid saved values", async () => {
    let store = await freshStore();
    expect(store.getState().permissionModes).toEqual({ claude: "ask", codex: "ask", copilot: "ask" });
    store.setState({ selection: codex });
    store.getState().setPermissionMode("autoReview");
    store.setState({ selection: claude });
    store.getState().setPermissionMode("fullAccess");
    expect(JSON.parse(localStorage.getItem("slopslide.permissions")!)).toEqual({ claude: "fullAccess", codex: "autoReview", copilot: "ask" });
    store = await freshStore();
    expect(store.getState().permissionModes).toEqual({ claude: "fullAccess", codex: "autoReview", copilot: "ask" });
    localStorage.setItem("slopslide.permissions", '{"claude":"__proto__","codex":3,"__proto__":{"copilot":"custom"}}');
    expect((await freshStore()).getState().permissionModes).toEqual({ claude: "ask", codex: "ask", copilot: "ask" });
    localStorage.setItem("slopslide.permissions", "not json");
    expect((await freshStore()).getState().permissionModes.claude).toBe("ask");
  });

  it("keeps the Codex mode saved before every provider had one", async () => {
    localStorage.setItem("slopslide.codexPermissions", "custom");
    expect((await freshStore()).getState().permissionModes).toEqual({ claude: "ask", codex: "custom", copilot: "ask" });
  });

  it("cannot change the mode during a turn", async () => {
    const store = await freshStore();
    store.setState({ running: true });
    store.getState().setPermissionMode("fullAccess");
    expect(store.getState().permissionModes.claude).toBe("ask");
    expect(localStorage.getItem("slopslide.permissions")).toBeNull();
  });

  it("sends each provider its own mode", async () => {
    const store = await freshStore();
    store.setState({ deck: deckFor(DECK_HTML), permissionModes: { claude: "fullAccess", codex: "autoReview", copilot: "ask" }, selection: codex });
    await store.getState().send("slides", { includeSlide: false, attachments: [] });
    expect(calls("send_message")[0]!.args).toMatchObject({ provider: "codex", permissionMode: "autoReview" });
    store.setState({ running: false, selection: claude });
    await store.getState().send("slides", { includeSlide: false, attachments: [] });
    expect(calls("send_message")[1]!.args).toMatchObject({ provider: "claude", permissionMode: "fullAccess" });
  });

  it("restored approvals are closed rather than reusable", async () => {
    const store = await freshStore(false);
    const message = assistantMessage({ status: "streaming", parts: [{ kind: "approval", status: "pending", approval: { id: "old", title: "Run", reason: null, details: "ls", acceptLabel: "Allow once", decisions: ["accept"] } }] });
    backend({ open_workspace: () => ({ path: "/decks/talk", name: "talk" }), open_deck: () => deckFor(DECK_HTML), load_chat: () => [message], agent_running: () => false });
    await store.getState().openWorkspace("/decks/talk");
    await store.getState().openDeck("/decks/talk/deck.html");
    expect((store.getState().messages[0] as AssistantMessage).parts[0]).toMatchObject({ status: "expired" });
  });
});

describe("templates", () => {
  const SWISS = { id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title", "split", "quote"] };
  const MINE = { id: "mine", title: "Mine", builtin: false, path: "/t/mine", slides: ["cover"] };
  const STAGED = "/home/.slopslides/sessions/1-ab/templates/swiss.html";

  async function storeWith(deck: Deck, selected: string | null = "intro") {
    const useApp = await freshStore();
    useApp.setState({ deck, selected, templates: [MINE, SWISS], sidebarOpen: true });
    return useApp;
  }

  it("points every message at a copy of the deck's template", async () => {
    const useApp = await storeWith({ ...DECK, template: "swiss" }, null);
    backend({ stage_template: () => STAGED });
    await useApp.getState().send("Add a slide", { includeSlide: false, attachments: [] });
    expect(calls("stage_template")).toEqual([{ id: DECK.id, template: "swiss" }]);
    expect(calls("send_message")[0]!.args).toMatchObject({
      prompt: `[context]\nOpen file: deck.html (deck)\nDeck template: ${STAGED} (copy of the deck's template, for its layouts)\n[/context]\n\nAdd a slide`,
    });
  });

  it("sends without a template copy when the deck has none or it is gone", async () => {
    const useApp = await storeWith(DECK, null);
    await useApp.getState().send("Hi", { includeSlide: false, attachments: [] });
    expect(calls("stage_template")).toEqual([]);
    expect(calls("send_message")[0]!.args).toMatchObject({ prompt: "[context]\nOpen file: deck.html (deck)\n[/context]\n\nHi" });

    useApp.setState({ deck: { ...DECK, template: "gone" }, running: false, messages: [] });
    backend({
      stage_template: () => {
        throw "template not found: gone";
      },
    });
    await useApp.getState().send("Hi again", { includeSlide: false, attachments: [] });
    expect(calls("stage_template")).toEqual([{ id: DECK.id, template: "gone" }]);
    expect(calls("send_message").at(-1)!.args).toMatchObject({ prompt: "[context]\nOpen file: deck.html (deck)\n[/context]\n\nHi again" });
  });

  it("loads the template list", async () => {
    const useApp = await freshStore();
    backend({ list_templates: () => [MINE, SWISS] });
    await useApp.getState().refreshTemplates();
    expect(useApp.getState().templates).toEqual([MINE, SWISS]);
    backend({
      list_templates: () => {
        throw "cannot locate home folder";
      },
    });
    await useApp.getState().refreshTemplates();
    expect(useApp.getState()).toMatchObject({ templates: [], error: "cannot locate home folder" });
  });

  it("restyles a deck with slides through a prompt in the composer", async () => {
    const useApp = await storeWith(DECK);
    useApp.setState({ sidebarOpen: false, sidebarTab: "files" });
    backend({ stage_template: () => STAGED });
    await useApp.getState().applyStyle("swiss");
    expect(calls("stage_template")).toEqual([{ id: DECK.id, template: "swiss" }]);
    expect(calls("apply_template")).toEqual([]);
    const text = useApp.getState().composerFill?.text ?? "";
    expect(text).toContain('"Swiss Design" style');
    expect(text).toContain(STAGED);
    expect(text).toContain('<meta name="slopslide-template" content="swiss">');
    expect(useApp.getState().sidebarOpen).toBe(true);
    expect(useApp.getState().sidebarTab).toBe("chat");
  });

  it("gives an empty deck the style directly", async () => {
    const empty = { ...DECK, slides: [] };
    const useApp = await storeWith(empty, null);
    const styled = { ...empty, template: "swiss", shellHash: "styled" };
    backend({ apply_template: () => styled });
    await useApp.getState().applyStyle("swiss");
    expect(calls("apply_template")).toEqual([{ id: DECK.id, template: "swiss" }]);
    expect(useApp.getState().deck).toEqual(styled);
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("ignores unknown templates and reports failures", async () => {
    const useApp = await storeWith(DECK);
    await useApp.getState().applyStyle("nope");
    expect(invoke).not.toHaveBeenCalled();
    backend({
      stage_template: () => {
        throw "template not found: swiss";
      },
    });
    await useApp.getState().applyStyle("swiss");
    expect(useApp.getState().error).toBe("template not found: swiss");
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("copies a layout into a deck that uses the template", async () => {
    const useApp = await storeWith({ ...DECK, template: "swiss" });
    const next = { ...DECK, template: "swiss", slides: [...DECK.slides, { id: "quote", hash: "q", hidden: false, locked: false, moved: false }] };
    backend({ add_template_slide: () => ({ deck: next, slide: "quote" }) });
    await useApp.getState().addLayoutSlide("swiss", "quote");
    expect(calls("add_template_slide")).toEqual([{ id: DECK.id, template: "swiss", slide: "quote", after: "intro" }]);
    expect(useApp.getState()).toMatchObject({ deck: next, selected: "quote", composerFill: null });
  });

  it("asks the agent for a layout from another template", async () => {
    const useApp = await storeWith({ ...DECK, template: "mine" });
    backend({ stage_template: () => STAGED });
    await useApp.getState().addLayoutSlide("swiss", "split");
    expect(calls("add_template_slide")).toEqual([]);
    const text = useApp.getState().composerFill?.text ?? "";
    expect(text).toContain("after this one");
    expect(text).toContain(`the "Split" layout of the "Swiss Design" template (slide \`split\` in \`${STAGED}\`)`);
    expect(text).toContain("this deck's design system");

    useApp.setState({ selected: null });
    await useApp.getState().addLayoutSlide("swiss", "split");
    expect(useApp.getState().composerFill?.text).toContain("at the end of the deck");
  });

  it("asks the agent to change the selected slide's layout", async () => {
    const useApp = await storeWith({ ...DECK, template: "swiss" });
    backend({ stage_template: () => STAGED });
    await useApp.getState().changeLayout("swiss", "quote");
    const same = useApp.getState().composerFill?.text ?? "";
    expect(same).toMatch(/^Change the layout of this slide to the "Quote" layout/);
    expect(same).toMatch(/keep this slide's id, its content, and its style/);
    expect(same).toMatch(/do not take over the template's style\.$/);

    // Another template's layout still keeps the slide's style.
    useApp.setState({ deck: { ...DECK, template: null } });
    await useApp.getState().changeLayout("swiss", "quote");
    expect(useApp.getState().composerFill?.text).toMatch(/keep this slide's id, its content, and its style/);
    expect(useApp.getState().composerFill?.text).toMatch(/do not take over the template's style\.$/);

    useApp.setState({ selected: null, composerFill: null });
    await useApp.getState().changeLayout("swiss", "quote");
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("does not change the layout of a locked slide", async () => {
    const useApp = await storeWith(deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)));
    backend({ stage_template: () => STAGED });
    useApp.setState({ selected: "intro", composerFill: null });
    await useApp.getState().changeLayout("swiss", "quote");
    expect(useApp.getState().composerFill).toBeNull();
    expect(calls("stage_template")).toEqual([]);
  });

  it("saves the deck as a template and reloads the list", async () => {
    const useApp = await storeWith(DECK);
    const created = { id: "/decks/talk/deck.html", title: "Talk", builtin: false, path: "/t/talk", slides: ["intro"] };
    backend({ create_template: () => created, list_templates: () => [created, MINE, SWISS] });
    expect(await useApp.getState().saveAsTemplate("Talk")).toEqual(created);
    expect(calls("create_template")).toEqual([{ id: DECK.id, name: "Talk" }]);
    expect(useApp.getState().templates).toEqual([created, MINE, SWISS]);

    backend({
      create_template: () => {
        throw "The deck has no slides to make a template from.";
      },
    });
    expect(await useApp.getState().saveAsTemplate("Talk")).toBeNull();
    expect(useApp.getState().error).toBe("The deck has no slides to make a template from.");
  });
});

describe("changing the slide size", () => {
  const PORTRAIT = { width: 1080, height: 1350, unit: "px" as const };
  const resized = (size = PORTRAIT) => ({ ...DECK, shellHash: "shell-2", size: { ...size, pixelWidth: 1080, pixelHeight: 1350 } });

  it("resizes the slides, then prepares a message asking the agent to lay them out again", async () => {
    const { useApp } = await freshModule();
    backend({ set_slide_size: () => resized() });
    useApp.setState({ deck: DECK, sidebarOpen: false, composerFill: null, running: false });
    await useApp.getState().resizeSlides(PORTRAIT);
    expect(calls("set_slide_size")).toEqual([{ id: "/decks/talk/deck.html", size: PORTRAIT }]);
    expect(useApp.getState().deck?.size).toMatchObject(PORTRAIT);
    expect(calls("send_message")).toEqual([]);
    const fill = useApp.getState().composerFill;
    expect(useApp.getState().sidebarOpen).toBe(true);
    expect(fill?.text).toContain("from landscape, 1920 × 1080 px to portrait, 1080 × 1350 px");
    expect(fill?.text).toContain("Re-lay out every slide");
  });

  it("does not prompt for a deck without slides", async () => {
    const { useApp } = await freshModule();
    const empty = { ...DECK, slides: [] };
    backend({ set_slide_size: () => ({ ...resized(), slides: [] }) });
    useApp.setState({ deck: empty, composerFill: null });
    await useApp.getState().resizeSlides(PORTRAIT);
    expect(calls("set_slide_size")).toHaveLength(1);
    expect(useApp.getState().deck?.size).toMatchObject(PORTRAIT);
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("leaves the deck alone for the same size, or while the agent works", async () => {
    const { useApp } = await freshModule();
    backend({ set_slide_size: () => resized() });
    useApp.setState({ deck: DECK, composerFill: null, running: false });
    await useApp.getState().resizeSlides({ width: 1920, height: 1080, unit: "px" });
    useApp.setState({ running: true });
    await useApp.getState().resizeSlides(PORTRAIT);
    expect(calls("set_slide_size")).toEqual([]);
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("shows the backend's refusal", async () => {
    const { useApp } = await freshModule();
    backend({
      set_slide_size: () => {
        throw "A slide must be 100 to 10000 pixels on each side";
      },
    });
    useApp.setState({ deck: DECK, composerFill: null, error: null, running: false });
    await useApp.getState().resizeSlides({ width: 1, height: 1, unit: "in" });
    expect(useApp.getState().error).toContain("100 to 10000");
    expect(useApp.getState().deck).toBe(DECK);
    expect(useApp.getState().composerFill).toBeNull();
  });
});

describe("workspace conversations", () => {
  it.each([
    [null, "No file open"],
    [{ path: "site/index.html", absolute: "/decks/talk/site/index.html", kind: "webpage" as const }, "Open file: site/index.html (web page)"],
    [{ path: "notes.md", absolute: "/decks/talk/notes.md", kind: "file" as const }, "Open file: notes.md (file)"],
  ])("sends without a deck and describes the open file %j", async (openedFile, context) => {
    const useApp = await freshStore();
    useApp.setState({ deck: null, openedFile });
    await useApp.getState().send("Make a deck from notes.md", { includeSlide: true, attachments: ["assets/notes.md"] });
    expect(calls("send_message")[0]!.args).toMatchObject({ workspace: "/decks/talk", prompt: `[context]\n${context}\nAttached files: assets/notes.md\n[/context]\n\nMake a deck from notes.md` });
    expect(useApp.getState().messages[0]).toMatchObject({ slide: null, sketch: null });
  });

  it("keeps a running conversation and approvals when switching files, and routes openFile through openPath", async () => {
    const { useApp, initEventBridge } = await freshModule();
    backend({ open_file: ({ path }) => ({ path, absolute: `/decks/talk/${path}`, kind: "webpage" }) });
    useApp.setState({ deck: DECK, messages: [userMessage("hi"), assistantMessage({ status: "streaming" })], running: true });
    await initEventBridge();
    listeners.get("agent-event")!({ payload: { workspace: "/other", event: { type: "openFile", path: "outside.html" } } });
    expect(calls("open_file")).toEqual([]);
    listeners.get("agent-event")!({ payload: { workspace: "/decks/talk", event: { type: "openFile", path: "site/index.html" } } });
    await vi.waitFor(() => expect(useApp.getState().openedFile?.path).toBe("site/index.html"));
    expect(useApp.getState()).toMatchObject({ deck: null, running: true });
    expect(useApp.getState().messages).toHaveLength(2);
    expect(calls("interrupt_agent")).toEqual([]);
    listeners.get("agent-event")!({ payload: { workspace: "/decks/talk", event: { type: "textDelta", text: "Still here" } } });
    expect((useApp.getState().messages[1] as AssistantMessage).parts).toEqual([{ kind: "text", text: "Still here" }]);
  });
});
