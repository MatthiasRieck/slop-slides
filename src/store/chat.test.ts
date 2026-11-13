import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DECK_HTML, deckFor } from "../test/fixtures";
import { appWindow, invoke } from "../test/tauri";
import { type AssistantMessage, lastSentText, retryTarget, sendOptionsOf, type UserMessage } from "./messages";
import {
  assistantMessage,
  backend,
  calls,
  DECK,
  freshStore,
  type Handler,
  prompts,
  resetBackend,
  type TestStore,
  userMessage,
  withBridge,
} from "./testing";

beforeEach(resetBackend);

describe("sending a message", () => {
  const prompt = () => (calls("send_message")[0]!.args as { prompt: string }).prompt;

  it("does nothing without a workspace", async () => {
    const useApp = await freshStore(false);
    await useApp.getState().send("hi", { includeSlide: true, attachments: [] });
    expect(calls("send_message")).toEqual([]);
    expect(useApp.getState().messages).toEqual([]);
    expect(useApp.getState().queue).toEqual([]);
  });

  it("queues the message while the agent runs, keeping the slide it is about", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, running: true, selected: "#2" });
    await useApp.getState().send("hi", { includeSlide: true, attachments: ["assets/a.png"] });
    await useApp.getState().send("later", { includeSlide: false, attachments: [] });
    expect(calls("send_message")).toEqual([]);
    expect(useApp.getState().messages).toEqual([]);
    expect(useApp.getState().queue).toMatchObject([
      { text: "hi", options: { includeSlide: true, attachments: ["assets/a.png"], slide: "#2" } },
      { text: "later", options: { includeSlide: false, slide: null } },
    ]);
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

  it("sends the bare text when there is no context to add", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro" });
    await useApp.getState().send("Whole deck please", { includeSlide: false, attachments: [] });
    expect(prompt()).toBe("[context]\nOpen file: deck.html (deck)\n[/context]\n\nWhole deck please");
    expect(useApp.getState().messages[0]).toMatchObject({ slide: null });
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
      chat: "/decks/talk",
      prompt: "[context]\nOpen file: deck.html (deck)\n[/context]\n\na",
      provider: "codex",
      model: "gpt-6-astra",
      effort: "high",
      contextWindow: null,
      permissionMode: "ask",
      compact: false,
      message: useApp.getState().messages[0]!.id,
      label: "a",
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
            {
              id: "auto",
              label: "Auto",
              isDefault: false,
              efforts: [],
              defaultEffort: null,
              contextWindows: [],
              defaultContextWindow: null,
            },
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
        sketch: {
          image: "/home/.slopslides/sessions/1-ab/sketches/1-ab.png",
          bounds: { left: 476, top: 266, right: 964, bottom: 544 },
        },
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

  describe("comments", () => {
    const target = { path: [0], tag: "h2", label: "Hello", at: [0.5, 0.5] as [number, number] };
    const first = { id: "a", text: "Bigger\nand bolder", x: 0.5, y: 0.5, target };
    const second = { id: "b", text: "Too busy", x: 0.25, y: 0.5 };
    const comments = { intro: [first], outro: [second] };
    const finish = (useApp: TestStore) => useApp.setState({ running: false });

    it("sends the selected slide's comments by default", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro", comments });
      await useApp.getState().send("Go", { includeSlide: true, attachments: [] });
      expect(prompts()[0]).toContain("Comments from the user");
      expect(prompts()[0]).toContain('on <h2> at `#intro > :nth-child(1)` showing "Hello": "Bigger\\nand bolder"');
      expect(prompts()[0]).not.toContain("Too busy");
      expect(useApp.getState().messages[0]).toMatchObject({ comments: [{ id: "a", slide: "intro", slideNumber: 1 }] });
    });

    it("sends the whole presentation's when asked to, in deck order", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "outro", comments, commentScope: "deck" });
      await useApp.getState().send("Go", { includeSlide: true, attachments: [] });
      const text = prompts()[0]!;
      expect(text.indexOf("Bigger")).toBeGreaterThan(-1);
      expect(text.indexOf("Bigger")).toBeLessThan(text.indexOf("Too busy"));
    });

    it("goes out with no slide referenced too", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro", comments });
      await useApp.getState().send("Go", { includeSlide: false, attachments: [] });
      expect(prompts()[0]).toContain("Bigger");
    });

    it("takes a comment off its slide once it is sent, in the deck file too, and keeps it in the chat", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro", comments, commentsHeld: { a: "stale" } });
      await useApp.getState().send("One", { includeSlide: true, attachments: [] });
      // Only the comments sent go: the other slide's stays.
      expect(useApp.getState().comments).toEqual({ intro: [], outro: [second] });
      expect(useApp.getState().commentsHeld).toEqual({});
      expect(useApp.getState().messages[0]).toMatchObject({ comments: [{ id: "a", text: first.text }] });
      expect(calls("save_comments").at(-1)).toMatchObject({ comments: { outro: [second] } });
      const order = invoke.mock.calls.map(([c]) => c);
      expect(order.indexOf("save_comments")).toBeLessThan(order.indexOf("send_message"));
      finish(useApp);
      await useApp.getState().send("Two", { includeSlide: true, attachments: [] });
      expect(prompts()[1]).not.toContain("Comments from the user");
    });

    it("takes sent comments off even when the turn fails", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro", comments });
      invoke.mockImplementation(async (command: string) => {
        if (command === "send_message") throw new Error("agent is down");
        return undefined;
      });
      await useApp.getState().send("One", { includeSlide: true, attachments: [] });
      expect(useApp.getState().comments.intro).toEqual([]);
    });

    it("keeps a comment changed since it was sent", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro", comments });
      useApp.getState().removeSentComments([{ ...first, text: "What it said before" }, second]);
      expect(useApp.getState().comments).toEqual({ intro: [first], outro: [] });
    });

    it("keeps comments held back on their slides", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro", comments });
      useApp.getState().setCommentHeld(first, true);
      await useApp.getState().send("One", { includeSlide: true, attachments: [] });
      expect(useApp.getState().comments).toEqual(comments);
    });

    it("leaves out comments held back and hidden ones", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro", comments });
      useApp.getState().setCommentHeld(first, true);
      await useApp.getState().send("One", { includeSlide: true, attachments: [] });
      finish(useApp);
      useApp.setState({ commentsHeld: {}, reviewVisible: false });
      await useApp.getState().send("Two", { includeSlide: true, attachments: [] });
      expect(prompts().join()).not.toContain("Bigger");
      useApp.setState({ reviewVisible: true });
    });

    it("saves what is pending before the agent starts", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro", comments: {} });
      // Held back, it stays on its slide, so the deck file is to have it.
      useApp.getState().addComment("intro", second);
      useApp.getState().setCommentHeld(second, true);
      await useApp.getState().send("Go", { includeSlide: true, attachments: [] });
      expect(calls("save_comments")).toHaveLength(1);
      const order = invoke.mock.calls.map(([c]) => c);
      expect(order.indexOf("save_comments")).toBeLessThan(order.indexOf("send_message"));
    });

    it("forgets the comments with the deck", async () => {
      const useApp = await freshStore();
      useApp.setState({ deck: DECK, selected: "intro", comments, commentsHeld: { a: "x" } });
      await useApp.getState().closeDeck();
      expect(useApp.getState()).toMatchObject({ comments: {}, commentsHeld: {} });
    });
  });

  it("interrupt asks the backend to stop the workspace agent", async () => {
    const useApp = await freshStore(false);
    useApp.getState().interrupt();
    expect(calls("interrupt_agent")).toEqual([]);
    useApp.setState({ workspace: { path: "/decks/talk", name: "talk" }, chatKey: "/decks/talk" });
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
      expect(useApp.getState().messages[1]).toMatchObject({
        status: "error",
        error: "The agent is still working on this deck.",
      });
      expect(useApp.getState().running).toBe(false);
    });
  });

  it("saves the current thread before restoring another provider conversation", async () => {
    const useApp = await freshStore(false);
    const past = [userMessage("Earlier conversation"), assistantMessage({ provider: "codex", status: "streaming" })];
    backend({ select_chat_thread: () => ({ chat: past, provider: "codex" }) });
    useApp.setState({
      workspace: { path: "/decks/talk", name: "talk" },
      chatKey: "/decks/talk",
      messages: [userMessage("Current")],
      running: true,
    });
    await useApp.getState().selectChatThread("old-thread");
    expect(calls("select_chat_thread")).toEqual([]);
    useApp.setState({ running: false });
    await useApp.getState().selectChatThread("old-thread");
    expect(calls("save_chat")).toEqual([{ id: "/decks/talk", chat: [userMessage("Current")] }]);
    expect(calls("select_chat_thread")).toEqual([{ id: "/decks/talk", thread: "old-thread" }]);
    expect(useApp.getState().messages[0]).toEqual(past[0]);
    expect(useApp.getState().messages[1]).toMatchObject({ status: "interrupted" });
    expect(useApp.getState().sessionProvider).toBe("codex");
    expect(useApp.getState().selection.provider).toBe("codex");
  });

  it("resetChat clears the workspace transcript", async () => {
    const useApp = await freshStore(false);
    await useApp.getState().resetChat();
    expect(calls("reset_chat")).toEqual([]);
    useApp.setState({
      workspace: { path: "/decks/talk", name: "talk" },
      chatKey: "/decks/talk",
      messages: [userMessage("x")],
      running: false,
    });
    await useApp.getState().resetChat();
    expect(calls("reset_chat")).toEqual([{ id: "/decks/talk" }]);
    expect(useApp.getState().messages).toEqual([]);
    expect(useApp.getState().running).toBe(false);
  });
});

describe("composer", () => {
  it("fillComposer bumps its revision even for identical text", async () => {
    const useApp = await freshStore();
    useApp.getState().fillComposer("fix it");
    useApp.getState().fillComposer("fix it");
    expect(useApp.getState().composerFill).toEqual({ text: "fix it", rev: 2 });
    useApp.getState().fillComposer("tidy it", { screenshot: "/home/.slopslides/sessions/1-ab/sketches/1.png" });
    expect(useApp.getState().composerFill).toEqual({
      text: "tidy it",
      rev: 3,
      screenshot: "/home/.slopslides/sessions/1-ab/sketches/1.png",
    });
  });

  it("is taken once by the composer, and the next one counts from the start", async () => {
    const useApp = await freshStore();
    useApp.getState().fillComposer("fix it");
    useApp.getState().clearComposerFill();
    expect(useApp.getState().composerFill).toBeNull();
    useApp.getState().fillComposer("fix it");
    expect(useApp.getState().composerFill).toEqual({ text: "fix it", rev: 1 });
  });

  it("focusComposer shows the chat and asks the composer to take the focus", async () => {
    const useApp = await freshStore();
    useApp.getState().setSidebarTab("files");
    useApp.getState().setSidebarOpen(false);
    const asked = useApp.getState().composerFocus;
    useApp.getState().focusComposer();
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "chat", composerFocus: asked + 1 });
    // With the chat on show it only asks again.
    useApp.getState().focusComposer();
    expect(useApp.getState()).toMatchObject({ sidebarOpen: true, sidebarTab: "chat", composerFocus: asked + 2 });
  });
});

describe("retrying the last turn", () => {
  const failed = (status: AssistantMessage["status"], message: Partial<UserMessage> = {}) => [
    { ...userMessage("Make it blue"), ...message },
    assistantMessage({ status, error: status === "error" ? "boom" : null }),
  ];

  it.each(["error", "interrupted"] as const)("sends the message of a turn that ended in %s again", async (status) => {
    const useApp = await freshStore();
    useApp.setState({
      deck: DECK,
      selected: "intro",
      messages: failed(status, { slide: "outro", attachments: ["assets/a.png"], screenshot: "/s/shot.png" }),
    });
    await useApp.getState().retryLast();
    const sent = useApp.getState().messages.at(-2) as UserMessage;
    // On the slide it was about, not the one selected now, with what went along with it.
    expect(sent).toMatchObject({
      text: "Make it blue",
      slide: "outro",
      attachments: ["assets/a.png"],
      screenshot: "/s/shot.png",
    });
    expect(sent.id).not.toBe("u-Make it blue");
    expect(useApp.getState().messages).toHaveLength(4);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toContain('Current slide: <section id="outro">');
    expect(prompts()[0]).toContain("Attached files: assets/a.png");
    expect(useApp.getState().running).toBe(true);
  });

  it("sends a message that was about no slide about none", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, selected: "intro", messages: failed("error") });
    await useApp.getState().retryLast();
    expect(useApp.getState().messages.at(-2)).toMatchObject({ slide: null });
    expect(prompts()[0]).not.toContain("Current slide");
  });

  it("does nothing after a turn that went well, with nothing said, or while the agent works", async () => {
    const useApp = await freshStore();
    await useApp.getState().retryLast();
    useApp.setState({ messages: [userMessage("Hi"), assistantMessage()] });
    await useApp.getState().retryLast();
    useApp.setState({ messages: failed("error"), running: true });
    await useApp.getState().retryLast();
    expect(prompts()).toEqual([]);
    expect(useApp.getState().queue).toEqual([]);
  });

  it("knows what to retry, and what was sent last", () => {
    expect(retryTarget([])).toBeNull();
    expect(retryTarget(failed("done"))).toBeNull();
    expect(retryTarget(failed("streaming"))).toBeNull();
    expect(retryTarget(failed("error"))).toMatchObject({ text: "Make it blue" });
    // Only the last turn: an earlier failure is history.
    expect(retryTarget([...failed("error"), userMessage("Again"), assistantMessage()])).toBeNull();
    expect(retryTarget([assistantMessage({ status: "error" })])).toBeNull();

    expect(lastSentText([])).toBeNull();
    const compact: UserMessage = { ...userMessage("/compact"), command: "compact" };
    expect(lastSentText([userMessage("One"), assistantMessage(), userMessage("Two"), compact])).toBe("Two");
    expect(sendOptionsOf(userMessage("Plain"))).toEqual({ includeSlide: false, slide: null, attachments: [] });
  });
});

describe("the folder's chat moving to the deck it made", () => {
  it("stays the same conversation: its key changes, its revision does not", async () => {
    const { useApp, emit } = await withBridge({ move_chat_to_deck: () => null });
    useApp.setState({
      deck: DECK,
      chatFollowsDeck: true,
      messages: [userMessage("Make a deck"), assistantMessage({ status: "streaming" })],
      running: true,
    });
    const revision = useApp.getState().chatRevision;
    emit({ type: "finished", interrupted: false });
    await vi.waitFor(() => expect(useApp.getState().chatKey).toBe(DECK.id));
    // What the chat panel keys the draft and the composer on (see ChatPanel.tsx).
    expect(useApp.getState().chatRevision).toBe(revision);
    expect(useApp.getState().messages).toHaveLength(2);
  });
});

describe("asking for the user's attention", () => {
  const pending = {
    id: "ap",
    title: "Run a command",
    reason: null,
    details: "ls",
    acceptLabel: "Allow",
    decisions: ["accept" as const],
  };
  async function turn() {
    const bridged = await withBridge();
    bridged.useApp.setState({
      messages: [userMessage("first"), assistantMessage({ status: "streaming", thinking: true })],
      running: true,
    });
    return bridged;
  }
  const asked = () => appWindow.requestUserAttention.mock.calls.length;
  afterEach(() => vi.restoreAllMocks());

  it("asks when an approval arrives or a turn ends while the window is not in use", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { emit } = await turn();
    emit({ type: "textDelta", text: "Working on it" });
    await Promise.resolve();
    expect(asked()).toBe(0);
    emit({ type: "approvalRequested", approval: pending });
    await vi.waitFor(() => expect(asked()).toBe(1));
    emit({ type: "finished", interrupted: false });
    await vi.waitFor(() => expect(asked()).toBe(2));
    // Informational: it asks once and stops by itself.
    expect(appWindow.requestUserAttention).toHaveBeenLastCalledWith(2);
  });

  it("does not ask while the window has the focus", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { emit } = await turn();
    emit({ type: "approvalRequested", approval: pending });
    emit({ type: "finished", interrupted: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked()).toBe(0);
  });

  it("goes on when the window cannot ask", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    appWindow.requestUserAttention.mockRejectedValueOnce(new Error("not allowed"));
    const { useApp, emit } = await turn();
    emit({ type: "finished", interrupted: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useApp.getState().running).toBe(false);
  });
});

describe("workspace conversations", () => {
  it("sends without a deck, about no slide, and describes the open file", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: null, openedFile: { path: "notes.md", absolute: "/decks/talk/notes.md", kind: "file" } });
    await useApp.getState().send("Make a deck from notes.md", { includeSlide: true, attachments: ["assets/notes.md"] });
    expect(calls("send_message")[0]!.args).toMatchObject({
      workspace: "/decks/talk",
      prompt: `[context]\nOpen file: notes.md (file)\nAttached files: assets/notes.md\n[/context]\n\nMake a deck from notes.md`,
    });
    expect(useApp.getState().messages[0]).toMatchObject({ slide: null, sketch: null });
  });
});

describe("queueing and steering", () => {
  async function running(handlers: Record<string, Handler> = {}) {
    const bridged = await withBridge(handlers);
    bridged.useApp.setState({
      deck: DECK,
      selected: "intro",
      messages: [userMessage("first"), assistantMessage({ status: "streaming", thinking: true })],
      running: true,
    });
    return bridged;
  }

  it("sends the first queued message once the turn finishes cleanly, on the slide it was queued on", async () => {
    const { useApp, emit } = await running();
    await useApp.getState().send("second", { includeSlide: true, attachments: [] });
    await useApp.getState().send("third", { includeSlide: false, attachments: [] });
    useApp.setState({ selected: "outro" });
    emit({ type: "finished", interrupted: false });
    await vi.waitFor(() => expect(calls("send_message")).toHaveLength(1));
    expect(prompts()[0]).toContain(`Current slide: <section id="intro">`);
    expect(prompts()[0]).toMatch(/second$/);
    expect(useApp.getState().queue.map((q) => q.text)).toEqual(["third"]);
    expect(useApp.getState().running).toBe(true);
    expect(useApp.getState().messages.at(-2)).toMatchObject({ role: "user", text: "second", slide: "intro" });
  });

  it("drops the slide of a queued message when the slide is gone", async () => {
    const { useApp, emit } = await running();
    useApp.setState({ selected: "outro" });
    await useApp.getState().send("second", { includeSlide: true, attachments: [] });
    useApp.setState({ deck: deckFor(DECK_HTML.replace(`id="outro"`, `id="end"`)), selected: "end" });
    emit({ type: "finished", interrupted: false });
    await vi.waitFor(() => expect(calls("send_message")).toHaveLength(1));
    expect(prompts()[0]).not.toContain("Current slide");
  });

  it("keeps the queue waiting after a stop or an error, until sent by hand", async () => {
    for (const ending of ["stopped", "failed"] as const) {
      const { useApp, emit } = await running();
      invoke.mockClear();
      await useApp.getState().send("second", { includeSlide: false, attachments: [] });
      if (ending === "failed") emit({ type: "error", message: "boom" });
      emit({ type: "finished", interrupted: ending === "stopped" });
      await Promise.resolve();
      expect(calls("send_message")).toEqual([]);
      expect(useApp.getState().running).toBe(false);
      const [queued] = useApp.getState().queue;
      // Idle, a queued message is sent rather than steered.
      await useApp.getState().steerQueued(queued!.id);
      expect(calls("steer_agent")).toEqual([]);
      expect(prompts()).toHaveLength(1);
      expect(useApp.getState().queue).toEqual([]);
    }
  });

  it("takes a message out of the queue", async () => {
    const { useApp } = await running();
    await useApp.getState().send("second", { includeSlide: false, attachments: ["assets/a.png"] });
    const [queued] = useApp.getState().queue;
    expect(useApp.getState().takeQueued(queued!.id)).toMatchObject({ text: "second" });
    expect(useApp.getState().queue).toEqual([]);
    expect(useApp.getState().takeQueued(queued!.id)).toBeNull();
  });

  it("steers the running turn: the chat shows the message where the agent took it", async () => {
    let emitLater: (() => void) | null = null;
    const { useApp, emit } = await running({
      steer_agent: (args) => {
        emitLater = () => emit({ type: "steered", message: args.message as string });
        return true;
      },
    });
    emit({ type: "toolUse", id: "t1", name: "Edit", input: {} });
    const steering = useApp.getState().steer("Make it blue", { includeSlide: true, attachments: [] });
    await vi.waitFor(() => expect(calls("steer_agent")).toHaveLength(1));
    const [args] = calls("steer_agent");
    expect(args).toMatchObject({ chat: "/decks/talk" });
    expect(args!.prompt).toContain(`Current slide: <section id="intro">`);
    expect(args!.prompt).toMatch(/Make it blue$/);
    // Nothing shows until the agent takes it.
    expect(useApp.getState().messages).toHaveLength(2);
    emitLater!();
    await steering;
    const messages = useApp.getState().messages;
    expect(messages).toHaveLength(4);
    expect(messages[1]).toMatchObject({ role: "assistant", status: "done", thinking: false });
    expect((messages[1] as AssistantMessage).parts).toMatchObject([{ kind: "tool", status: "done" }]);
    expect(messages[2]).toMatchObject({ role: "user", text: "Make it blue", id: args!.message, slide: "intro" });
    expect(messages[3]).toMatchObject({ role: "assistant", status: "streaming", thinking: true });
    emit({ type: "textDelta", text: "Blue it is" });
    expect((useApp.getState().messages[3] as AssistantMessage).parts).toEqual([{ kind: "text", text: "Blue it is" }]);
    expect(useApp.getState().running).toBe(true);
    expect(calls("send_message")).toEqual([]);
    expect(useApp.getState().queue).toEqual([]);
  });

  it("runs a steer the turn could not take as the next turn, made ready once", async () => {
    const { useApp, emit } = await running({ steer_agent: () => false });
    await useApp.getState().steer("Make it blue", { includeSlide: true, attachments: [] });
    const [queued] = useApp.getState().queue;
    expect(queued).toMatchObject({ text: "Make it blue", ready: { user: { text: "Make it blue" } } });
    expect(useApp.getState().messages).toHaveLength(2);
    // While the turn runs, it can only wait for it.
    await useApp.getState().steerQueued(queued!.id);
    expect(calls("steer_agent")).toHaveLength(1);
    expect(useApp.getState().queue).toHaveLength(1);
    emit({ type: "finished", interrupted: false });
    await vi.waitFor(() => expect(calls("send_message")).toHaveLength(1));
    expect(prompts()).toEqual([calls("steer_agent")[0]!.prompt]);
    expect(calls("send_message")[0]!.args).toMatchObject({ message: queued!.id });
    expect(useApp.getState().messages.at(-2)).toMatchObject({ id: queued!.id, text: "Make it blue" });
  });

  it("sends a steer at once when the turn ended before it got in", async () => {
    const { useApp, emit } = await running({
      steer_agent: () => {
        emit({ type: "finished", interrupted: false });
        return false;
      },
    });
    await useApp.getState().steer("Make it blue", { includeSlide: false, attachments: [] });
    expect(calls("send_message")).toHaveLength(1);
    expect(prompts()[0]).toMatch(/Make it blue$/);
    expect(useApp.getState().queue).toEqual([]);
    expect(useApp.getState().running).toBe(true);
  });

  it("sends instead of steering while idle, and queues a compaction", async () => {
    const { useApp } = await running();
    await useApp.getState().steer("/compact", { includeSlide: false, attachments: [] });
    expect(calls("steer_agent")).toEqual([]);
    expect(useApp.getState().queue.map((q) => q.text)).toEqual(["/compact"]);
    useApp.setState({ running: false, queue: [] });
    await useApp.getState().steer("Make it blue", { includeSlide: false, attachments: [] });
    expect(calls("steer_agent")).toEqual([]);
    expect(prompts()).toHaveLength(1);
  });

  it("forgets the queue with the chat", async () => {
    const { useApp } = await running();
    await useApp.getState().send("second", { includeSlide: false, attachments: [] });
    useApp.setState({ running: false });
    await useApp.getState().resetChat();
    expect(useApp.getState().queue).toEqual([]);
  });
});
