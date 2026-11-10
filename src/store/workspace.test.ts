import { beforeEach, describe, expect, it, vi } from "vitest";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask, invoke } from "../test/tauri";
import type { AssistantMessage, ChatMessage } from "./messages";
import { assistantMessage, backend, calls, DECK, freshStore, type Handler, resetBackend, userMessage } from "./testing";

beforeEach(resetBackend);

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
        const kinds: Record<string, string> = {
          "talks/q3.html": "deck",
          "site/index.html": "webpage",
          "notes.md": "file",
        };
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
    expect(useApp.getState().openedFile).toEqual({
      path: "talks/q3.html",
      absolute: "/ws/talks/q3.html",
      kind: "deck",
    });

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
    expect(useApp.getState()).toMatchObject({
      workspace: { path: "/other", name: "other" },
      deck: null,
      openedFile: null,
    });
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
    expect(useApp.getState().openedFile).toEqual({
      path: "new-deck/deck.html",
      absolute: "/ws/new-deck/deck.html",
      kind: "deck",
    });
    expect(localStorage.getItem("slopslide.lastFile:/ws")).toBe("new-deck/deck.html");
  });
});

describe("closing a deck with unsaved HTML edits", () => {
  it("closes immediately when there are no edits", async () => {
    const useApp = await freshStore();
    useApp.setState({
      deck: deckFor(DECK_HTML),
      codeDirty: false,
      sketches: { intro: [{ tool: "pen", color: "#fff", points: [[0, 0]] }] },
    });
    useApp.setState({ openedFile: { path: "talk/deck.html", absolute: DECK.id, kind: "deck" } });
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

describe("opening and creating decks", () => {
  it("openDeck loads the deck, its chat and whether the agent is running", async () => {
    const useApp = await freshStore(false);
    const chat: ChatMessage[] = [userMessage("hi"), assistantMessage()];
    backend({
      open_workspace: () => ({ path: "/decks/talk", name: "talk" }),
      open_deck: () => DECK,
      load_chat: () => chat,
      agent_running: () => true,
    });
    useApp.setState({
      assetsRev: 4,
      presenting: true,
      selected: "stale",
      sketches: { intro: [{ tool: "pen", color: "#fff", points: [[0, 0]] }] },
    });
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
    backend({
      open_workspace: () => ({ path: "/decks/talk", name: "talk" }),
      open_deck: () => DECK,
      load_chat: () => [userMessage("hi"), streaming],
      agent_running: () => false,
    });
    await useApp.getState().openWorkspace("/decks/talk");
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(useApp.getState().messages[1]).toEqual({
      ...streaming,
      status: "interrupted",
      thinking: false,
      compacting: false,
    });
  });

  it("starts with an empty transcript when the chat file is missing or not a list", async () => {
    const useApp = await freshStore(false);
    backend({
      open_workspace: () => ({ path: "/decks/talk", name: "talk" }),
      open_deck: () => DECK,
      load_chat: () => null,
      agent_running: () => false,
    });
    useApp.setState({ messages: [userMessage("old deck")] });
    await useApp.getState().openWorkspace("/decks/talk");
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(useApp.getState().messages).toEqual([]);
    await useApp.getState().closeWorkspace();
    backend({
      open_workspace: () => ({ path: "/decks/talk", name: "talk" }),
      open_deck: () => DECK,
      load_chat: () => ({ bogus: true }),
      agent_running: () => false,
    });
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
    useApp.setState({
      deck: DECK,
      selected: "intro",
      messages: [userMessage("x")],
      running: true,
      presenting: true,
      collapsedSections: ["#2"],
    });
    await useApp.getState().closeDeck();
    expect(useApp.getState()).toMatchObject({
      deck: null,
      selected: null,
      collapsedSections: [],
      messages: [userMessage("x")],
      running: true,
      presenting: false,
    });
  });
});

describe("the agent's turn when the workspace closes and opens", () => {
  it("stops a Codex turn and saves a closed transcript before leaving the workspace", async () => {
    const store = await freshStore();
    store.setState({
      deck: deckFor(DECK_HTML),
      running: true,
      messages: [
        assistantMessage({
          provider: "codex",
          status: "streaming",
          parts: [
            {
              kind: "approval",
              status: "pending",
              approval: {
                id: "live",
                title: "Run",
                reason: null,
                details: "ls",
                acceptLabel: "Allow once",
                decisions: ["accept"],
              },
            },
          ],
        }),
      ],
    });
    await store.getState().closeWorkspace();
    const order = invoke.mock.calls.map(([command]) => command);
    expect(order.indexOf("interrupt_agent")).toBeLessThan(order.indexOf("save_chat"));
    expect(calls("save_chat")[0]!.chat).toMatchObject([{ status: "interrupted", parts: [{ status: "expired" }] }]);
    expect(store.getState().deck).toBeNull();
  });

  it("keeps the existing background behavior for other providers", async () => {
    const store = await freshStore();
    store.setState({
      deck: deckFor(DECK_HTML),
      running: true,
      messages: [assistantMessage({ provider: "claude", status: "streaming" })],
    });
    await store.getState().closeDeck();
    expect(calls("interrupt_agent")).toHaveLength(0);
  });

  it("restored approvals are closed rather than reusable", async () => {
    const store = await freshStore(false);
    const message = assistantMessage({
      status: "streaming",
      parts: [
        {
          kind: "approval",
          status: "pending",
          approval: {
            id: "old",
            title: "Run",
            reason: null,
            details: "ls",
            acceptLabel: "Allow once",
            decisions: ["accept"],
          },
        },
      ],
    });
    backend({
      open_workspace: () => ({ path: "/decks/talk", name: "talk" }),
      open_deck: () => deckFor(DECK_HTML),
      load_chat: () => [message],
      agent_running: () => false,
    });
    await store.getState().openWorkspace("/decks/talk");
    await store.getState().openDeck("/decks/talk/deck.html");
    expect((store.getState().messages[0] as AssistantMessage).parts[0]).toMatchObject({ status: "expired" });
  });
});
