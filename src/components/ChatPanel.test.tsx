import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const openDialog = vi.fn();
type DragDrop = { payload: { type: "enter" | "over" | "leave" | "drop"; paths?: string[] } };
let dragDrop: ((event: DragDrop) => void) | null = null;
const unlistenDragDrop = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: (...args: unknown[]) => openDialog(...args) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (event: DragDrop) => void) => {
      dragDrop = handler;
      return unlistenDragDrop;
    },
  }),
}));

import type { ProviderInfo } from "../lib/models";
import { useApp, type AssistantMessage, type ChatMessage, type ChatPart } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ChatPanel } from "./ChatPanel";

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    installed: true,
    path: "/bin/claude",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", isDefault: true, efforts: ["low", "medium", "high", "max"], defaultEffort: "medium" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", isDefault: false, efforts: ["low", "medium", "high", "max"], defaultEffort: "medium" },
    ],
    error: null,
  },
  {
    id: "codex",
    installed: true,
    path: "/bin/codex",
    models: [{ id: "gpt-6-astra", label: "GPT-6-Astra", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }],
    error: null,
  },
  { id: "copilot", installed: false, path: null, models: [], error: null },
];

const send = vi.fn(async () => {});
const resetChat = vi.fn(async () => {});
const interrupt = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  openDialog.mockReset();
  unlistenDragDrop.mockReset();
  dragDrop = null;
  send.mockClear();
  resetChat.mockClear();
  interrupt.mockClear();
  useApp.setState({
    deck: deckFor(DECK_HTML),
    selected: "intro",
    messages: [],
    running: false,
    selection: { provider: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5", effort: "medium" },
    providers: PROVIDERS,
    favoriteModels: [],
    error: null,
    sketches: {},
    send,
    resetChat,
    interrupt,
  });
});

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const sendButton = () => screen.getByTitle("Send") as HTMLButtonElement;
const type = (text: string) => fireEvent.change(textarea(), { target: { value: text } });

const reply = (patch: Partial<AssistantMessage>): AssistantMessage => ({
  id: "a1",
  role: "assistant",
  parts: [],
  status: "done",
  thinking: false,
  error: null,
  costUsd: null,
  durationMs: null,
  createdAt: 0,
  ...patch,
});

const tool = (name: string, input: Record<string, unknown>, status: "running" | "done" | "error" = "done"): ChatPart => ({
  kind: "tool",
  id: `${name}-${JSON.stringify(input)}`,
  name,
  input,
  status,
});

/** jsdom's accessible names drop the space before nested spans, so match on text. */
const toolRow = (text: string) => {
  const row = screen.getAllByRole("button").find((b) => b.textContent === text);
  if (!row) throw new Error(`no tool row "${text}"`);
  return row as HTMLButtonElement;
};

function showMessages(...messages: ChatMessage[]) {
  useApp.setState({ messages });
  return render(<ChatPanel />);
}

describe("ChatPanel: header", () => {
  it("collapses the chat panel", () => {
    useApp.setState({ chatOpen: true });
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Hide chat" }));
    expect(useApp.getState().chatOpen).toBe(false);
  });
});

describe("ChatPanel: empty chat", () => {
  it("offers starter prompts for an empty deck, which fill the composer", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] }, selected: null });
    render(<ChatPanel />);
    expect(screen.getByText(/Describe the presentation you want/)).toBeTruthy();
    fireEvent.click(screen.getByText(/neighborhood tool-sharing app/));
    expect(textarea().value).toMatch(/^A 6-slide pitch/);
    expect(send).not.toHaveBeenCalled();
  });

  it("asks for changes when the deck already has slides", () => {
    render(<ChatPanel />);
    expect(screen.getByText(/Ask for changes/)).toBeTruthy();
    expect(screen.queryByText(/neighborhood tool-sharing app/)).toBeNull();
    expect(screen.queryByTitle(/New conversation/)).toBeNull();
  });

  it("warns when the selected model's CLI is not installed", () => {
    useApp.setState({ providers: PROVIDERS.map((p) => (p.id === "claude" ? { ...p, installed: false, models: [] } : p)) });
    render(<ChatPanel />);
    expect(screen.getByText(/Claude Code is not installed/)).toBeTruthy();
  });

  it("does not warn while the check is pending or when it is found", () => {
    useApp.setState({ providers: undefined });
    const { unmount } = render(<ChatPanel />);
    expect(screen.queryByText(/is not installed/)).toBeNull();
    unmount();
    useApp.setState({ providers: PROVIDERS });
    render(<ChatPanel />);
    expect(screen.queryByText(/is not installed/)).toBeNull();
  });
});

describe("ChatPanel: composing", () => {
  it("sends on Enter with the current slide and clears the draft", () => {
    render(<ChatPanel />);
    type("  Make it blue  ");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Make it blue", { includeSlide: true, attachments: [] });
    expect(textarea().value).toBe("");
  });

  it("sends with the button", () => {
    render(<ChatPanel />);
    type("Hi");
    fireEvent.click(sendButton());
    expect(send).toHaveBeenCalledOnce();
  });

  it("Shift+Enter and IME composition insert a newline instead of sending", () => {
    render(<ChatPanel />);
    type("Line one");
    fireEvent.keyDown(textarea(), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(textarea(), { key: "Enter", isComposing: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send blank messages", () => {
    render(<ChatPanel />);
    expect(sendButton().disabled).toBe(true);
    type("   \n ");
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
  });

  it("can leave the current slide out of the message", () => {
    useApp.setState({ selected: "#2" });
    render(<ChatPanel />);
    const chip = screen.getByRole("button", { name: "Slide 2" });
    fireEvent.click(chip);
    expect(chip.className).toContain("line-through");
    type("Whole deck");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Whole deck", { includeSlide: false, attachments: [] });
  });

  describe("sketch", () => {
    const mark = { tool: "pen" as const, color: "#ef4444", points: [[0.5, 0.5]] as [number, number][] };

    it("shows that the drawing on the current slide goes along", () => {
      render(<ChatPanel />);
      expect(screen.queryByText("Sketch")).toBeNull();
      act(() => useApp.setState({ sketches: { intro: [mark] } }));
      expect(screen.getByText("Sketch")).toBeTruthy();
      act(() => useApp.getState().select("#2"));
      expect(screen.queryByText("Sketch")).toBeNull();
    });

    it("can be discarded", () => {
      useApp.setState({ sketches: { intro: [mark], outro: [mark] } });
      render(<ChatPanel />);
      fireEvent.click(screen.getByRole("button", { name: "Discard sketch" }));
      expect(useApp.getState().sketches).toEqual({ outro: [mark] });
      expect(screen.queryByText("Sketch")).toBeNull();
    });

    it("is left out with the slide", () => {
      useApp.setState({ sketches: { intro: [mark] } });
      render(<ChatPanel />);
      fireEvent.click(screen.getByRole("button", { name: "Slide 1" }));
      expect(screen.queryByText("Sketch")).toBeNull();
    });
  });

  it("does not reference a slide when none is selected", () => {
    useApp.setState({ selected: null });
    render(<ChatPanel />);
    expect(screen.queryByRole("button", { name: /^Slide \d/ })).toBeNull();
    type("Hi");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Hi", { includeSlide: false, attachments: [] });
  });

  it("shows a stop button while the agent works", () => {
    useApp.setState({ running: true });
    render(<ChatPanel />);
    expect(textarea().placeholder).toBe("The agent is working…");
    expect(screen.queryByTitle("Send")).toBeNull();
    type("Queued?");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("Queued?");
    fireEvent.click(screen.getByTitle("Stop"));
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("switches models in the picker", () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("Claude Opus 5.5"),
      expect.stringContaining("Claude Sonnet 5"),
    ]);
    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet 5/ }));
    expect(useApp.getState().selection).toMatchObject({ provider: "claude", model: "claude-sonnet-5" });
    expect(JSON.parse(localStorage.getItem("slopslide.selection")!)).toMatchObject({ model: "claude-sonnet-5" });
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("searches across providers", () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    fireEvent.change(screen.getByPlaceholderText("Search models..."), { target: { value: "astra" } });
    fireEvent.click(screen.getByRole("option", { name: /GPT-6-Astra/ }));
    expect(useApp.getState().selection).toMatchObject({ provider: "codex", model: "gpt-6-astra", effort: "high" });
  });

  it("explains a provider that is not installed", () => {
    useApp.setState({ providers: PROVIDERS.map((p) => (p.id === "codex" ? { ...p, installed: false, models: [] } : p)) });
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    fireEvent.click(screen.getByTitle("Codex is not installed"));
    expect(screen.getByText("Codex is not installed")).toBeTruthy();
    expect(screen.getByText(/npm i -g @openai\/codex/)).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("explains how to install GitHub Copilot", () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    fireEvent.click(screen.getByTitle("GitHub Copilot is not installed"));
    expect(screen.getByText("GitHub Copilot is not installed")).toBeTruthy();
    expect(screen.getByText(/npm i -g @github\/copilot/)).toBeTruthy();
  });

  it("explains a provider whose models could not be listed, and checks again", () => {
    const refreshProviders = vi.fn(async () => {});
    useApp.setState({
      refreshProviders,
      providers: PROVIDERS.map((p) => (p.id === "codex" ? { ...p, models: [], error: "Not signed in" } : p)),
    });
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    fireEvent.click(screen.getByTitle("Codex"));
    expect(screen.getByText("Not signed in")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/ }));
    expect(refreshProviders).toHaveBeenCalledOnce();
  });

  it("offers the selected model's effort levels", () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByTitle("Reasoning effort"));
    expect(screen.getByRole("button", { name: "Max" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(useApp.getState().selection.effort).toBe("high");
  });

  it("starts a new conversation", () => {
    showMessages({ id: "u", role: "user", text: "hi", slide: null, attachments: [], createdAt: 0 });
    fireEvent.click(screen.getByTitle(/New conversation/));
    expect(resetChat).toHaveBeenCalledOnce();
  });
});

describe("ChatPanel: attachments", () => {
  it("attaches picked files and sends them with the message", async () => {
    openDialog.mockResolvedValue(["/Users/me/Photo.PNG", "/Users/me/data.csv"]);
    invoke.mockResolvedValue(["assets/photo.png", "assets/data.csv"]);
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    expect(invoke).toHaveBeenCalledWith("import_assets", { id: "talk", paths: ["/Users/me/Photo.PNG", "/Users/me/data.csv"] });
    expect(screen.getByText("photo.png")).toBeTruthy();
    expect(screen.getByText("data.csv")).toBeTruthy();
    type("Use these");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Use these", { includeSlide: true, attachments: ["assets/photo.png", "assets/data.csv"] });
    expect(screen.queryByText("photo.png")).toBeNull();
  });

  it("does nothing when the picker is cancelled", async () => {
    openDialog.mockResolvedValue(null);
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts a single picked path", async () => {
    openDialog.mockResolvedValue("/a.png");
    invoke.mockResolvedValue(["assets/a.png"]);
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    expect(invoke).toHaveBeenCalledWith("import_assets", { id: "talk", paths: ["/a.png"] });
  });

  it("removes an attachment and does not list one twice", async () => {
    openDialog.mockResolvedValue(["/a.png"]);
    invoke.mockResolvedValue(["assets/a.png"]);
    render(<ChatPanel />);
    const attach = screen.getByTitle("Attach images or files");
    await act(async () => fireEvent.click(attach));
    await act(async () => fireEvent.click(attach));
    expect(screen.getAllByText("a.png")).toHaveLength(1);
    fireEvent.click(screen.getByText("a.png").querySelector("button")!);
    expect(screen.queryByText("a.png")).toBeNull();
  });

  it("imports files dropped on the window", async () => {
    invoke.mockResolvedValue(["assets/drop.png"]);
    const { container } = render(<ChatPanel />);
    await waitFor(() => expect(dragDrop).not.toBeNull());
    const composer = () => container.querySelector(".shadow-composer")!;
    act(() => dragDrop!({ payload: { type: "enter" } }));
    expect(composer().className).toContain("border-primary");
    act(() => dragDrop!({ payload: { type: "leave" } }));
    expect(composer().className).not.toContain("border-primary");
    act(() => dragDrop!({ payload: { type: "over" } }));
    await act(async () => dragDrop!({ payload: { type: "drop", paths: ["/tmp/drop.png"] } }));
    expect(composer().className).not.toContain("border-primary");
    expect(invoke).toHaveBeenCalledWith("import_assets", { id: "talk", paths: ["/tmp/drop.png"] });
    expect(screen.getByText("drop.png")).toBeTruthy();
  });

  it("stops listening for drops when unmounted", async () => {
    const { unmount } = render(<ChatPanel />);
    await waitFor(() => expect(dragDrop).not.toBeNull());
    unmount();
    expect(unlistenDragDrop).toHaveBeenCalled();
  });

  it("reports a failed import", async () => {
    openDialog.mockResolvedValue(["/locked.png"]);
    invoke.mockRejectedValue("permission denied");
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    expect(useApp.getState().error).toBe("permission denied");
  });
});

describe("ChatPanel: transcript", () => {
  it("shows the user's message with its slide and attachments", () => {
    showMessages({ id: "u", role: "user", text: "Bigger title", slide: "outro", attachments: ["assets/logo.svg"], createdAt: 0 });
    expect(screen.getByText("Bigger title")).toBeTruthy();
    expect(screen.getByText("on slide 3")).toBeTruthy();
    expect(screen.getByText("· logo.svg")).toBeTruthy();
  });

  it("notes when the message came with a sketch", () => {
    const bounds = { left: 0, top: 0, right: 10, bottom: 10 };
    showMessages({ id: "u", role: "user", text: "Fix", slide: "outro", attachments: [], sketch: { image: null, bounds }, createdAt: 0 });
    expect(screen.getByText("· with sketch")).toBeTruthy();
  });

  it("omits the slide when it no longer exists", () => {
    showMessages({ id: "u", role: "user", text: "Hi", slide: "deleted", attachments: [], createdAt: 0 });
    expect(screen.queryByText(/on slide/)).toBeNull();
  });

  it("renders replies as markdown", () => {
    const { container } = showMessages(reply({ parts: [{ kind: "text", text: "**Done.** See:\n\n| a | b |\n|---|---|\n| 1 | 2 |" }] }));
    expect(container.querySelector("strong")!.textContent).toBe("Done.");
    expect(container.querySelector("table")).not.toBeNull();
  });

  it.each([
    ["Write", { file_path: "/Users/me/Documents/SlopSlide/talk/deck.html" }, "Wrote deck.html"],
    ["Edit", { file_path: "C:\\Users\\me\\SlopSlide\\talk\\assets\\x.css" }, "Edited assets/x.css"],
    ["MultiEdit", { file_path: "/elsewhere/file.txt" }, "Edited /elsewhere/file.txt"],
    ["Read", { file_path: "/lib/talk/.slopslide/reference/STYLE_PRESETS.md" }, "Read .slopslide/reference/STYLE_PRESETS.md"],
    ["Grep", { pattern: "class=\"slide\"" }, 'Searched class="slide"'],
    ["Glob", { pattern: "assets/*" }, "Searched assets/*"],
    ["WebSearch", { query: "pitch deck tips" }, "Searched the web for pitch deck tips"],
    ["WebFetch", { url: "https://example.com" }, "Fetched https://example.com"],
    ["TodoWrite", { todos: [] }, "TodoWrite"],
    ["Write", { file_path: 42 }, "Wrote"],
  ])("describes %s calls", (name, input, label) => {
    showMessages(reply({ parts: [tool(name, input)] }));
    expect(toolRow(label)).toBeTruthy();
  });

  it("links an edit of deck.html to the slide it touched", () => {
    const edit = tool("Edit", {
      file_path: "/lib/talk/deck.html",
      old_string: `<section class="slide" id="outro">`,
      new_string: `<section class="slide" id='outro'><h1>New</h1>`,
    });
    showMessages(reply({ parts: [edit] }));
    const row = toolRow("Edited deck.html · #outro");
    expect(row.disabled).toBe(false);
    fireEvent.click(row);
    expect(useApp.getState().selected).toBe("outro");
  });

  it("does not link edits of unknown slides or other files", () => {
    showMessages(
      reply({
        parts: [
          tool("Edit", { file_path: "/lib/talk/deck.html", new_string: `<div id="not-a-slide">` }),
          tool("Edit", { file_path: "/lib/talk/notes.html", new_string: `<section id="intro">` }),
        ],
      }),
    );
    const rows = screen.getAllByRole("button", { name: /^Edited/ }) as HTMLButtonElement[];
    expect(rows.map((r) => r.disabled)).toEqual([true, true]);
    expect(rows.map((r) => r.textContent)).toEqual(["Edited deck.html", "Edited notes.html"]);
  });

  it("shows thinking while the reply has nothing yet", () => {
    showMessages(reply({ status: "streaming", thinking: true }));
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });

  it("shows that a tool is working", () => {
    showMessages(reply({ status: "streaming", parts: [tool("Write", { file_path: "/lib/talk/deck.html" }, "running")] }));
    expect(screen.getByText("Working…")).toBeTruthy();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("shows neither once text is streaming", () => {
    showMessages(reply({ status: "streaming", parts: [{ kind: "text", text: "Writing" }] }));
    expect(screen.queryByText("Thinking…")).toBeNull();
    expect(screen.queryByText("Working…")).toBeNull();
  });

  it("shows errors and interruptions", () => {
    showMessages(reply({ status: "error", error: "Claude Code stopped unexpectedly: boom" }), reply({ id: "a2", status: "interrupted" }));
    expect(screen.getByText("Claude Code stopped unexpectedly: boom")).toBeTruthy();
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("shows how long a finished turn took and what it cost", () => {
    showMessages(reply({ durationMs: 3420, costUsd: 0.1234 }), reply({ id: "a2", durationMs: 800, costUsd: 0 }));
    expect(screen.getByText("3.4s · $0.123")).toBeTruthy();
    expect(screen.getByText("0.8s")).toBeTruthy();
  });

  it("hides blank text parts", () => {
    const { container } = showMessages(reply({ parts: [{ kind: "text", text: "   " }] }));
    expect(container.querySelector(".markdown")).toBeNull();
  });
});

describe("composer fill", () => {
  it("puts text handed over by the app into the composer and focuses it", () => {
    useApp.setState({ composerFill: null });
    render(<ChatPanel />);
    act(() => useApp.getState().fillComposer("Fix the lint issues"));
    expect(textarea().value).toBe("Fix the lint issues");
    expect(document.activeElement).toBe(textarea());
  });

  it("replaces a typed draft and can be refilled with the same text", () => {
    useApp.setState({ composerFill: null });
    render(<ChatPanel />);
    act(() => useApp.getState().fillComposer("Fix it"));
    type("something else");
    act(() => useApp.getState().fillComposer("Fix it"));
    expect(textarea().value).toBe("Fix it");
  });
});
