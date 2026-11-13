import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Deck } from "../lib/api";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask, invoke } from "../test/tauri";
import { lastError } from "./errors";
import type { AssistantMessage, ChatMessage } from "./messages";
import {
  assistantMessage,
  backend,
  calls,
  DECK,
  freshModule,
  listeners,
  resetBackend,
  userMessage,
  withBridge,
} from "./testing";

beforeEach(resetBackend);

describe("agent events", () => {
  async function bridged(
    messages: ChatMessage[] = [userMessage("hi"), assistantMessage({ status: "streaming", thinking: true })],
  ) {
    const { useApp, emit } = await withBridge();
    useApp.setState({ deck: DECK, messages, running: true });
    const reply = () => useApp.getState().messages.findLast((m) => m.role === "assistant") as AssistantMessage;
    return { useApp, emit, reply };
  }

  it("tracks approvals, resolves only the matching request, and expires unanswered requests", async () => {
    const { emit, reply } = await bridged();
    const approval = {
      id: "r1",
      title: "Run",
      reason: null,
      details: "ls",
      acceptLabel: "Allow once",
      decisions: ["accept", "decline"] as const,
    };
    emit({ type: "approvalRequested", approval: { ...approval, decisions: [...approval.decisions] } });
    emit({ type: "approvalRequested", approval: { ...approval, id: "r2", decisions: [...approval.decisions] } });
    emit({ type: "approvalResolved", id: "r1" });
    expect(reply().parts).toMatchObject([{ status: "resolved" }, { status: "pending" }]);
    emit({ type: "finished", interrupted: true });
    expect(reply().parts).toMatchObject([{ status: "resolved" }, { status: "expired" }]);
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

  it("opens the folder from Finder waiting for this window, at start and when told", async () => {
    const store = await freshModule(false);
    let pending: string | null = "/decks/a";
    backend({
      take_pending_folder: () => {
        const path = pending;
        pending = null;
        return path;
      },
      open_workspace: ({ path }) => ({ path, name: String(path).split("/").pop() }),
    });
    await store.initEventBridge();
    await vi.waitFor(() => expect(store.useApp.getState().workspace?.path).toBe("/decks/a"));
    expect(calls("open_workspace")).toEqual([{ path: "/decks/a" }]);

    // Another window's folder: this one has none waiting.
    listeners.get("folder-pending")?.({ payload: null });
    await vi.waitFor(() => expect(calls("take_pending_folder")).toHaveLength(2));
    expect(calls("open_workspace")).toHaveLength(1);
  });

  it("reports a folder from Finder that cannot be opened", async () => {
    const store = await freshModule(false);
    backend({
      take_pending_folder: () => {
        throw "no such window";
      },
    });
    await store.initEventBridge();
    expect(lastError(store.useApp.getState())).toBe("no such window");
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
    const { useApp, emit } = await bridged([
      first,
      userMessage("again"),
      assistantMessage({ id: "a-1", status: "streaming" }),
    ]);
    emit({ type: "textDelta", text: "new" });
    expect(useApp.getState().messages[0]).toEqual(first);
  });

  describe("context usage", () => {
    it("falls back to the selected provider for replies saved before providers were recorded", async () => {
      const { useApp, emit, reply } = await bridged();
      useApp.setState({ selection: { ...useApp.getState().selection, provider: "copilot" } });
      emit({ type: "usage", contextTokens: 1, contextWindow: 2 });
      expect(reply().context).toEqual({ provider: "copilot", tokens: 1, window: 2 });
    });

    it("shows compaction, forgets the old size, and settles when the turn ends", async () => {
      const earlier = assistantMessage({
        id: "a-0",
        provider: "claude",
        context: { provider: "claude", tokens: 90_000, window: 200_000 },
      });
      const { emit, reply } = await bridged([
        earlier,
        userMessage("/compact"),
        assistantMessage({ id: "a-1", status: "streaming", thinking: true, provider: "claude" }),
      ]);
      emit({ type: "compacting" });
      expect(reply()).toMatchObject({ compacting: true, thinking: false });
      emit({ type: "compacted" });
      expect(reply()).toMatchObject({
        compacting: false,
        compacted: true,
        context: { provider: "claude", tokens: null, window: 200_000 },
      });
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
    const { useApp } = await withBridge({ load_deck: () => next() });
    useApp.setState({
      workspace: { path: "/decks", name: "decks" },
      chatKey: "/decks",
      openedFile: { path: "talk/deck.html", absolute: DECK.id, kind: "deck" },
      deck: DECK,
      selected: "intro",
      running: false,
      assetsRev: 0,
    });
    const changedIn = (root: string, paths: string[]) =>
      listeners.get("workspace-changed")!({ payload: { root, paths } });
    const changed = (paths: string[]) =>
      changedIn(
        "/decks",
        paths.map((p) => `talk/${p}`),
      );
    return { useApp, changed, changedIn };
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

  it("takes on comments changed outside the app", async () => {
    const comment = { id: "a", text: "Bigger", x: 0.5, y: 0.5 };
    let comments: Deck["comments"] = { intro: [comment] };
    const { useApp, changed } = await watching(() => ({ ...DECK, comments }));
    useApp.setState({ comments: {} });
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(useApp.getState().comments).toEqual({ intro: [comment] });
    comments = undefined;
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(useApp.getState().comments).toEqual({});
  });

  it("saves comments once the user pauses, and only when they changed", async () => {
    const comment = { id: "a", text: "Bigger", x: 0.5, y: 0.5 };
    const { useApp, changed } = await watching(() => ({ ...DECK, comments: {} }));
    useApp.getState().addComment("intro", comment);
    useApp.getState().updateComment("intro", "a", "Much bigger");
    changed(["deck.html"]);
    await vi.advanceTimersByTimeAsync(130);
    expect(useApp.getState().comments.intro).toEqual([{ ...comment, text: "Much bigger" }]);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls("save_comments").map((c) => c.comments)).toEqual([{ intro: [{ ...comment, text: "Much bigger" }] }]);
    expect(calls("save_review")).toHaveLength(0);
    useApp.getState().removeComment("intro", "a");
    await vi.advanceTimersByTimeAsync(500);
    expect(calls("save_comments")[1]!.comments).toEqual({});
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
    const added = {
      ...DECK,
      slides: [...DECK.slides, { id: "fresh", hash: "f", hidden: false, locked: false, moved: false }],
    };
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
    expect(lastError(useApp.getState())).toBeNull();
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
    useApp.setState({
      openedFile: { path: "q3.html", absolute: "/decks/q3.html", kind: "deck" },
      deck: { ...DECK, id: "/decks/q3.html" },
    });
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
    useApp.setState({
      deck: null,
      openedFile: { path: "site/index.html", absolute: "/decks/site/index.html", kind: "webpage" },
      fileRev: 0,
    });
    changedIn("/decks", ["site/style.css"]);
    expect(useApp.getState().fileRev).toBe(0);
    changedIn("/decks", ["site/index.html"]);
    expect(useApp.getState().fileRev).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls("load_deck")).toEqual([]);
  });
});

describe("the agent showing a deck it made", () => {
  const MADE = { ...DECK, id: "/decks/talk/new/deck.html", path: "/decks/talk/new/deck.html" };
  const emitTo = (chat: string, event: unknown) => listeners.get("agent-event")!({ payload: { chat, event } });

  async function folderChatAtWork() {
    const { useApp, initEventBridge } = await freshModule();
    backend({
      open_file: ({ path }) => ({ path, absolute: `/decks/talk/${path}`, kind: "deck" }),
      open_deck: () => MADE,
      load_chat: () => null,
      agent_running: () => false,
    });
    useApp.setState({
      messages: [userMessage("Make a deck"), assistantMessage({ status: "streaming" })],
      running: true,
    });
    await initEventBridge();
    return useApp;
  }

  it("shows the deck beside the folder's chat, which moves to the deck when the turn ends", async () => {
    const useApp = await folderChatAtWork();
    emitTo("/decks/talk", { type: "openFile", path: "new/deck.html" });
    await vi.waitFor(() => expect(useApp.getState().deck).toEqual(MADE));
    expect(calls("open_deck")).toEqual([{ id: MADE.id, keepChat: true, quiet: false }]);
    // The turn goes on in the folder's chat: nothing asked, nothing stopped, nothing reloaded.
    expect(ask).not.toHaveBeenCalled();
    expect(calls("interrupt_agent")).toEqual([]);
    expect(calls("load_chat")).toEqual([]);
    expect(useApp.getState()).toMatchObject({ chatKey: "/decks/talk", chatFollowsDeck: true, running: true });
    emitTo("/decks/talk", { type: "textDelta", text: "Done." });
    expect((useApp.getState().messages[1] as AssistantMessage).parts).toEqual([{ kind: "text", text: "Done." }]);

    useApp.setState({
      queue: [{ id: "q1", text: "Now make it blue", options: { includeSlide: false, attachments: [] } }],
    });
    emitTo("/decks/talk", { type: "finished", interrupted: false });
    await vi.waitFor(() => expect(useApp.getState().chatKey).toBe(MADE.id));
    expect(calls("move_chat_to_deck")).toHaveLength(1);
    expect(useApp.getState()).toMatchObject({ chatFollowsDeck: false, running: true });
    expect(useApp.getState().messages[0]).toMatchObject({ text: "Make a deck" });
    // The transcript is saved with the folder before it moves, and what waited is said in the deck's chat.
    const order = invoke.mock.calls.map(([command]) => command);
    expect(order.lastIndexOf("save_chat")).toBeLessThan(order.indexOf("move_chat_to_deck"));
    await vi.waitFor(() => expect(calls("send_message")).toHaveLength(1));
    expect(calls("send_message")[0]!.args).toMatchObject({ workspace: "/decks/talk", chat: MADE.id });
    expect(order.indexOf("move_chat_to_deck")).toBeLessThan(
      invoke.mock.calls.map(([command]) => command).indexOf("send_message"),
    );
  });

  it("leaves the chat with the folder, saying why, when it cannot move", async () => {
    const useApp = await folderChatAtWork();
    backend({
      open_file: ({ path }) => ({ path, absolute: `/decks/talk/${path}`, kind: "deck" }),
      open_deck: () => MADE,
      move_chat_to_deck: () => {
        throw "The agent is still working in this chat.";
      },
    });
    emitTo("/decks/talk", { type: "openFile", path: "new/deck.html" });
    await vi.waitFor(() => expect(useApp.getState().deck).toEqual(MADE));
    emitTo("/decks/talk", { type: "finished", interrupted: false });
    await vi.waitFor(() => expect(lastError(useApp.getState())).toBe("The agent is still working in this chat."));
    expect(useApp.getState().chatKey).toBe("/decks/talk");
  });

  it("keeps a deck's chat with its deck: the file is the user's to open", async () => {
    const useApp = await folderChatAtWork();
    useApp.setState({
      deck: DECK,
      chatKey: DECK.id,
      openedFile: { path: "deck.html", absolute: DECK.id, kind: "deck" },
    });
    emitTo(DECK.id, { type: "openFile", path: "new/deck.html" });
    await Promise.resolve();
    expect(calls("open_file")).toEqual([]);
    expect(calls("open_deck")).toEqual([]);
    // Something to know, not a failure, with a button that goes to the file.
    expect(lastError(useApp.getState())).toBeNull();
    const [toast] = useApp.getState().toasts;
    expect(toast).toMatchObject({
      kind: "info",
      text: "The agent made new/deck.html. This chat stays with deck.html.",
      action: { label: "Open" },
    });
    expect(useApp.getState()).toMatchObject({ deck: DECK, chatKey: DECK.id, running: true });
    const openPath = vi.fn(async () => {});
    useApp.setState({ openPath });
    toast!.action!.run();
    expect(openPath).toHaveBeenCalledWith("new/deck.html");
    // Its own deck, shown again, is nothing to say.
    useApp.setState({ toasts: [] });
    emitTo(DECK.id, { type: "openFile", path: "deck.html" });
    expect(useApp.getState().toasts).toEqual([]);
  });
});

describe("the agent opening a file", () => {
  it("keeps a running conversation and approvals when switching files, and routes openFile through openPath", async () => {
    const { useApp, initEventBridge } = await freshModule();
    backend({ open_file: ({ path }) => ({ path, absolute: `/decks/talk/${path}`, kind: "webpage" }) });
    useApp.setState({
      deck: DECK,
      messages: [userMessage("hi"), assistantMessage({ status: "streaming" })],
      running: true,
    });
    await initEventBridge();
    listeners.get("agent-event")!({
      payload: { chat: "/other", event: { type: "openFile", path: "outside.html" } },
    });
    expect(calls("open_file")).toEqual([]);
    listeners.get("agent-event")!({
      payload: { chat: "/decks/talk", event: { type: "openFile", path: "site/index.html" } },
    });
    await vi.waitFor(() => expect(useApp.getState().openedFile?.path).toBe("site/index.html"));
    expect(useApp.getState()).toMatchObject({ deck: null, running: true });
    expect(useApp.getState().messages).toHaveLength(2);
    expect(calls("interrupt_agent")).toEqual([]);
    listeners.get("agent-event")!({
      payload: { chat: "/decks/talk", event: { type: "textDelta", text: "Still here" } },
    });
    expect((useApp.getState().messages[1] as AssistantMessage).parts).toEqual([{ kind: "text", text: "Still here" }]);
  });
});
