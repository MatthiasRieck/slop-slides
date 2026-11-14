import { beforeEach, describe, expect, it, vi } from "vitest";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask, invoke } from "../test/tauri";
import { answerUnsaved, unsavedAsked } from "../test/unsaved";
import { lastError } from "./errors";
import type { AssistantMessage, ChatMessage } from "./messages";
import {
  assistantMessage,
  backend,
  calls,
  DECK,
  freshModule,
  freshStore,
  type Handler,
  resetBackend,
  userMessage,
} from "./testing";

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
    expect(calls("open_deck")).toEqual([{ id: "/ws/talks/q3.html", keepChat: false, quiet: false }]);
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
    expect(calls("close_deck")).toHaveLength(1);

    await useApp.getState().openPath("site/index.html");
    expect(calls("open_file")).toHaveLength(2);
  });

  it("reports a file that cannot be opened and keeps the open one", async () => {
    const useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openWorkspace("/ws");
    await useApp.getState().openPath("notes.md");
    await useApp.getState().openPath("gone.html");
    expect(lastError(useApp.getState())).toBe("file not found: gone.html");
    expect(useApp.getState().openedFile).toEqual(opened("notes.md", "file"));
  });

  it("keeps the deck open when the user keeps unsaved HTML edits", async () => {
    const useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openWorkspace("/ws");
    await useApp.getState().openPath("talks/q3.html");
    useApp.setState({ codeDirty: true });
    const opening = useApp.getState().openPath("site/index.html");
    expect(await answerUnsaved("cancel")).toBe("q3.html");
    await opening;
    expect(useApp.getState().deck).toEqual(TALK);
    const closing = useApp.getState().closeWorkspace();
    await answerUnsaved("cancel");
    expect(await closing).toBe(false);
    expect(useApp.getState().workspace).toEqual(WS);
    expect(calls("close_workspace")).toEqual([]);
  });

  it("opens a deck file in its folder, or in the folder it was open in before", async () => {
    let useApp = await freshStore(false);
    workspaceBackend();
    await useApp.getState().openDeckFile("/ws/talks/q3.html", "/ws");
    expect(calls("open_workspace")).toEqual([{ path: "/ws" }]);
    expect(calls("open_file")).toEqual([{ path: "talks/q3.html" }]);
    expect(useApp.getState().deck).toEqual(TALK);

    // Without a folder given, the one the file is in becomes the workspace.
    useApp = await freshStore(false);
    resetBackend();
    workspaceBackend({ open_file: ({ path }) => ({ path, absolute: `/ws/talks/${String(path)}`, kind: "deck" }) });
    await useApp.getState().openDeckFile("/ws/talks/q3.html");
    expect(calls("open_workspace")).toEqual([{ path: "/ws/talks" }]);
    expect(calls("open_file")).toEqual([{ path: "q3.html" }]);
  });

  it("opens no deck file when its folder does not open", async () => {
    const useApp = await freshStore(false);
    workspaceBackend({
      open_workspace: () => {
        throw "ws is already open in another window.";
      },
    });
    await useApp.getState().openDeckFile("/ws/talks/q3.html", "/ws");
    expect(lastError(useApp.getState())).toBe("ws is already open in another window.");
    expect(calls("open_file")).toEqual([]);
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
    expect(lastError(useApp.getState())).toBeNull();
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
    expect(lastError(useApp.getState())).toBe("not a folder: /nope");
  });

  describe("reopening the deck last open in a folder", () => {
    const remembered = () => localStorage.setItem("slopslide.lastFile:/ws", "talks/q3.html");

    it("loads the deck's chat only: the folder's own would give way to it at once", async () => {
      const useApp = await freshStore(false);
      workspaceBackend({ load_chat: ({ id }) => (id === TALK.id ? [userMessage("about the talk")] : null) });
      remembered();
      await useApp.getState().openWorkspace("/ws");
      expect(calls("load_chat")).toEqual([{ id: TALK.id }]);
      expect(calls("session_provider")).toEqual([{ id: TALK.id }]);
      expect(calls("open_deck")).toEqual([{ id: TALK.id, keepChat: false, quiet: true }]);
      expect(useApp.getState()).toMatchObject({
        workspace: WS,
        openedFile: { path: "talks/q3.html", kind: "deck" },
        deck: TALK,
        selected: TALK.slides[0]!.id,
        chatKey: TALK.id,
        messages: [userMessage("about the talk")],
      });
    });

    it("shows the folder and its deck together, never the folder without the deck", async () => {
      const useApp = await freshStore(false);
      workspaceBackend();
      remembered();
      /** What the main area would have shown, at every change of the store. */
      const shown = new Set<string>();
      useApp.subscribe(({ workspace, deck }) => shown.add(workspace ? (deck ? "deck" : "no deck") : "start screen"));
      await useApp.getState().openWorkspace("/ws");
      expect([...shown]).toEqual(["deck"]);
      // The tab on show stays: only a folder with nothing to reopen starts at its files.
      expect(useApp.getState().sidebarTab).not.toBe("files");
    });

    it("asks what the file is and whether the folder's agent works at the same time", async () => {
      const useApp = await freshStore(false);
      const asked: string[] = [];
      let answer = () => {};
      const held = new Promise<void>((resolve) => (answer = resolve));
      workspaceBackend({
        open_file: async ({ path }) => {
          asked.push("open_file");
          await held;
          return opened(String(path), "deck");
        },
        agent_running: async () => {
          asked.push("agent_running");
          await held;
          return false;
        },
      });
      remembered();
      const opening = useApp.getState().openWorkspace("/ws");
      await vi.waitFor(() => expect(asked).toEqual(["open_file", "agent_running"]));
      answer();
      await opening;
      expect(useApp.getState().deck).toEqual(TALK);
    });

    it("keeps the folder's chat on show while its agent is still at work", async () => {
      const useApp = await freshStore(false);
      workspaceBackend({ agent_running: ({ id }) => id === "/ws" });
      remembered();
      await useApp.getState().openWorkspace("/ws");
      expect(calls("open_deck")).toEqual([]);
      expect(calls("load_chat")).toEqual([{ id: "/ws" }]);
      expect(useApp.getState()).toMatchObject({ workspace: WS, deck: null, chatKey: "/ws", running: true });
      expect(useApp.getState().sidebarTab).toBe("files");
      // The deck is still the one to come back to.
      expect(localStorage.getItem("slopslide.lastFile:/ws")).toBe("talks/q3.html");
    });

    it("starts at the files, with the folder's chat, when the deck is open in another window", async () => {
      const useApp = await freshStore(false);
      workspaceBackend({ open_deck: () => Promise.reject("open in another window") });
      remembered();
      await useApp.getState().openWorkspace("/ws");
      expect(useApp.getState()).toMatchObject({ workspace: WS, deck: null, openedFile: null, chatKey: "/ws" });
      expect(useApp.getState().sidebarTab).toBe("files");
      expect(lastError(useApp.getState())).toBeNull();
    });

    it("shows a page that is no deck with the folder, in one step, beside the folder's chat", async () => {
      const useApp = await freshStore(false);
      workspaceBackend();
      localStorage.setItem("slopslide.lastFile:/ws", "site/index.html");
      const shown = new Set<string>();
      useApp.subscribe(({ workspace, openedFile }) => workspace && shown.add(openedFile?.path ?? "no file"));
      await useApp.getState().openWorkspace("/ws");
      expect([...shown]).toEqual(["site/index.html"]);
      expect(calls("load_chat")).toEqual([{ id: "/ws" }]);
      expect(useApp.getState().chatKey).toBe("/ws");
    });

    it("forgets a file that is gone since", async () => {
      const useApp = await freshStore(false);
      workspaceBackend();
      localStorage.setItem("slopslide.lastFile:/ws", "gone.html");
      await useApp.getState().openWorkspace("/ws");
      expect(localStorage.getItem("slopslide.lastFile:/ws")).toBeNull();
      expect(useApp.getState()).toMatchObject({ workspace: WS, openedFile: null, sidebarTab: "files" });
    });
  });

  it("creates decks in the open folder and opens them", async () => {
    const useApp = await freshStore(false);
    workspaceBackend({ open_deck: ({ id }) => ({ ...TALK, id, path: id }) });
    await useApp.getState().openWorkspace("/ws");
    await useApp.getState().createDeck("New deck");
    expect(calls("create_deck")).toEqual([{ title: "New deck", template: null }]);
    expect(useApp.getState().openedFile).toEqual({
      path: "new-deck/deck.html",
      absolute: "/ws/new-deck/deck.html",
      kind: "deck",
    });
    expect(localStorage.getItem("slopslide.lastFile:/ws")).toBe("new-deck/deck.html");
    expect(useApp.getState().chatKey).toBe("/ws/new-deck/deck.html");
  });
});

describe("each deck's own chat", () => {
  const A = { ...deckFor(DECK_HTML), id: "/ws/a.html", path: "/ws/a.html" };
  const B = { ...A, id: "/ws/b.html", path: "/ws/b.html" };
  const said = (text: string): ChatMessage[] => [userMessage(text), assistantMessage()];

  beforeEach(() => localStorage.clear());

  /** The workspace `/ws` open, with the decks `a.html` and `b.html`, each with a chat. */
  async function inWorkspace(extra: Record<string, Handler> = {}) {
    const useApp = await freshStore(false);
    backend({
      open_workspace: ({ path }) => ({ path, name: "ws" }),
      open_file: ({ path }) => ({
        path,
        absolute: `/ws/${String(path)}`,
        kind: String(path) === "page.html" ? "webpage" : "deck",
      }),
      open_deck: ({ id }) => ({ ...A, id, path: id }),
      load_chat: ({ id }) => (id === A.id ? said("about a") : id === B.id ? said("about b") : said("about the folder")),
      agent_running: () => false,
      ...extra,
    });
    await useApp.getState().openWorkspace("/ws");
    return useApp;
  }

  it("shows the folder's chat until a deck opens, then the deck's, and the folder's again when it closes", async () => {
    const useApp = await inWorkspace();
    expect(useApp.getState()).toMatchObject({ chatKey: "/ws", messages: said("about the folder") });
    await useApp.getState().openPath("a.html");
    expect(useApp.getState()).toMatchObject({ chatKey: A.id, messages: said("about a") });
    expect(calls("save_chat")).toEqual([{ id: "/ws", chat: said("about the folder") }]);

    await useApp.getState().openPath("b.html");
    expect(useApp.getState()).toMatchObject({ chatKey: B.id, messages: said("about b"), deck: B });
    expect(calls("save_chat").at(-1)).toEqual({ id: A.id, chat: said("about a") });

    expect(await useApp.getState().closeDeck()).toBe(true);
    expect(calls("close_deck")).toHaveLength(1);
    expect(useApp.getState()).toMatchObject({ chatKey: "/ws", messages: said("about the folder"), deck: null });
  });

  it("starts no session for a chat nothing was said in", async () => {
    const useApp = await inWorkspace({ load_chat: () => null });
    await useApp.getState().openPath("a.html");
    await useApp.getState().openPath("b.html");
    expect(calls("save_chat")).toEqual([]);
  });

  it("asks before leaving a deck the agent is working on, and stays when the user cancels", async () => {
    const useApp = await inWorkspace({ agent_running: ({ id }) => id === A.id });
    await useApp.getState().openPath("a.html");
    expect(useApp.getState().running).toBe(true);

    ask.mockResolvedValue(false);
    expect(await useApp.getState().openDeck(B.id)).toBe(false);
    expect(await useApp.getState().closeDeck()).toBe(false);
    expect(await useApp.getState().closeWorkspace()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask.mock.calls[0]![0]).toBe("The agent is still working in the chat of a.html. Stop it to go on?");
    expect(useApp.getState()).toMatchObject({ deck: { id: A.id }, chatKey: A.id, running: true });
    expect(calls("interrupt_agent")).toEqual([]);
    expect(calls("open_deck")).toHaveLength(1);
  });

  it("stops the agent and saves its chat when the user leaves the deck anyway", async () => {
    const useApp = await inWorkspace({ agent_running: ({ id }) => id === A.id });
    await useApp.getState().openPath("a.html");
    useApp.setState({ messages: [userMessage("go"), assistantMessage({ status: "streaming" })] });
    ask.mockResolvedValue(true);
    expect(await useApp.getState().openDeck(B.id)).toBe(true);
    expect(calls("interrupt_agent")).toEqual([{ id: A.id }]);
    expect(calls("save_chat").at(-1)).toMatchObject({ id: A.id, chat: [{}, { status: "interrupted" }] });
    const order = invoke.mock.calls.map(([command]) => command);
    expect(order.indexOf("interrupt_agent")).toBeLessThan(order.lastIndexOf("save_chat"));
    expect(order.lastIndexOf("save_chat")).toBeLessThan(order.lastIndexOf("open_deck"));
    expect(useApp.getState()).toMatchObject({ deck: { id: B.id }, chatKey: B.id, running: false });
  });

  it("leaves a deck that is gone, though its chat cannot be saved", async () => {
    const useApp = await inWorkspace({
      save_chat: ({ id }) => {
        if (id === A.id) throw "not a deck or a folder: /ws/a.html";
      },
    });
    await useApp.getState().openPath("a.html");
    expect(await useApp.getState().openDeck(B.id)).toBe(true);
    expect(useApp.getState()).toMatchObject({ deck: { id: B.id }, chatKey: B.id, toasts: [] });
  });

  it("keeps the open deck and its chat when the next one is open in another window", async () => {
    const useApp = await inWorkspace({
      open_deck: ({ id }) => {
        if (id === B.id) throw "b.html is already open in another window.";
        return A;
      },
    });
    await useApp.getState().openPath("a.html");
    expect(await useApp.getState().openDeck(B.id)).toBe(false);
    expect(lastError(useApp.getState())).toBe("b.html is already open in another window.");
    expect(useApp.getState()).toMatchObject({ deck: A, chatKey: A.id, messages: said("about a") });
    expect(useApp.getState().openedFile?.path).toBe("a.html");
  });

  it("starts at the files, without a word, when the deck last open is open in another window", async () => {
    localStorage.setItem("slopslide.lastFile:/ws", "a.html");
    const useApp = await inWorkspace({
      open_deck: () => {
        throw "a.html is already open in another window.";
      },
    });
    expect(calls("open_deck")).toEqual([{ id: A.id, keepChat: false, quiet: true }]);
    expect(useApp.getState()).toMatchObject({ deck: null, openedFile: null, toasts: [], sidebarTab: "files" });
    expect(useApp.getState().chatKey).toBe("/ws");
    expect(localStorage.getItem("slopslide.lastFile:/ws")).toBe("a.html");
  });

  it("keeps the deck open when another window shows the folder's own chat", async () => {
    const useApp = await inWorkspace({
      close_deck: () => {
        throw "ws is already open without a deck in another window. Open the next file there.";
      },
    });
    await useApp.getState().openPath("a.html");
    expect(await useApp.getState().closeDeck()).toBe(false);
    await useApp.getState().openPath("page.html");
    expect(lastError(useApp.getState())).toMatch(/^ws is already open without a deck/);
    expect(useApp.getState()).toMatchObject({ deck: A, chatKey: A.id });
    expect(useApp.getState().openedFile?.path).toBe("a.html");
  });

  it("goes on with a deck's past conversation in its deck", async () => {
    const useApp = await inWorkspace({
      select_chat_thread: () => ({ chat: said("earlier, about b"), provider: null }),
    });
    await useApp.getState().openPath("a.html");
    await useApp.getState().selectChatThread("t1", B.id);
    expect(useApp.getState()).toMatchObject({ deck: { id: B.id }, chatKey: B.id });
    expect(calls("select_chat_thread")).toEqual([{ id: B.id, thread: "t1" }]);
    expect(useApp.getState().messages).toEqual(said("earlier, about b"));

    // Any other conversation moves to the chat on show.
    await useApp.getState().selectChatThread("t2", null);
    expect(calls("select_chat_thread").at(-1)).toEqual({ id: B.id, thread: "t2" });
    expect(useApp.getState().deck).toMatchObject({ id: B.id });
  });

  it("does not go on with a deck's conversation when its deck cannot open", async () => {
    const useApp = await inWorkspace({
      open_deck: ({ id }) => {
        if (id === B.id) throw "b.html is already open in another window.";
        return A;
      },
    });
    await useApp.getState().openPath("a.html");
    await useApp.getState().selectChatThread("t1", B.id);
    expect(calls("select_chat_thread")).toEqual([]);
    expect(useApp.getState().chatKey).toBe(A.id);
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
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    const closing = useApp.getState().closeDeck();
    expect(await answerUnsaved("cancel")).toBe("deck.html");
    expect(await closing).toBe(false);
    expect(await unsavedAsked()).toBe(false);
    expect(ask).not.toHaveBeenCalled();
    expect(useApp.getState().deck).not.toBeNull();
    expect(useApp.getState().codeDirty).toBe(true);
  });

  it("closes and clears the dirty flag when the user does not save", async () => {
    const { useApp, provideCodeSave } = await freshModule();
    const save = vi.fn(async () => {});
    provideCodeSave(save);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    const closing = useApp.getState().closeDeck();
    await answerUnsaved("discard");
    expect(await closing).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(useApp.getState().deck).toBeNull();
    expect(useApp.getState().codeDirty).toBe(false);
  });

  it("saves the edits through the HTML tab's editor, then closes", async () => {
    const { useApp, provideCodeSave } = await freshModule();
    const save = vi.fn(async () => useApp.getState().setCodeDirty(false));
    provideCodeSave(save);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    const closing = useApp.getState().closeDeck();
    await answerUnsaved("save");
    expect(await closing).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(useApp.getState().deck).toBeNull();
  });

  it("stays open, on the HTML tab, when the edits could not be saved", async () => {
    const { useApp, provideCodeSave } = await freshModule();
    // The file changed on disk meanwhile: the editor keeps the edits and says so.
    provideCodeSave(async () => {});
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true, sidebarTab: "chat", sidebarTabs: ["chat", "code"] });
    const closing = useApp.getState().closeDeck();
    await answerUnsaved("save");
    expect(await closing).toBe(false);
    expect(useApp.getState().deck).not.toBeNull();
    expect(useApp.getState().sidebarTab).toBe("code");
  });

  it("does not save through an editor that is gone", async () => {
    const { useApp, provideCodeSave } = await freshModule();
    const save = vi.fn(async () => useApp.getState().setCodeDirty(false));
    provideCodeSave(save)();
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    const closing = useApp.getState().closeDeck();
    await answerUnsaved("save");
    expect(await closing).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("asks one question at a time: asked again, the first is cancelled", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    const first = useApp.getState().closeDeck();
    await vi.waitFor(async () => expect(await unsavedAsked()).toBe(true));
    const second = useApp.getState().closeDeck();
    expect(await first).toBe(false);
    await answerUnsaved("discard");
    expect(await second).toBe(true);
  });
});

describe("renaming a deck", () => {
  it("gives the deck its new title, trimmed", async () => {
    const useApp = await freshStore();
    backend({ rename_deck: ({ title }) => ({ ...DECK, title }) });
    useApp.setState({ deck: DECK });
    expect(await useApp.getState().renameDeck("  Board update  ")).toBe(true);
    expect(calls("rename_deck")).toEqual([{ id: DECK.id, title: "Board update" }]);
    expect(useApp.getState().deck?.title).toBe("Board update");
  });

  it("takes no empty title, and leaves an unchanged one alone", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK });
    expect(await useApp.getState().renameDeck("   ")).toBe(false);
    expect(await useApp.getState().renameDeck(` ${DECK.title} `)).toBe(true);
    expect(calls("rename_deck")).toEqual([]);
  });

  it("says why a deck could not be renamed, and keeps its title", async () => {
    const useApp = await freshStore();
    backend({
      rename_deck: () => {
        throw "the deck file is read-only";
      },
    });
    useApp.setState({ deck: DECK });
    expect(await useApp.getState().renameDeck("Other")).toBe(false);
    expect(lastError(useApp.getState())).toBe("the deck file is read-only");
    expect(useApp.getState().deck?.title).toBe(DECK.title);
  });

  it("renames nothing without a deck", async () => {
    const useApp = await freshStore();
    expect(await useApp.getState().renameDeck("Other")).toBe(false);
    expect(calls("rename_deck")).toEqual([]);
  });
});

describe("opening and creating decks", () => {
  it("openDeck loads the deck, its chat and whether the agent is running", async () => {
    const useApp = await freshStore(false);
    const chat: ChatMessage[] = [userMessage("hi"), assistantMessage()];
    backend({
      open_workspace: () => ({ path: "/decks/talk", name: "talk" }),
      open_deck: () => DECK,
      load_chat: ({ id }) => (id === DECK.id ? chat : null),
      agent_running: ({ id }) => id === DECK.id,
    });
    useApp.setState({
      assetsRev: 4,
      presenting: true,
      selected: "stale",
      sketches: { intro: [{ tool: "pen", color: "#fff", points: [[0, 0]] }] },
    });
    await useApp.getState().openWorkspace("/decks/talk");
    await useApp.getState().openDeck("/decks/talk/deck.html");
    expect(calls("open_deck")).toEqual([{ id: "/decks/talk/deck.html", keepChat: false, quiet: false }]);
    expect(calls("load_chat")).toEqual([{ id: "/decks/talk" }, { id: "/decks/talk/deck.html" }]);
    expect(calls("agent_running").at(-1)).toEqual({ id: "/decks/talk/deck.html" });
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
    expect(lastError(useApp.getState())).toBe("deck not found: talk");
    expect(useApp.getState().deck).toBeNull();
  });

  it("createDeck creates and opens the new deck", async () => {
    const useApp = await freshStore();
    backend({ create_deck: () => DECK, open_deck: () => DECK, load_chat: () => null, agent_running: () => false });
    await useApp.getState().createDeck("Talk");
    expect(calls("create_deck")).toEqual([{ title: "Talk", template: null }]);
    // Opened like any deck: the window has it, and its chat is on show.
    expect(calls("open_deck")).toEqual([{ id: DECK.id, keepChat: false, quiet: false }]);
    expect(useApp.getState().deck).toEqual(DECK);
    expect(useApp.getState().chatKey).toBe(DECK.id);
  });

  it("createDeck reports failures", async () => {
    const useApp = await freshStore();
    backend({
      create_deck: () => {
        throw new Error("disk full");
      },
    });
    await useApp.getState().createDeck("Talk");
    expect(lastError(useApp.getState())).toBe("disk full");
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
    ask.mockResolvedValue(true);
    await store.getState().closeWorkspace();
    const order = invoke.mock.calls.map(([command]) => command);
    expect(order.indexOf("interrupt_agent")).toBeLessThan(order.indexOf("save_chat"));
    expect(calls("save_chat")[0]!.chat).toMatchObject([{ status: "interrupted", parts: [{ status: "expired" }] }]);
    expect(store.getState()).toMatchObject({ deck: null, workspace: null, chatKey: null, running: false });
  });

  it("keeps the turn of the folder's chat running when its deck closes", async () => {
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
