import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, open as openDialog, openUrl } from "../test/tauri";

type DragDrop = {
  payload: { type: "enter" | "over" | "leave" | "drop"; paths?: string[]; position?: { x: number; y: number } };
};
let dragDrop: ((event: DragDrop) => void) | null = null;
const unlistenDragDrop = vi.fn();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (event: DragDrop) => void) => {
      dragDrop = handler;
      return unlistenDragDrop;
    },
  }),
}));

import { catchDrops } from "../lib/drop";
import { openLayer } from "../lib/layers";
import type { ProviderInfo } from "../lib/models";
import { forgetModes } from "../lib/permissions";
import { workspaceChatFileUrl } from "../lib/utils";
import {
  type AssistantMessage,
  type ChatMessage,
  type ChatPart,
  flushReviewSave,
  type QueuedMessage,
  TIDY_PROMPT,
  useApp,
} from "../store";
import { lastError } from "../store/errors";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ChatPanel } from "./ChatPanel";

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    installed: true,
    path: "/bin/claude",
    models: [
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        isDefault: true,
        efforts: ["low", "medium", "high", "max"],
        defaultEffort: "medium",
        contextWindows: ["200k", "1m"],
        defaultContextWindow: "1m",
      },
      {
        id: "claude-sonnet-5",
        label: "Claude Sonnet 5",
        isDefault: false,
        efforts: ["low", "medium", "high", "max"],
        defaultEffort: "medium",
        contextWindows: ["200k", "1m"],
        defaultContextWindow: "200k",
      },
    ],
    error: null,
  },
  {
    id: "codex",
    installed: true,
    path: "/bin/codex",
    models: [
      {
        id: "gpt-6-astra",
        label: "GPT-6-Astra",
        isDefault: true,
        efforts: ["low", "high"],
        defaultEffort: "high",
        contextWindows: [],
        defaultContextWindow: null,
      },
    ],
    error: null,
  },
  { id: "copilot", installed: false, path: null, models: [], error: null },
];

const send = vi.fn(async () => {});
const resetChat = vi.fn(async () => {});
const interrupt = vi.fn();
const compact = vi.fn(async () => {});
const steer = vi.fn(async () => {});
const steerQueued = vi.fn(async () => {});
const takeQueued = vi.fn((_id: string): QueuedMessage | null => null);
const retryLast = vi.fn(async () => {});
const realRefreshProviders = useApp.getState().refreshProviders;

// Drawing schedules a save of the review marks; finish it here, not in the next test.
afterEach(() => flushReviewSave());

beforeEach(() => {
  invoke.mockReset().mockResolvedValue([]);
  openDialog.mockReset();
  unlistenDragDrop.mockReset();
  dragDrop = null;
  send.mockClear();
  resetChat.mockClear();
  interrupt.mockClear();
  compact.mockClear();
  steer.mockClear();
  steerQueued.mockClear();
  takeQueued.mockReset().mockReturnValue(null);
  retryLast.mockClear();
  forgetModes();
  useApp.setState({
    retryLast,
    refreshProviders: realRefreshProviders,
    workspace: { path: "/decks/talk", name: "talk" },
    chatKey: "/decks/talk",
    deck: deckFor(DECK_HTML),
    selected: "intro",
    messages: [],
    sessionProvider: null,
    running: false,
    selection: {
      provider: "claude",
      model: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      effort: "medium",
      contextWindow: "1m",
    },
    providers: PROVIDERS,
    favoriteModels: [],
    toasts: [],
    sketches: {},
    sketchesSent: {},
    reviewVisible: true,
    send,
    resetChat,
    interrupt,
    compact,
    steer,
    steerQueued,
    takeQueued,
    queue: [],
    composerFill: null,
    composerImages: [],
    chatFollowsDeck: false,
    revertNotes: [],
  });
});

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
/** Unfolds the tool calls of a finished reply, which show as one line of steps. */
const openSteps = () => fireEvent.click(screen.getByRole("button", { name: /^\d+ steps/ }));
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

const tool = (
  name: string,
  input: Record<string, unknown>,
  status: "running" | "done" | "error" = "done",
  output?: string | null,
  images?: string[],
): ChatPart => ({
  kind: "tool",
  id: `${name}-${JSON.stringify(input)}`,
  name,
  input,
  status,
  ...(output === undefined ? {} : { output }),
  ...(images ? { images } : {}),
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
  it("leaves hiding the chat to the top bar", () => {
    render(<ChatPanel />);
    expect(screen.queryByRole("button", { name: "Hide chat" })).toBeNull();
  });
});

describe("past chats", () => {
  it("searches saved chats and restores a selected transcript", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "list_chat_threads")
        return [
          { id: "current", title: "Current conversation", current: true, createdAt: 1, messageCount: 2 },
          {
            id: "past",
            title: "Quarterly pitch",
            association: "quarterly/pitch.html",
            current: false,
            createdAt: 1,
            messageCount: 1,
          },
        ];
      if (command === "select_chat_thread")
        return {
          chat: [{ id: "old-user", role: "user", text: "Earlier prompt", slide: null, attachments: [], createdAt: 1 }],
          provider: "claude",
        };
      return [];
    });
    render(<ChatPanel />);
    type("Unsent draft");
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
    const past = await screen.findByRole("button", { name: /Quarterly pitch/ });
    expect((screen.getByRole("button", { name: /Current conversation/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Search chats" }), {
      target: { value: "quarterly/pitch.html" },
    });
    expect(screen.queryByRole("button", { name: /Current conversation/ })).toBeNull();
    await act(async () => fireEvent.click(past));
    expect(screen.getByText("Earlier prompt")).toBeTruthy();
    expect(textarea().value).toBe("");
    expect(screen.queryByRole("region", { name: "Past chats" })).toBeNull();
    expect(invoke).toHaveBeenCalledWith("select_chat_thread", { id: "/decks/talk", thread: "past" });
  });

  it("keeps navigation disabled during a turn and reports history load errors", async () => {
    useApp.setState({ running: true });
    invoke.mockImplementation(async (command: string) => {
      if (command === "list_chat_threads") throw new Error("History unavailable");
      return [];
    });
    render(<ChatPanel />);
    expect((screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "History unavailable");
    expect(screen.getByText("Stop the current turn to switch chats.")).toBeTruthy();
  });
});

describe("ChatPanel: empty chat", () => {
  it("offers starter prompts for an empty deck, which fill the composer", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] }, selected: null });
    render(<ChatPanel />);
    expect(screen.getByText(/Ask the agent to create a presentation/)).toBeTruthy();
    fireEvent.click(screen.getByText(/neighborhood tool-sharing app/));
    expect(textarea().value).toMatch(/^A 6-slide pitch/);
    expect(send).not.toHaveBeenCalled();
  });

  it("asks for changes when the deck already has slides", () => {
    render(<ChatPanel />);
    expect(screen.getByText(/Ask for changes/)).toBeTruthy();
    expect(screen.queryByText(/neighborhood tool-sharing app/)).toBeNull();
    expect(screen.getByRole("button", { name: "Past chats" })).toBeTruthy();
  });

  it("suggests what to ask about a deck that has slides, filling the composer without sending", () => {
    render(<ChatPanel />);
    const suggestions = [
      "Tighten the text on this slide",
      "Add speaker notes",
      "Make the deck consistent",
      "Review the flow",
    ];
    for (const text of suggestions) expect(screen.getByRole("button", { name: new RegExp(text) })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add speaker notes/ }));
    expect(textarea().value).toBe("Add speaker notes to every slide that has none.");
    expect(document.activeElement).toBe(textarea());
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves the suggestion about the slide out when no slide is selected", () => {
    useApp.setState({ selected: null });
    render(<ChatPanel />);
    expect(screen.queryByRole("button", { name: /on this slide/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Review the flow/ })).toBeTruthy();
  });

  it("puts a suggestion after a draft already typed", () => {
    render(<ChatPanel />);
    type("Use British spelling.");
    fireEvent.click(screen.getByRole("button", { name: /Review the flow/ }));
    expect(textarea().value).toMatch(/^Use British spelling\.\n\nReview the flow/);
  });

  it("warns when the selected model's CLI is not installed", () => {
    useApp.setState({
      providers: PROVIDERS.map((p) => (p.id === "claude" ? { ...p, installed: false, models: [] } : p)),
    });
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
  const resizeHandle = () => screen.getByRole("separator", { name: "Resize message input" });
  const dragInput = (from: number, to: number, finish = "pointerup") => {
    const handle = resizeHandle();
    handle.setPointerCapture = vi.fn();
    handle.hasPointerCapture = () => true;
    handle.releasePointerCapture = vi.fn();
    for (const [event, y] of [
      ["pointerdown", from],
      ["pointermove", to],
      [finish, to],
    ] as const) {
      fireEvent(handle, new MouseEvent(event, { bubbles: true, button: 0, clientY: y }));
    }
  };

  it("allows vertical resizing and keeps the chosen height when editing or sending", () => {
    render(<ChatPanel />);
    const input = textarea();
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ height: 80 } as DOMRect);
    dragInput(400, 300);
    expect(input.style.height).toBe("180px");
    type("Make it blue");
    expect(input.style.height).toBe("180px");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.style.height).toBe("180px");
    expect(input.value).toBe("");
  });

  it("shrinks by dragging down and stops resizing after release or cancellation", () => {
    render(<ChatPanel />);
    const input = textarea();
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ height: 180 } as DOMRect);
    dragInput(300, 360);
    expect(input.style.height).toBe("120px");
    fireEvent(resizeHandle(), new MouseEvent("pointermove", { bubbles: true, clientY: 100 }));
    expect(input.style.height).toBe("120px");
    dragInput(300, 380, "pointercancel");
    fireEvent(resizeHandle(), new MouseEvent("pointermove", { bubbles: true, clientY: 100 }));
    expect(input.style.height).toBe("100px");
  });

  it("limits resizing and supports the keyboard", () => {
    render(<ChatPanel />);
    const input = textarea();
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ height: 80 } as DOMRect);
    // By hand it goes well past what it grows to by itself: up to 60% of the window's height.
    const tallest = `${Math.round(window.innerHeight * 0.6)}px`;
    expect(Number.parseInt(tallest, 10)).toBeGreaterThan(240);
    dragInput(400, -1000);
    expect(input.style.height).toBe(tallest);
    dragInput(400, 1000);
    expect(input.style.height).toBe("64px");
    fireEvent.keyDown(resizeHandle(), { key: "ArrowUp" });
    expect(input.style.height).toBe("96px");
    fireEvent.keyDown(resizeHandle(), { key: "End" });
    expect(input.style.height).toBe(tallest);
    fireEvent.keyDown(resizeHandle(), { key: "Home" });
    expect(input.style.height).toBe("64px");
  });

  it("follows the window as it is resized: the tallest is its share of the height now", () => {
    const height = window.innerHeight;
    render(<ChatPanel />);
    const input = textarea();
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ height: 80 } as DOMRect);
    try {
      window.innerHeight = 500;
      act(() => void window.dispatchEvent(new Event("resize")));
      expect(resizeHandle().getAttribute("aria-valuemax")).toBe("300");
      dragInput(400, -1000);
      expect(input.style.height).toBe("300px");
      window.innerHeight = 1000;
      act(() => void window.dispatchEvent(new Event("resize")));
      fireEvent.keyDown(resizeHandle(), { key: "End" });
      expect(input.style.height).toBe("600px");
    } finally {
      window.innerHeight = height;
    }
  });

  it("is an opaque card: nothing behind it has to be blurred for each frame", () => {
    useApp.setState({ queue: [{ id: "q1", text: "Later", options: { includeSlide: false, attachments: [] } }] });
    render(<ChatPanel />);
    const card = textarea().parentElement!;
    const queued = screen.getByRole("region", { name: "Queued messages" });
    for (const surface of [card, queued]) {
      expect(surface.className).toMatch(/\bbg-card\b(?!\/)/);
      expect(surface.className).not.toContain("backdrop-blur");
    }
  });

  it("fits the text again on a double click of the grip, or Escape on it", () => {
    render(<ChatPanel />);
    const input = textarea();
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 120 });
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ height: 80 } as DOMRect);
    type("A longer draft");
    dragInput(400, 200);
    expect(input.style.height).toBe("280px");
    fireEvent.doubleClick(resizeHandle());
    expect(input.style.height).toBe("120px");
    fireEvent.keyDown(resizeHandle(), { key: "End" });
    fireEvent.keyDown(resizeHandle(), { key: "Escape" });
    expect(input.style.height).toBe("120px");
  });

  it("puts the grip after the message input for the keyboard, though it is drawn above it", () => {
    render(<ChatPanel />);
    const order = textarea().compareDocumentPosition(resizeHandle());
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(resizeHandle().className).toContain("order-first");
  });

  it("opens at the smallest height even when the placeholder would wrap", () => {
    const input = (() => {
      const proto = HTMLTextAreaElement.prototype;
      const spy = vi.spyOn(proto, "scrollHeight", "get").mockReturnValue(400);
      render(<ChatPanel />);
      spy.mockRestore();
      return textarea();
    })();
    expect(input.style.height).toBe("64px");
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 120 });
    type("A longer draft");
    expect(input.style.height).toBe("120px");
    type("");
    expect(input.style.height).toBe("64px");
  });

  it("still grows automatically with the draft until manually resized", () => {
    render(<ChatPanel />);
    const input = textarea();
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 120 });
    type("A longer draft");
    expect(input.style.height).toBe("120px");
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 300 });
    type("An even longer draft");
    expect(input.style.height).toBe("240px");
  });

  it("keeps the toolbar on one line, collapsing labels to icons in narrow panels", () => {
    render(<ChatPanel />);
    const send = screen.getByRole("button", { name: "Send" });
    const toolbar = send.parentElement!;
    expect(toolbar.className).toContain("flex-nowrap");
    expect(toolbar.className).not.toContain("flex-wrap");
    expect(toolbar.parentElement!.className).toContain("@container");
    // The model's name always shows, cut short; effort and permissions give way to icons first.
    const label = screen.getByText(useApp.getState().selection.label);
    expect(label.className).not.toContain("hidden");
    expect(label.className).toContain("truncate");
    for (const text of ["Medium · 1M", "Ask for approval"]) {
      expect(screen.getByText(text).className).toContain("hidden");
      expect(screen.getByText(text).className).toContain("@[26rem]:inline");
    }
    for (const chevron of toolbar.querySelectorAll(".lucide-chevron-down")) {
      expect(chevron.getAttribute("class")).toContain("@[17rem]:block");
    }
  });

  it("keeps the toolbar's round buttons from being squeezed", () => {
    render(<ChatPanel />);
    expect(screen.getByRole("button", { name: useApp.getState().selection.label }).parentElement!.className).toContain(
      "min-w-0",
    );
    expect(screen.getByLabelText("Permissions").parentElement!.className).toContain("shrink-0");
    expect(sendButton().className).toContain("shrink-0");
    for (const title of ["Attach images or files", "Dictate a message"]) {
      expect(screen.getByTitle(title).className).toContain("shrink-0");
    }
    act(() => useApp.setState({ running: true }));
    expect(screen.getByRole("button", { name: "Stop" }).className).toContain("shrink-0");
  });

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

    it("can be left out, keeping the marks on the slide", () => {
      useApp.setState({ sketches: { intro: [mark], outro: [mark] } });
      render(<ChatPanel />);
      fireEvent.click(screen.getByRole("button", { name: "Don't send sketch" }));
      expect(useApp.getState().sketches).toEqual({ intro: [mark], outro: [mark] });
      expect(screen.queryByText("Sketch")).toBeNull();
      // New marks go along again.
      act(() => useApp.setState((s) => ({ sketches: { ...s.sketches, intro: [mark, mark] } })));
      expect(screen.getByText("Sketch")).toBeTruthy();
    });

    it("is not sent while the review marks are hidden", () => {
      useApp.setState({ sketches: { intro: [mark] }, reviewVisible: false });
      render(<ChatPanel />);
      expect(screen.queryByText("Sketch")).toBeNull();
      act(() => useApp.getState().setReviewVisible(true));
      expect(screen.getByText("Sketch")).toBeTruthy();
    });

    it("is left out with the slide", () => {
      useApp.setState({ sketches: { intro: [mark] } });
      render(<ChatPanel />);
      fireEvent.click(screen.getByRole("button", { name: "Slide 1" }));
      expect(screen.queryByText("Sketch")).toBeNull();
    });
  });

  describe("comments", () => {
    const first = { id: "a", text: "Bigger", x: 0.5, y: 0.5 };
    const second = { id: "b", text: "Remove this", x: 0.5, y: 0.5 };
    const third = { id: "c", text: "Add a chart", x: 0.5, y: 0.5 };
    const comments = { intro: [first, second], outro: [third] };
    const count = (n: string) => screen.getByRole("button", { name: n });

    beforeEach(() => useApp.setState({ comments, commentScope: "slide", commentsHeld: {} }));
    afterEach(() => useApp.setState({ comments: {}, commentScope: "slide", commentsHeld: {} }));

    it("shows nothing without comments", () => {
      useApp.setState({ comments: {} });
      render(<ChatPanel />);
      expect(screen.queryByRole("group", { name: "Which comments to send" })).toBeNull();
    });

    it("attaches the slide's comments, or the whole presentation's", () => {
      render(<ChatPanel />);
      expect(count("2 comments")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "All slides" }));
      expect(useApp.getState().commentScope).toBe("deck");
      expect(count("3 comments")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "This slide" }));
      expect(count("2 comments")).toBeTruthy();
    });

    it("keeps the chip on one line, dropping the word in a narrow composer", () => {
      render(<ChatPanel />);
      const chip = count("2 comments");
      expect(chip.parentElement!.className).toContain("whitespace-nowrap");
      expect(chip.parentElement!.parentElement!.className).toContain("@container");
      const word = within(chip).getByText("comments");
      expect(word.className).toContain("sr-only");
      expect(word.className).toContain("@[16rem]:not-sr-only");
    });

    it("lists them, to leave some out and take them along again", () => {
      render(<ChatPanel />);
      fireEvent.click(count("2 comments"));
      const box = screen.getByRole("checkbox", { name: "Send: Bigger" });
      expect((box as HTMLInputElement).checked).toBe(true);
      fireEvent.click(box);
      expect(count("1 comment")).toBeTruthy();
      expect(useApp.getState().comments).toEqual(comments);
      fireEvent.click(screen.getByRole("checkbox", { name: "Send: Bigger" }));
      expect(count("2 comments")).toBeTruthy();
    });

    it("drops all of them from the message at once, keeping them on the slides", () => {
      render(<ChatPanel />);
      fireEvent.click(screen.getByRole("button", { name: "Don't send comments" }));
      expect(count("0 comments")).toBeTruthy();
      expect(useApp.getState().comments).toEqual(comments);
      expect(screen.queryByRole("button", { name: "Don't send comments" })).toBeNull();
      // A changed comment goes along again.
      act(() => useApp.getState().updateComment("intro", "a", "Much bigger"));
      expect(count("1 comment")).toBeTruthy();
    });

    it("is not sent while the review is hidden", () => {
      useApp.setState({ reviewVisible: false });
      render(<ChatPanel />);
      expect(screen.queryByRole("group", { name: "Which comments to send" })).toBeNull();
      act(() => useApp.getState().setReviewVisible(true));
      expect(count("2 comments")).toBeTruthy();
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
    expect(textarea().placeholder).toMatch(/^Queue a message, or Ctrl\+Enter to steer the agent now…$/);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("queues on Enter while the agent works, and steers with the modifier", () => {
    useApp.setState({ running: true });
    render(<ChatPanel />);
    expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
    type("Later");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Later", { includeSlide: true, attachments: [] });
    expect(steer).not.toHaveBeenCalled();
    expect(textarea().value).toBe("");
    type("Now");
    fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true });
    type("Now too");
    fireEvent.keyDown(textarea(), { key: "Enter", ctrlKey: true });
    expect(steer.mock.calls).toEqual([
      ["Now", { includeSlide: true, attachments: [] }],
      ["Now too", { includeSlide: true, attachments: [] }],
    ]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("offers to steer or queue the draft while the agent works", () => {
    useApp.setState({ running: true });
    render(<ChatPanel />);
    type("Bluer");
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(steer).toHaveBeenCalledWith("Bluer", { includeSlide: true, attachments: [] });
    type("Greener");
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(send).toHaveBeenCalledWith("Greener", { includeSlide: true, attachments: [] });
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("sends with the modifier while the agent is idle", () => {
    render(<ChatPanel />);
    type("Hi");
    fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true });
    expect(send).toHaveBeenCalledOnce();
    expect(steer).not.toHaveBeenCalled();
  });

  it("switches models in the picker", () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    expect(
      screen
        .getAllByRole("button")
        .filter((button) => button.hasAttribute("aria-pressed") && button.closest("[data-index]"))
        .map((o) => o.textContent),
    ).toEqual([expect.stringContaining("Claude Opus 5.5"), expect.stringContaining("Claude Sonnet 5")]);
    fireEvent.click(screen.getByRole("button", { name: /Claude Sonnet 5/ }));
    expect(useApp.getState().selection).toMatchObject({ provider: "claude", model: "claude-sonnet-5" });
    expect(JSON.parse(localStorage.getItem("slopslide.selection")!)).toMatchObject({ model: "claude-sonnet-5" });
    expect(document.querySelector("[data-index]")).toBeNull();
  });

  it("selects a model with Tab and Space, and activates favorites independently", async () => {
    const user = userEvent.setup();
    render(<ChatPanel />);
    await user.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search models" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Claude Opus 5\.5/, pressed: true }));
    await user.tab();
    await user.keyboard("{Enter}");
    expect(useApp.getState().favoriteModels).toContain("claude:claude-opus-5-5");
    expect(screen.getByRole("textbox", { name: "Search models" })).toBeTruthy();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Claude Sonnet 5/ }));
    await user.keyboard(" ");
    expect(useApp.getState().selection.model).toBe("claude-sonnet-5");
    expect(screen.queryByRole("textbox", { name: "Search models" })).toBeNull();
  });

  it("limits provider tabs, search, and favorites to the current chat's provider", () => {
    useApp.setState({ sessionProvider: "claude", favoriteModels: ["codex:gpt-6-astra", "claude:claude-sonnet-5"] });
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    expect(
      screen
        .getAllByTitle("Start a new chat to change provider")
        .every((button) => (button as HTMLButtonElement).disabled),
    ).toBe(true);
    fireEvent.click(screen.getByTitle("Favorites"));
    expect(
      screen
        .getAllByRole("button")
        .filter((button) => button.hasAttribute("aria-pressed") && button.closest("[data-index]")),
    ).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Claude Sonnet 5/ })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search models..."), { target: { value: "astra" } });
    expect(document.querySelector("[data-index]")).toBeNull();
    fireEvent.keyDown(screen.getByPlaceholderText("Search models..."), { key: "Enter" });
    expect(useApp.getState().selection.provider).toBe("claude");
  });

  it("searches across providers", () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    fireEvent.change(screen.getByPlaceholderText("Search models..."), { target: { value: "astra" } });
    fireEvent.click(screen.getByRole("button", { name: /GPT-6-Astra/ }));
    expect(useApp.getState().selection).toMatchObject({ provider: "codex", model: "gpt-6-astra", effort: "high" });
  });

  it("keeps the model menu open for favorite clicks and dismisses it on an outside pointer", () => {
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    fireEvent.pointerDown(screen.getAllByTitle("Add to favorites")[0]!);
    fireEvent.click(screen.getAllByTitle("Add to favorites")[0]!);
    expect(useApp.getState().favoriteModels).toContain("claude:claude-opus-5-5");
    expect(
      screen
        .getAllByRole("button")
        .filter((button) => button.hasAttribute("aria-pressed") && button.closest("[data-index]")),
    ).toHaveLength(2);
    fireEvent.pointerDown(screen.getByPlaceholderText("Ask for slides or changes…"));
    expect(document.querySelector("[data-index]")).toBeNull();
  });

  it("explains a provider that is not installed", () => {
    useApp.setState({
      providers: PROVIDERS.map((p) => (p.id === "codex" ? { ...p, installed: false, models: [] } : p)),
    });
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Opus 5\.5/ }));
    fireEvent.click(screen.getByTitle("Codex is not installed"));
    expect(screen.getByText("Codex is not installed")).toBeTruthy();
    expect(screen.getByText(/npm i -g @openai\/codex/)).toBeTruthy();
    expect(document.querySelector("[data-index]")).toBeNull();
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
    fireEvent.click(screen.getByTitle("Reasoning effort and context window"));
    expect(screen.getByRole("button", { name: "Max" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(useApp.getState().selection.effort).toBe("high");
  });

  it("offers a Claude model's context windows", () => {
    render(<ChatPanel />);
    const trigger = screen.getByTitle("Reasoning effort and context window");
    expect(trigger.textContent).toBe("Medium · 1M");
    fireEvent.click(trigger);
    expect(screen.getByText("Context Window")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "200k" }));
    expect(useApp.getState().selection.contextWindow).toBe("200k");
    expect(screen.getByTitle("Reasoning effort and context window").textContent).toBe("Medium · 200k");
  });

  it("shows only effort for models without context window options", () => {
    useApp.setState({
      selection: { provider: "codex", model: "gpt-6-astra", label: "GPT-6-Astra", effort: "high", contextWindow: null },
    });
    render(<ChatPanel />);
    fireEvent.click(screen.getByTitle("Reasoning effort"));
    expect(screen.queryByText("Context Window")).toBeNull();
  });

  it("starts a new chat", () => {
    showMessages({ id: "u", role: "user", text: "hi", slide: null, attachments: [], createdAt: 0 });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(resetChat).toHaveBeenCalledOnce();
  });
});

describe("ChatPanel: voice input", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });

  const partial = async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const call = vi.mocked(listen).mock.calls.findLast(([name]) => name === "voice-partial");
    return call![1] as (event: { payload: string }) => void;
  };

  it("shows the text at the caret as it is said, then keeps it", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "voice_status") return { modelReady: true, modelBytes: 1, downloading: false, recording: false };
      if (cmd === "stop_recording") return "really big";
      return [];
    });
    render(<ChatPanel />);
    fireEvent.change(textarea(), { target: { value: "Make the title." } });
    textarea().setSelectionRange(8, 8);

    fireEvent.click(screen.getByRole("button", { name: "Dictate a message" }));
    const stop = await screen.findByRole("button", { name: /Stop dictating/ });
    expect(textarea().readOnly).toBe(true);
    const onPartial = await waitFor(partial);
    act(() => onPartial({ payload: "really" }));
    expect(textarea().value).toBe("Make the really title.");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).not.toHaveBeenCalled();

    fireEvent.click(stop);
    await waitFor(() => expect(textarea().value).toBe("Make the really big title."));
    expect(textarea().readOnly).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("scrolls to follow the dictated text", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "voice_status") return { modelReady: true, modelBytes: 1, downloading: false, recording: false };
      return [];
    });
    render(<ChatPanel />);
    const el = textarea();
    // A line per character, 10px each, in a 50px tall box.
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => el.value.length * 10 });
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 50 });
    fireEvent.change(el, { target: { value: "abcdefghij" } });
    el.setSelectionRange(10, 10);
    el.scrollTop = 0;

    fireEvent.click(screen.getByRole("button", { name: "Dictate a message" }));
    await screen.findByRole("button", { name: /Stop dictating/ });
    const onPartial = await waitFor(partial);
    act(() => onPartial({ payload: "klmno" }));
    // "abcdefghij klmno" ends 160px down, so its last line sits at the bottom of the box.
    expect(el.value).toBe("abcdefghij klmno");
    expect(el.scrollTop).toBe(110);
  });

  it("shows what is said once per frame at most, the latest of it", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "voice_status") return { modelReady: true, modelBytes: 1, downloading: false, recording: false };
      return [];
    });
    render(<ChatPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate a message" }));
    await screen.findByRole("button", { name: /Stop dictating/ });
    const onPartial = await waitFor(partial);
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    try {
      const shown: string[] = [];
      const input = textarea();
      const own = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!;
      Object.defineProperty(input, "value", {
        configurable: true,
        get: () => own.get!.call(input),
        set: (text: string) => {
          shown.push(text);
          own.set!.call(input, text);
        },
      });
      act(() => {
        for (const said of ["Make", "Make the", "Make the title", "Make the title big"]) onPartial({ payload: said });
      });
      // The first shows at once; of the rest, said within the same frame, only the last, in the next.
      expect(shown).toEqual(["Make"]);
      act(() => frames.splice(0).forEach((frame) => void frame(0)));
      expect(shown).toEqual(["Make", "Make the title big"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("restores the draft when dictation is discarded", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "voice_status") return { modelReady: true, modelBytes: 1, downloading: false, recording: false };
      return [];
    });
    render(<ChatPanel />);
    fireEvent.change(textarea(), { target: { value: "Keep this" } });
    fireEvent.click(screen.getByRole("button", { name: "Dictate a message" }));
    await screen.findByRole("button", { name: /Stop dictating/ });
    const onPartial = await waitFor(partial);
    act(() => onPartial({ payload: "never mind" }));
    expect(textarea().value).toBe("Keep this never mind");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(textarea().value).toBe("Keep this");
    expect(textarea().readOnly).toBe(false);
    expect(invoke).toHaveBeenCalledWith("cancel_recording");
  });

  const dictate = async (transcript: string) => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "voice_status") return { modelReady: true, modelBytes: 1, downloading: false, recording: false };
      if (cmd === "stop_recording") return transcript;
      return [];
    });
    render(<ChatPanel />);
  };
  const startDictating = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Dictate a message" }));
    await screen.findByRole("button", { name: /Stop dictating/ });
  };

  it("swaps the composer's options for a waveform while dictating", async () => {
    await dictate("");
    expect(screen.getByRole("button", { name: "Attach images or files" })).toBeTruthy();
    await startDictating();
    expect(screen.getByTestId("voice-waveform")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Attach images or files" })).toBeNull();

    // The Escape handler is attached in the same effect flush as the recording listeners,
    // which can land after the commit that shows the stop button.
    await waitFor(partial);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("voice-waveform")).toBeNull();
    expect(screen.getByRole("button", { name: "Attach images or files" })).toBeTruthy();
  });

  it("stops and sends the dictated text from the send button", async () => {
    await dictate("really big");
    fireEvent.change(textarea(), { target: { value: "Make the title" } });
    await startDictating();

    fireEvent.click(screen.getByRole("button", { name: "Stop and send" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith("Make the title really big", expect.anything());
    expect(invoke).toHaveBeenCalledWith("stop_recording");
    await waitFor(() => expect(textarea().value).toBe(""));
    expect(textarea().readOnly).toBe(false);
  });

  it("sends the draft when nothing was said, but not an empty message", async () => {
    await dictate("");
    await startDictating();
    fireEvent.click(screen.getByRole("button", { name: "Stop and send" }));
    await waitFor(() => expect(textarea().readOnly).toBe(false));
    expect(send).not.toHaveBeenCalled();

    fireEvent.change(textarea(), { target: { value: "Keep this" } });
    await startDictating();
    fireEvent.click(screen.getByRole("button", { name: "Stop and send" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send).toHaveBeenCalledWith("Keep this", expect.anything());
  });
});

describe("ChatPanel: attachments", () => {
  it("attaches picked files and sends them with the message", async () => {
    openDialog.mockResolvedValue(["/Users/me/Photo.PNG", "/Users/me/data.csv"]);
    invoke.mockResolvedValue(["assets/photo.png", "assets/data.csv"]);
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    expect(invoke).toHaveBeenCalledWith("import_assets", {
      id: "/decks/talk/deck.html",
      paths: ["/Users/me/Photo.PNG", "/Users/me/data.csv"],
    });
    // Images go in the fan; other files stay chips.
    expect(screen.getByAltText("photo.png")).toBeTruthy();
    expect(screen.getByText("data.csv")).toBeTruthy();
    type("Use these");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Use these", {
      includeSlide: true,
      attachments: ["assets/photo.png", "assets/data.csv"],
    });
    expect(screen.queryByAltText("photo.png")).toBeNull();
    expect(screen.queryByText("data.csv")).toBeNull();
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
    expect(invoke).toHaveBeenCalledWith("import_assets", { id: "/decks/talk/deck.html", paths: ["/a.png"] });
  });

  it("removes an attachment and does not list one twice", async () => {
    openDialog.mockResolvedValue(["/a.png"]);
    invoke.mockResolvedValue(["assets/a.png"]);
    render(<ChatPanel />);
    const attach = screen.getByTitle("Attach images or files");
    await act(async () => fireEvent.click(attach));
    await act(async () => fireEvent.click(attach));
    expect(screen.getAllByAltText("a.png")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Show 1 attached image"));
    fireEvent.click(screen.getByLabelText("Remove a.png"));
    expect(screen.queryByAltText("a.png")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
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
    expect(invoke).toHaveBeenCalledWith("import_assets", { id: "/decks/talk/deck.html", paths: ["/tmp/drop.png"] });
    expect(screen.getByAltText("drop.png")).toBeTruthy();
  });

  it("leaves dropped files to what lies where they landed, attaching the rest", async () => {
    invoke.mockResolvedValue(["assets/notes.md"]);
    const catcher = vi.fn((paths: string[]) => paths.filter((p) => !p.endsWith(".png")));
    const stop = catchDrops(catcher);
    try {
      render(<ChatPanel />);
      await waitFor(() => expect(dragDrop).not.toBeNull());
      await act(async () =>
        dragDrop!({
          payload: { type: "drop", paths: ["/tmp/photo.png", "/tmp/notes.md"], position: { x: 200, y: 100 } },
        }),
      );
      expect(catcher).toHaveBeenCalledWith(["/tmp/photo.png", "/tmp/notes.md"], { x: 200, y: 100 });
      expect(invoke).toHaveBeenCalledWith("import_assets", { id: "/decks/talk/deck.html", paths: ["/tmp/notes.md"] });
      // Nothing left over, nothing to import.
      invoke.mockClear();
      await act(async () =>
        dragDrop!({ payload: { type: "drop", paths: ["/tmp/photo.png"], position: { x: 1, y: 1 } } }),
      );
      expect(invoke).not.toHaveBeenCalledWith("import_assets", expect.anything());
    } finally {
      stop();
    }
  });

  it("does not invite drops over what would take them instead", async () => {
    const stop = catchDrops(
      (paths) => paths,
      (point) => point.x > 500,
    );
    try {
      const { container } = render(<ChatPanel />);
      await waitFor(() => expect(dragDrop).not.toBeNull());
      const composer = () => container.querySelector(".shadow-composer")!;
      act(() => dragDrop!({ payload: { type: "enter", paths: ["/tmp/a.png"], position: { x: 600, y: 10 } } }));
      expect(composer().className).not.toContain("border-primary");
      act(() => dragDrop!({ payload: { type: "over", position: { x: 100, y: 10 } } }));
      expect(composer().className).toContain("border-primary");
      act(() => dragDrop!({ payload: { type: "over", position: { x: 700, y: 10 } } }));
      expect(composer().className).not.toContain("border-primary");
    } finally {
      stop();
    }
  });

  it("stops listening for drops when unmounted", async () => {
    const { unmount } = render(<ChatPanel />);
    await waitFor(() => expect(dragDrop).not.toBeNull());
    unmount();
    expect(unlistenDragDrop).toHaveBeenCalled();
  });

  const paste = (files: File[], text = "") =>
    fireEvent.paste(textarea(), {
      clipboardData: { files, getData: (type: string) => (type === "text/plain" ? text : "") },
    });

  it("saves pasted images as assets and attaches them", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { name: string }) => `assets/${args.name}`);
    render(<ChatPanel />);
    const shot = new File(["hi"], "image.png", { type: "image/png" });
    const photo = new File(["jpg"], "Holiday.jpeg", { type: "image/jpeg" });
    await act(async () => paste([shot, photo]));
    await waitFor(() => expect(screen.getByAltText("Holiday.jpeg")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("save_asset", {
      id: "/decks/talk/deck.html",
      name: "pasted-image.png",
      data: "aGk=",
    });
    expect(invoke).toHaveBeenCalledWith("save_asset", {
      id: "/decks/talk/deck.html",
      name: "Holiday.jpeg",
      data: "anBn",
    });
    expect(screen.getByAltText("pasted-image.png").getAttribute("src")).toMatch(/\/talk\/assets\/pasted-image\.png$/);
    type("Use these");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Use these", {
      includeSlide: true,
      attachments: ["assets/pasted-image.png", "assets/Holiday.jpeg"],
    });
  });

  it("leaves text-only and non-image pastes alone", async () => {
    render(<ChatPanel />);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, {
      clipboardData: { files: [new File(["a,b"], "data.csv", { type: "text/csv" })], getData: () => "" },
    });
    await act(async () => textarea().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps text that came with a pasted image", async () => {
    invoke.mockResolvedValue("assets/pasted-image.png");
    render(<ChatPanel />);
    const withText = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(withText, {
      clipboardData: { files: [new File(["hi"], "image.png", { type: "image/png" })], getData: () => "caption" },
    });
    await act(async () => textarea().dispatchEvent(withText));
    expect(withText.defaultPrevented).toBe(false);
    const imageOnly = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(imageOnly, {
      clipboardData: { files: [new File(["hi"], "image.png", { type: "image/png" })], getData: () => "" },
    });
    await act(async () => textarea().dispatchEvent(imageOnly));
    expect(imageOnly.defaultPrevented).toBe(true);
  });

  it("reports a failed paste", async () => {
    invoke.mockRejectedValue("disk full");
    render(<ChatPanel />);
    await act(async () => paste([new File(["hi"], "image.png", { type: "image/png" })]));
    await waitFor(() => expect(lastError(useApp.getState())).toBe("disk full"));
  });

  it("shows image previews in a fan that opens a grid to review and remove them", async () => {
    const names = ["a.png", "b.jpg", "c.gif", "d.webp", "e.svg"];
    openDialog.mockResolvedValue(names.map((n) => `/${n}`));
    invoke.mockResolvedValue(names.map((n) => `assets/${n}`));
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));

    // The fan previews the latest four and counts the rest.
    const fan = screen.getByLabelText("Show 5 attached images");
    const cards = fan.parentElement!;
    expect(Array.from(cards.querySelectorAll("img")).map((img) => img.alt)).toEqual(names.slice(1));
    expect(cards.textContent).toBe("+1");
    // With more images than cards, removing one is the grid's.
    expect(within(cards).queryByRole("button", { name: /^Remove/ })).toBeNull();

    fireEvent.click(fan);
    const grid = screen.getByRole("dialog", { name: "Attached images" });
    expect(screen.queryByLabelText("Show 5 attached images")).toBeNull();
    expect(Array.from(grid.querySelectorAll("img")).map((img) => img.alt)).toEqual(names);
    expect(grid.textContent).toContain("5 images");

    fireEvent.click(screen.getByLabelText("Remove c.gif"));
    expect(screen.queryByAltText("c.gif")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("4 images");

    // Escape closes the grid back to the fan.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Show 4 attached images")).toBeTruthy();

    // So do the close button and a click outside.
    fireEvent.click(screen.getByLabelText("Show 4 attached images"));
    fireEvent.click(screen.getByLabelText("Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show 4 attached images"));
    fireEvent.pointerDown(textarea());
    expect(screen.queryByRole("dialog")).toBeNull();

    type("Use these");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Use these", {
      includeSlide: true,
      attachments: ["assets/a.png", "assets/b.jpg", "assets/d.webp", "assets/e.svg"],
    });
    expect(screen.queryByLabelText(/attached image/)).toBeNull();
  });

  it("removes a non-image attachment chip", async () => {
    openDialog.mockResolvedValue(["/notes.md"]);
    invoke.mockResolvedValue(["assets/notes.md"]);
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    expect(screen.queryByLabelText(/attached image/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Remove notes.md"));
    expect(screen.queryByText("notes.md")).toBeNull();
  });

  it("reports a failed import", async () => {
    openDialog.mockResolvedValue(["/locked.png"]);
    invoke.mockRejectedValue("permission denied");
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    expect(lastError(useApp.getState())).toBe("permission denied");
  });
});

describe("ChatPanel: transcript", () => {
  it("shows the user's message with its slide and attachments", () => {
    showMessages({
      id: "u",
      role: "user",
      text: "Bigger title",
      slide: "outro",
      attachments: ["assets/logo.svg"],
      createdAt: 0,
    });
    expect(screen.getByText("Bigger title")).toBeTruthy();
    expect(screen.getByText("on slide 3")).toBeTruthy();
    const picture = screen.getByAltText("logo.svg") as HTMLImageElement;
    expect(picture.getAttribute("src")).toBe(workspaceChatFileUrl("/decks/talk", "assets/logo.svg"));
  });

  it("shows what was sent along: images, the screenshot and the sketch as pictures, other files as chips", () => {
    const shot = "/home/.slopslides/sessions/1-ab/sketches/1-ab.png";
    const sketch = "/home/.slopslides/sessions/1-ab/sketches/2-cd.png";
    showMessages({
      id: "u",
      role: "user",
      text: "Use these",
      slide: null,
      attachments: ["assets/photo.png", "assets/numbers.csv"],
      screenshot: shot,
      sketch: { image: sketch, bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
      createdAt: 0,
    });
    const pictures = screen.getAllByRole("img") as HTMLImageElement[];
    expect(pictures.map((img) => img.alt)).toEqual(["Slide screenshot", "Slide with your sketch", "photo.png"]);
    expect(pictures[0]!.getAttribute("src")).toBe(workspaceChatFileUrl("", shot));
    expect(screen.getByText("numbers.csv").closest("li")!.title).toBe("assets/numbers.csv");
    // A picture whose file is gone just does not show.
    fireEvent.error(pictures[2]!);
    expect(screen.queryByAltText("photo.png")).toBeNull();
  });

  it("shows the user's text as typed, not as Markdown", () => {
    showMessages({
      id: "u",
      role: "user",
      text: "# Not a heading\n* not a list <b>x</b>",
      slide: null,
      attachments: [],
      createdAt: 0,
    });
    const text = screen.getByText(/Not a heading/);
    expect(text.textContent).toBe("# Not a heading\n* not a list <b>x</b>");
    expect(text.className).toContain("whitespace-pre-wrap");
    expect(screen.queryByRole("heading", { name: "Not a heading" })).toBeNull();
  });

  it("notes when the message came with a sketch", () => {
    const bounds = { left: 0, top: 0, right: 10, bottom: 10 };
    showMessages({
      id: "u",
      role: "user",
      text: "Fix",
      slide: "outro",
      attachments: [],
      sketch: { image: null, bounds },
      createdAt: 0,
    });
    expect(screen.getByText("· with sketch")).toBeTruthy();
  });

  it("omits the slide when it no longer exists", () => {
    showMessages({ id: "u", role: "user", text: "Hi", slide: "deleted", attachments: [], createdAt: 0 });
    expect(screen.queryByText(/on slide/)).toBeNull();
  });

  it("renders replies as markdown", () => {
    const { container } = showMessages(
      reply({ parts: [{ kind: "text", text: "**Done.** See:\n\n| a | b |\n|---|---|\n| 1 | 2 |" }] }),
    );
    expect(container.querySelector("strong")!.textContent).toBe("Done.");
    expect(container.querySelector("table")).not.toBeNull();
  });

  it("links an edit of deck.html to the slide it touched", () => {
    const edit = tool("Edit", {
      file_path: "/decks/talk/deck.html",
      old_string: `<section class="slide" id="outro">`,
      new_string: `<section class="slide" id='outro'><h1>New</h1>`,
    });
    showMessages(reply({ parts: [edit] }));
    const row = toolRow("Edited deck.html · #outro");
    expect(row.disabled).toBe(false);
    fireEvent.click(row);
    expect(useApp.getState().selected).toBe("outro");
  });

  it("links edits of a deck file with another name", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), id: "/decks/talk/q3.html", path: "/decks/talk/q3.html" } });
    const edit = tool("Edit", { file_path: "/decks/talk/q3.html", new_string: `<section class="slide" id="outro">` });
    showMessages(
      reply({
        parts: [edit, tool("Edit", { file_path: "/decks/talk/deck.html", new_string: `<section id="outro">` })],
      }),
    );
    openSteps();
    expect(toolRow("Edited q3.html · #outro").disabled).toBe(false);
    expect(toolRow("Edited deck.html").disabled).toBe(true);
  });

  it("does not link edits of unknown slides or other files", () => {
    showMessages(
      reply({
        parts: [
          tool("Edit", { file_path: "/decks/talk/deck.html", new_string: `<div id="not-a-slide">` }),
          tool("Edit", { file_path: "/decks/talk/notes.html", new_string: `<section id="intro">` }),
        ],
      }),
    );
    openSteps();
    const rows = screen.getAllByRole("button", { name: /^Edited/ }) as HTMLButtonElement[];
    expect(rows.map((r) => r.disabled)).toEqual([true, true]);
    expect(rows.map((r) => r.textContent)).toEqual(["Edited deck.html", "Edited notes.html"]);
  });

  it("unfolds a tool call's arguments and output, and folds them again", () => {
    showMessages(
      reply({
        parts: [tool("Bash", { command: "ls assets", timeout: 5000 }, "done", "logo.png\nphoto.jpg")],
      }),
    );
    expect(screen.queryByText("Output")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show arguments and output of Ran ls assets" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Arguments · Bash")).toBeTruthy();
    expect(screen.getByText("command").nextElementSibling!.textContent).toBe("ls assets");
    expect(screen.getByText("timeout").nextElementSibling!.textContent).toBe("5000");
    expect(screen.getByText("Output").nextElementSibling!.textContent).toBe("logo.png\nphoto.jpg");
    fireEvent.click(screen.getByRole("button", { name: "Hide arguments and output of Ran ls assets" }));
    expect(screen.queryByText("Output")).toBeNull();
  });

  it("shows a failed tool's output as its error, and says when a tool has none yet or at all", () => {
    showMessages(
      reply({
        status: "streaming",
        parts: [
          tool("Read", { file_path: "/decks/talk/gone.html" }, "error", "No such file"),
          tool("lint_deck", {}, "done", null),
          tool("Glob", { pattern: "assets/*" }),
          tool("Write", { file_path: "/decks/talk/deck.html" }, "running"),
        ],
      }),
    );
    for (const toggle of screen.getAllByRole("button", { name: /^Show arguments and output/ })) fireEvent.click(toggle);
    expect(screen.getByText("Error").nextElementSibling!.textContent).toBe("No such file");
    expect(screen.getByText("None")).toBeTruthy();
    expect(screen.getAllByText("No output")).toHaveLength(2);
    expect(screen.getByText("Running…")).toBeTruthy();
  });

  it("shows the images a tool gave the agent, from the chat's session", () => {
    const shots = [
      "/home/.slopslides/sessions/1-ab/tool-images/1.png",
      "/home/.slopslides/sessions/1-ab/tool-images/2.png",
    ];
    showMessages(
      reply({
        parts: [
          tool("render_slides", { slides: ["intro", "outro"] }, "done", "intro\n[image]\noutro\n[image]", shots),
          tool("Read", { file_path: "/decks/talk/assets/logo.png" }, "done", null, [shots[0]!]),
        ],
      }),
    );
    expect(screen.queryByRole("img")).toBeNull();
    openSteps();
    const [render, read] = screen.getAllByRole("button", { name: /^Show arguments and output/ });
    fireEvent.click(render!);
    const images = screen.getAllByRole("img") as HTMLImageElement[];
    expect(images.map((i) => i.getAttribute("src"))).toEqual(shots.map((s) => workspaceChatFileUrl("", s)));
    expect(images.map((i) => i.alt)).toEqual(["Image 1 of 2 the agent received", "Image 2 of 2 the agent received"]);
    expect(screen.getByText("Output").nextElementSibling!.textContent).toBe("intro\n[image]\noutro\n[image]");

    fireEvent.click(read!);
    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(screen.queryByText("No output")).toBeNull();
  });

  it("says so when an image of a tool's output is no longer kept", () => {
    showMessages(
      reply({
        parts: [
          tool("Read", { file_path: "/d/a.png" }, "done", null, ["/home/.slopslides/sessions/1-ab/tool-images/1.png"]),
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Show arguments and output/ }));
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("This image is no longer kept.")).toBeTruthy();
  });

  it("still selects the slide an edit touched while its details are open", () => {
    const edit = tool("Edit", { file_path: "/decks/talk/deck.html", new_string: `<section id="outro">` }, "done", "ok");
    showMessages(reply({ parts: [edit] }));
    fireEvent.click(screen.getByRole("button", { name: /^Show arguments and output/ }));
    expect(useApp.getState().selected).not.toBe("outro");
    fireEvent.click(toolRow("Edited deck.html · #outro"));
    expect(useApp.getState().selected).toBe("outro");
    expect(screen.getByText("Output").nextElementSibling!.textContent).toBe("ok");
  });

  it("shows thinking while the reply has nothing yet", () => {
    showMessages(reply({ status: "streaming", thinking: true }));
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });

  it("shows that a tool is working", () => {
    showMessages(
      reply({ status: "streaming", parts: [tool("Write", { file_path: "/decks/talk/deck.html" }, "running")] }),
    );
    expect(screen.getByText("Working…")).toBeTruthy();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("says that the agent is writing once text is streaming", () => {
    showMessages(reply({ status: "streaming", parts: [{ kind: "text", text: "Here it comes" }] }));
    expect(screen.getByText("Writing…")).toBeTruthy();
    expect(screen.queryByText("Thinking…")).toBeNull();
    expect(screen.queryByText("Working…")).toBeNull();
  });

  it("keeps one status line at the end of a streaming reply, read out, with the time it has taken", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      showMessages(reply({ status: "streaming", createdAt: 95_000, parts: [{ kind: "text", text: "Hi" }] }));
      const status = screen.getByTestId("reply-status");
      expect(status.parentElement!.lastElementChild).toBe(status);
      expect(screen.getByText("Writing…").getAttribute("aria-live")).toBe("polite");
      expect(status.textContent).toBe("Writing…5s");
      // The count is for the eye: read out, it would never stop.
      expect(screen.getByText("5s").getAttribute("aria-hidden")).toBe("true");
      act(() => void vi.advanceTimersByTime(61_000));
      expect(status.textContent).toBe("Writing…1m 06s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says that the agent waits for an approval, and nothing once the reply is over", () => {
    const approval: ChatPart = {
      kind: "approval",
      status: "pending",
      approval: {
        id: "ap",
        title: "Run a command",
        reason: null,
        details: "ls",
        acceptLabel: "Allow",
        decisions: ["accept"],
      },
    };
    useApp.setState({ running: true });
    showMessages(reply({ status: "streaming", parts: [approval] }));
    expect(screen.getByText("Waiting for your approval…")).toBeTruthy();
    cleanup();
    useApp.setState({ running: false });
    showMessages(reply({ status: "done", parts: [{ kind: "text", text: "Done" }] }));
    expect(screen.queryByTestId("reply-status")).toBeNull();
  });

  it("shows errors and interruptions", () => {
    showMessages(
      reply({ status: "error", error: "Claude Code stopped unexpectedly: boom" }),
      reply({ id: "a2", status: "interrupted" }),
    );
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

describe("ChatPanel: context meter", () => {
  const used = (tokens: number | null, window: number | null, provider: "claude" | "codex" | "copilot" = "claude") =>
    reply({ provider, context: { provider, tokens, window } });
  const meter = () => screen.queryByRole("progressbar", { name: "Context used" });
  const compactButton = () => screen.queryByRole("button", { name: "Compact" }) as HTMLButtonElement | null;
  const copilot = {
    provider: "copilot" as const,
    model: "gpt-x",
    label: "GPT X",
    effort: "medium",
    contextWindow: null,
  };

  it("is hidden until the agent reports its context", () => {
    showMessages(reply({}));
    expect(meter()).toBeNull();
    expect(compactButton()).toBeNull();
  });

  it("shows the tokens held and the share of the window, without compacting at 70% or less", () => {
    useApp.setState({ selection: copilot });
    showMessages(used(89_600, 128_000, "copilot"));
    expect(meter()!.getAttribute("aria-valuenow")).toBe("70");
    expect(screen.getByText("90k tokens")).toBeTruthy();
    expect(screen.getByText("70% of 128k context used")).toBeTruthy();
    expect(compactButton()).toBeNull();
  });

  it("fills its bar by moving it, which takes no layout", () => {
    useApp.setState({ selection: copilot });
    showMessages(used(57_600, 128_000, "copilot"));
    const bar = meter()!.firstElementChild as HTMLElement;
    expect(bar.style.transform).toBe("translateX(-55%)");
    expect(bar.style.width).toBe("");
    expect(bar.className).toContain("transition-transform");
  });

  it("offers /compact above 70%", () => {
    useApp.setState({ selection: copilot });
    showMessages(used(91_000, 128_000, "copilot"));
    expect(screen.getByText("71% of 128k context used")).toBeTruthy();
    fireEvent.click(compactButton()!);
    expect(compact).toHaveBeenCalledOnce();
  });

  it("cannot compact while the agent works", () => {
    useApp.setState({ selection: copilot, running: true });
    showMessages(used(100_000, 128_000, "copilot"));
    expect(compactButton()!.disabled).toBe(true);
  });

  it("measures Claude against the chosen context window", () => {
    showMessages(used(160_000, 1_000_000));
    expect(screen.getByText("16% of 1M context used")).toBeTruthy();
    expect(compactButton()).toBeNull();
    cleanup();
    useApp.setState({ selection: { ...useApp.getState().selection, contextWindow: "200k" } });
    showMessages(used(160_000, 1_000_000));
    expect(screen.getByText("80% of 200k context used")).toBeTruthy();
    expect(compactButton()).toBeTruthy();
  });

  it("shows the count alone while the window is unknown", () => {
    useApp.setState({ selection: { ...useApp.getState().selection, contextWindow: null } });
    showMessages(used(12_300, null));
    expect(screen.getByText("12k tokens")).toBeTruthy();
    expect(screen.getByText("in context")).toBeTruthy();
    expect(meter()!.getAttribute("aria-valuenow")).toBeNull();
    expect(compactButton()).toBeNull();
  });

  it("follows the selected provider's own conversation", () => {
    useApp.setState({ selection: copilot });
    showMessages(used(100_000, 200_000));
    expect(meter()).toBeNull();
  });

  it("says the conversation was compacted until its new size is known", () => {
    showMessages(used(null, 200_000));
    expect(screen.getByText("Compacted")).toBeTruthy();
    expect(screen.getByText("New size shows after the next message")).toBeTruthy();
    expect(meter()!.getAttribute("aria-valuenow")).toBeNull();
    expect(compactButton()).toBeNull();
  });

  it("warns as the context fills up", () => {
    useApp.setState({ selection: copilot });
    showMessages(used(120_000, 128_000, "copilot"));
    expect(meter()!.firstElementChild!.className).toContain("bg-destructive");
  });
});

describe("ChatPanel: compaction in the transcript", () => {
  it("shows the agent compacting, then the result", () => {
    const { rerender } = showMessages(reply({ status: "streaming", compacting: true }));
    expect(screen.getByText("Compacting the conversation…")).toBeTruthy();
    expect(screen.queryByText("Thinking…")).toBeNull();
    useApp.setState({ messages: [reply({ status: "streaming", compacted: true })] });
    rerender(<ChatPanel />);
    expect(screen.getByText("Conversation compacted")).toBeTruthy();
    expect(screen.queryByText("Compacting the conversation…")).toBeNull();
  });

  it("keeps the notice on a finished reply", () => {
    showMessages(reply({ compacted: true, durationMs: 1200 }));
    expect(screen.getByText("Conversation compacted")).toBeTruthy();
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

  it("goes after a typed draft, which is never lost to it, and can be refilled with the same text", () => {
    render(<ChatPanel />);
    act(() => useApp.getState().fillComposer("Fix it"));
    type("something else");
    act(() => useApp.getState().fillComposer("Fix it"));
    expect(textarea().value).toBe("something else\n\nFix it");
    // Handed over twice in a row, it is there once.
    act(() => useApp.getState().fillComposer("Fix it"));
    expect(textarea().value).toBe("something else\n\nFix it");
    type("");
    act(() => useApp.getState().fillComposer("Fix it"));
    expect(textarea().value).toBe("Fix it");
  });

  it("is taken once: it does not come back when the chat is shown again", () => {
    const first = render(<ChatPanel />);
    act(() => useApp.getState().fillComposer("Fix it"));
    expect(useApp.getState().composerFill).toBeNull();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    first.unmount();
    render(<ChatPanel />);
    expect(textarea().value).toBe("");
  });

  it("is waiting when the chat is shown after it was handed over", () => {
    useApp.getState().fillComposer("Fix it");
    render(<ChatPanel />);
    expect(textarea().value).toBe("Fix it");
  });

  it("does not send a prepared message until the user does", async () => {
    useApp.setState({ composerFill: null });
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "capture_sketch" ? "/home/.slopslides/sessions/1-ab/sketches/1-ab.png" : [],
    );
    document.body.setAttribute("data-sketch-target", "");
    try {
      render(<ChatPanel />);
      await act(() => useApp.getState().tidyLayout());
      expect(send).not.toHaveBeenCalled();
      expect(textarea().value).toBe(TIDY_PROMPT);
      expect(screen.getByRole("button", { name: "Show 1 attached image" })).toBeTruthy();
    } finally {
      document.body.removeAttribute("data-sketch-target");
    }
  });

  it("shows a handed-over screenshot with the images and sends it with the message", () => {
    useApp.setState({ composerFill: null });
    render(<ChatPanel />);
    act(() =>
      useApp.getState().fillComposer("Tidy it", { screenshot: "/home/.slopslides/sessions/1-ab/sketches/1-ab.png" }),
    );
    const fan = screen.getByRole("button", { name: "Show 1 attached image" });
    const img = fan.parentElement!.querySelector("img")!;
    expect(img.getAttribute("src")).toContain("/.session/home/.slopslides/sessions/1-ab/sketches/1-ab.png");
    expect(img.getAttribute("alt")).toBe("Slide screenshot");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Tidy it", {
      includeSlide: true,
      attachments: [],
      screenshot: "/home/.slopslides/sessions/1-ab/sketches/1-ab.png",
    });
    expect(screen.queryByRole("button", { name: /attached image/ })).toBeNull();
    type("Next");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenLastCalledWith("Next", { includeSlide: true, attachments: [] });
  });

  it("attaches images handed over while it was shown or before, keeping the draft", () => {
    const area = "/home/.slopslides/sessions/1-ab/sketches/2-cd.png";
    useApp.setState({ composerFill: null, composerImages: [area] });
    render(<ChatPanel />);
    expect(useApp.getState().composerImages).toEqual([]);
    type("Look here");
    act(() => useApp.getState().attachToComposer("/home/.slopslides/sessions/1-ab/sketches/3-ef.png"));
    expect(screen.getByRole("button", { name: "Show 2 attached images" })).toBeTruthy();
    expect(textarea().value).toBe("Look here");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Look here", {
      includeSlide: true,
      attachments: [area, "/home/.slopslides/sessions/1-ab/sketches/3-ef.png"],
    });
  });

  describe("a handed-over element", () => {
    const ELEMENT = { path: "#intro > h1:nth-child(1)", markup: "<h1>Hi</h1>", name: '<h1> "Hi"', added: false };

    it("shows, keeps the draft, and goes along with the message", () => {
      useApp.setState({ composerFill: null });
      render(<ChatPanel />);
      type("Make this a chart");
      act(() => useApp.getState().fillComposer("", { element: ELEMENT }));
      expect((textarea() as HTMLTextAreaElement).value).toBe("Make this a chart");
      expect(screen.getByText(ELEMENT.name)).toBeTruthy();
      fireEvent.keyDown(textarea(), { key: "Enter" });
      expect(send).toHaveBeenCalledWith("Make this a chart", { includeSlide: true, attachments: [], element: ELEMENT });
      expect(screen.queryByText(ELEMENT.name)).toBeNull();
    });

    it("can be taken off, and a later plain fill takes nothing away", () => {
      useApp.setState({ composerFill: null });
      render(<ChatPanel />);
      act(() => useApp.getState().fillComposer("Tidy it", { element: ELEMENT }));
      fireEvent.click(screen.getByRole("button", { name: "Don't send element" }));
      expect(screen.queryByText(ELEMENT.name)).toBeNull();
      act(() => useApp.getState().fillComposer("Tidy it", { element: ELEMENT }));
      act(() => useApp.getState().fillComposer("Fix it"));
      // The text it came with is still in the draft, so it still goes along.
      expect(screen.getByText(ELEMENT.name)).toBeTruthy();
      expect(textarea().value).toBe("Tidy it\n\nFix it");
    });

    it("shows on the sent message", () => {
      useApp.setState({
        messages: [{ id: "u", role: "user", text: "Hi", slide: null, attachments: [], element: ELEMENT, createdAt: 1 }],
      });
      render(<ChatPanel />);
      expect(screen.getByText(`· about ${ELEMENT.name}`)).toBeTruthy();
      useApp.setState({ messages: [] });
    });
  });

  it("lets the user remove the screenshot, and a later plain fill takes nothing away", () => {
    const screenshot = "/home/.slopslides/sessions/1-ab/sketches/1-ab.png";
    render(<ChatPanel />);
    act(() => useApp.getState().fillComposer("Tidy it", { screenshot }));
    // One image: its card in the fan removes it, without opening the grid.
    fireEvent.click(screen.getByRole("button", { name: "Remove Slide screenshot" }));
    expect(screen.queryByRole("button", { name: /attached image/ })).toBeNull();
    act(() => useApp.getState().fillComposer("Tidy it", { screenshot }));
    act(() => useApp.getState().fillComposer("Fix it"));
    expect(screen.getByRole("button", { name: "Show 1 attached image" })).toBeTruthy();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Tidy it\n\nFix it", { includeSlide: true, attachments: [], screenshot });
  });
});

describe("workspace attachments", () => {
  it.each([
    [true, "talk/assets/photo.png", "/decks/talk/deck.html"],
    [false, "assets/photo.png", "/decks"],
  ])("attaches images with workspace-relative context when a deck is open: %s", async (hasDeck, reference, target) => {
    useApp.setState({
      workspace: { path: "/decks", name: "decks" },
      chatKey: "/decks",
      deck: hasDeck ? deckFor(DECK_HTML) : null,
      selected: hasDeck ? "intro" : null,
    });
    openDialog.mockResolvedValue(["/Users/me/photo.png"]);
    invoke.mockResolvedValue(["assets/photo.png"]);
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    expect(invoke).toHaveBeenCalledWith("import_assets", { id: target, paths: ["/Users/me/photo.png"] });
    expect(screen.getByAltText("photo.png").getAttribute("src")).toContain(`/decks/${reference}`);
    type("Use this");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Use this", { includeSlide: hasDeck, attachments: [reference] });
    if (!hasDeck) expect(screen.queryByRole("button", { name: /^Slide \d/ })).toBeNull();
  });
});

describe("undone agent turns", () => {
  afterEach(() => useApp.setState({ revertNotes: [] }));

  it("marks a message whose deck changes were undone", () => {
    showMessages({
      id: "u1",
      role: "user",
      text: "Bigger title",
      slide: null,
      attachments: [],
      reverted: true,
      createdAt: 0,
    });
    expect(screen.getByText("changes undone ·")).toBeTruthy();
  });

  it("shows what the next message tells the agent, and can leave it out", () => {
    useApp.setState({ revertNotes: [{ message: "u1", label: '"Bigger title"' }] });
    render(<ChatPanel />);
    expect(screen.getByText('Undone: "Bigger title"')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Don't tell the agent" }));
    expect(useApp.getState().revertNotes).toEqual([]);
    expect(screen.queryByText(/Undone:/)).toBeNull();
  });
});

describe("ChatPanel: queued messages", () => {
  const queued = (id: string, text: string, patch: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id,
    text,
    options: { includeSlide: true, attachments: [] },
    ...patch,
  });
  const list = () => within(screen.getByRole("region", { name: "Queued messages" }));

  it("shows nothing without a queue", () => {
    render(<ChatPanel />);
    expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull();
  });

  it("lists them while the agent works, to steer with or drop", () => {
    useApp.setState({ running: true, queue: [queued("q1", "Make it blue"), queued("q2", "Shorter")] });
    render(<ChatPanel />);
    expect(list().getByText("Sent when the agent finishes")).toBeTruthy();
    expect(
      list()
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Make it blue", "Shorter"]);
    fireEvent.click(list().getAllByRole("button", { name: "Steer: send into the agent's turn now" })[1]!);
    expect(steerQueued).toHaveBeenCalledWith("q2");
    fireEvent.click(list().getAllByRole("button", { name: "Remove" })[0]!);
    expect(takeQueued).toHaveBeenCalledWith("q1");
  });

  it("sends them by hand once the agent stopped", () => {
    useApp.setState({ queue: [queued("q1", "Make it blue")] });
    render(<ChatPanel />);
    expect(list().getByText("Waiting: the last turn did not finish")).toBeTruthy();
    fireEvent.click(list().getByRole("button", { name: "Send now" }));
    expect(steerQueued).toHaveBeenCalledWith("q1");
  });

  it("takes one back into the composer to edit, after the draft", () => {
    const item = queued("q1", "Make it blue", {
      options: { includeSlide: false, attachments: ["assets/a.csv"], slide: null },
    });
    takeQueued.mockReturnValue(item);
    useApp.setState({ running: true, queue: [item] });
    render(<ChatPanel />);
    type("Also");
    fireEvent.click(list().getByRole("button", { name: "Edit" }));
    expect(takeQueued).toHaveBeenCalledWith("q1");
    expect(textarea().value).toBe("Also\n\nMake it blue");
    expect(screen.getByText("a.csv")).toBeTruthy();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledWith("Also\n\nMake it blue", { includeSlide: false, attachments: ["assets/a.csv"] });
  });

  it("only lets a steer that came too late wait for the turn", () => {
    const ready = {
      user: { id: "q1", role: "user" as const, text: "Bluer", slide: null, attachments: [], createdAt: 0 },
      prompt: "Bluer",
    };
    useApp.setState({ running: true, queue: [queued("q1", "Bluer", { ready })] });
    render(<ChatPanel />);
    expect(list().queryByRole("button", { name: "Steer: send into the agent's turn now" })).toBeNull();
    expect(list().queryByRole("button", { name: "Edit" })).toBeNull();
    expect(list().getByRole("button", { name: "Remove" })).toBeTruthy();
  });
});

/** The part of the chat that scrolls, laid out as jsdom never does: `height` tall, showing `shown` of it from `top`. */
function scrollTo(container: HTMLElement, top: number, height = 2000, shown = 400) {
  const list = container.querySelector(".overflow-y-auto") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: height });
  Object.defineProperty(list, "clientHeight", { configurable: true, value: shown });
  list.scrollTop = top;
  fireEvent.scroll(list);
  return list;
}

const said = (id: string, text: string, patch: Partial<Extract<ChatMessage, { role: "user" }>> = {}): ChatMessage => ({
  id,
  role: "user",
  text,
  slide: null,
  attachments: [],
  createdAt: 0,
  ...patch,
});

const pendingApproval: ChatPart = {
  kind: "approval",
  status: "pending",
  approval: {
    id: "ap",
    title: "Run a command",
    reason: null,
    details: "ls",
    acceptLabel: "Allow",
    decisions: ["accept"],
  },
};

describe("ChatPanel: the draft belongs to the conversation", () => {
  it("keeps the draft and its attachments when the folder's chat becomes the chat of the deck it made", async () => {
    openDialog.mockResolvedValue(["/notes.md"]);
    invoke.mockResolvedValue(["assets/notes.md"]);
    useApp.setState({ chatKey: "/decks/talk", chatFollowsDeck: true });
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    type("Next, add a chart");
    const input = textarea();
    // What `followDeck` does once the turn that made the deck is over: the key changes, nothing else.
    act(() => useApp.setState({ chatKey: "/decks/talk/deck.html", chatFollowsDeck: false }));
    expect(textarea()).toBe(input);
    expect(textarea().value).toBe("Next, add a chart");
    expect(screen.getByText("notes.md")).toBeTruthy();
  });

  it("starts empty in another conversation", () => {
    render(<ChatPanel />);
    type("For this chat only");
    act(() => useApp.setState((s) => ({ chatKey: "/decks/other/deck.html", chatRevision: s.chatRevision + 1 })));
    expect(textarea().value).toBe("");
  });
});

describe("ChatPanel: retrying and reusing messages", () => {
  it("offers to retry the message of a turn that failed or was stopped", () => {
    for (const status of ["error", "interrupted"] as const) {
      showMessages(said("u", "Make it blue"), reply({ status, error: status === "error" ? "boom" : null }));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      cleanup();
    }
    expect(retryLast).toHaveBeenCalledTimes(2);
  });

  it("offers no retry for a turn that went well, an earlier one, or while the agent works", () => {
    showMessages(said("u", "Make it blue"), reply({ status: "done" }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    cleanup();
    showMessages(
      said("u1", "First"),
      reply({ id: "a1", status: "error", error: "boom" }),
      said("u2", "Second"),
      reply({ id: "a2", status: "done" }),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    cleanup();
    useApp.setState({ running: true });
    showMessages(said("u", "Make it blue"), reply({ status: "interrupted" }));
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("puts a sent message back into the composer to edit, without sending it", () => {
    showMessages(said("u", "Make it blue"), reply({ parts: [{ kind: "text", text: "Done" }] }));
    type("And bigger");
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(textarea().value).toBe("And bigger\n\nMake it blue");
    expect(document.activeElement).toBe(textarea());
    expect(send).not.toHaveBeenCalled();
    // Copy stays beside it.
    expect(screen.getAllByRole("button", { name: "Copy message" }).length).toBe(2);
  });

  it("does not offer to edit a command", () => {
    showMessages(said("u", "/compact", { command: "compact" }), reply({ compacted: true }));
    expect(screen.queryByRole("button", { name: "Edit message" })).toBeNull();
  });
});

describe("ChatPanel: staying with the conversation", () => {
  it("offers to jump to the latest message once scrolled up, and jumps", () => {
    const { container } = showMessages(said("u", "Hi"), reply({ parts: [{ kind: "text", text: "Hello" }] }));
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
    const list = scrollTo(container, 0);
    const pill = screen.getByRole("button", { name: "Jump to latest message" });
    expect(pill.textContent).toBe(" Jump to latest");
    fireEvent.click(pill);
    expect(list.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });

  it("says on the pill that an approval is needed down there", () => {
    useApp.setState({ running: true });
    const { container } = showMessages(said("u", "Hi"), reply({ status: "streaming", parts: [pendingApproval] }));
    const list = scrollTo(container, 0);
    const pill = screen.getByRole("button", { name: "Approval needed: jump to the request" });
    expect(pill.textContent).toContain("Approval needed");
    expect(pill.className).toContain("text-warning");
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
    fireEvent.click(pill);
    expect(list.scrollTop).toBe(2000);
  });

  it("does not ask for an approval on the pill once the request is answered or the turn over", () => {
    useApp.setState({ running: false });
    const closed: ChatPart = { ...pendingApproval, status: "expired" } as ChatPart;
    const { container } = showMessages(said("u", "Hi"), reply({ status: "interrupted", parts: [closed] }));
    scrollTo(container, 0);
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
  });

  it("goes to the bottom when the user sends, wherever they had scrolled to", () => {
    const { container } = showMessages(said("u", "Hi"), reply({ parts: [{ kind: "text", text: "Hello" }] }));
    const list = scrollTo(container, 0);
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();
    // A reply coming in does not pull a reader back down.
    act(() =>
      useApp.setState((s) => ({
        messages: [...s.messages.slice(0, 1), reply({ parts: [{ kind: "text", text: "Hello there" }] })],
      })),
    );
    expect(list.scrollTop).toBe(0);
    act(() => useApp.setState((s) => ({ messages: [...s.messages, said("u2", "And another thing")] })));
    expect(list.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });
});

describe("ChatPanel: links in replies", () => {
  const openPath = vi.fn(async () => {});
  const realOpenPath = useApp.getState().openPath;
  beforeEach(() => {
    openPath.mockClear();
    useApp.setState({ openPath });
  });
  afterEach(() => useApp.setState({ openPath: realOpenPath }));
  const withLinks = () =>
    showMessages(
      reply({
        parts: [
          {
            kind: "text",
            text: "See [the docs](https://example.com/a?b=1), [the notes](talk/notes.md), [here](#top) and [outside](/etc/passwd).",
          },
        ],
      }),
    );

  it("opens a web address in the system's browser, never in the app's window", () => {
    withLinks();
    // `fireEvent` gives back false when the click was kept from doing what a link does.
    expect(fireEvent.click(screen.getByRole("link", { name: "the docs" }))).toBe(false);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a?b=1");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("opens a file of the workspace in the app", () => {
    withLinks();
    expect(fireEvent.click(screen.getByRole("link", { name: "the notes" }))).toBe(false);
    expect(openPath).toHaveBeenCalledWith("/decks/talk/talk/notes.md");
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("goes nowhere for anything else, and still keeps the window where it is", () => {
    withLinks();
    for (const name of ["here", "outside"]) {
      expect(fireEvent.click(screen.getByRole("link", { name }))).toBe(false);
    }
    expect(openUrl).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it("reports a link the system could not open", async () => {
    openUrl.mockRejectedValueOnce(new Error("No browser"));
    withLinks();
    fireEvent.click(screen.getByRole("link", { name: "the docs" }));
    await waitFor(() => expect(lastError(useApp.getState())).toBe("No browser"));
  });
});

describe("ChatPanel: keys of the message input", () => {
  it("says on the send button which keys send and break the line", () => {
    render(<ChatPanel />);
    expect(sendButton().title).toBe("Send (Enter) · New line (Shift+Enter)");
  });

  it("stops the running turn with Escape in the empty input", () => {
    useApp.setState({ running: true });
    render(<ChatPanel />);
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("does not stop the turn with Escape over a draft, with a modifier, or without a turn", () => {
    render(<ChatPanel />);
    fireEvent.keyDown(textarea(), { key: "Escape" });
    act(() => useApp.setState({ running: true }));
    fireEvent.keyDown(textarea(), { key: "Escape", shiftKey: true });
    type("Half a thought");
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("leaves Escape to what is open over the app, which it closes first", () => {
    useApp.setState({ running: true });
    render(<ChatPanel />);
    const closed = vi.fn();
    const close = openLayer(closed);
    try {
      fireEvent.keyDown(textarea(), { key: "Escape" });
      expect(interrupt).not.toHaveBeenCalled();
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      close();
    }
    fireEvent.keyDown(textarea(), { key: "Escape" });
    expect(interrupt).toHaveBeenCalledOnce();
  });

  it("brings back the last message sent with the up arrow in the empty input", () => {
    showMessages(
      said("u1", "First"),
      reply({ id: "a1" }),
      said("u2", "Second\nline"),
      reply({ id: "a2" }),
      said("u3", "/compact", { command: "compact" }),
      reply({ id: "a3", compacted: true }),
    );
    expect(fireEvent.keyDown(textarea(), { key: "ArrowUp" })).toBe(false);
    expect(textarea().value).toBe("Second\nline");
    expect(send).not.toHaveBeenCalled();
  });

  it("leaves the up arrow to the text once there is a draft, and with nothing sent", () => {
    render(<ChatPanel />);
    expect(fireEvent.keyDown(textarea(), { key: "ArrowUp" })).toBe(true);
    expect(textarea().value).toBe("");
    cleanup();
    showMessages(said("u1", "First"), reply({}));
    type("Draft");
    expect(fireEvent.keyDown(textarea(), { key: "ArrowUp" })).toBe(true);
    expect(textarea().value).toBe("Draft");
  });

  it("takes the keyboard focus when the app asks for it", () => {
    render(<ChatPanel />);
    (screen.getByTitle("Attach images or files") as HTMLButtonElement).focus();
    expect(document.activeElement).not.toBe(textarea());
    act(() => useApp.getState().focusComposer());
    expect(document.activeElement).toBe(textarea());
  });
});

describe("ChatPanel: an agent that is not installed", () => {
  const missing = (id: string) => PROVIDERS.map((p) => (p.id === id ? { ...p, installed: false, models: [] } : p));
  const banner = () => within(screen.getByRole("alert"));

  it("shows the install command as code, with a button that copies it", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    useApp.setState({
      providers: missing("codex"),
      selection: { provider: "codex", model: "gpt-6-astra", label: "GPT-6-Astra", effort: "high", contextWindow: null },
    });
    render(<ChatPanel />);
    expect(banner().getByText("Codex is not installed.")).toBeTruthy();
    const command = banner().getByText("npm i -g @openai/codex");
    expect(command.tagName).toBe("CODE");
    // No literal backticks: they were Markdown, which nothing rendered.
    expect(screen.getByRole("alert").textContent).not.toContain("`");
    await act(async () => fireEvent.click(banner().getByRole("button", { name: "Copy npm i -g @openai/codex" })));
    expect(writeText).toHaveBeenCalledWith("npm i -g @openai/codex");
  });

  it("looks again when asked, keeping the banner until the answer says otherwise", async () => {
    useApp.setState({ providers: missing("claude") });
    invoke.mockImplementation(async (command: string) => (command === "list_providers" ? PROVIDERS : []));
    render(<ChatPanel />);
    expect(banner().getByText(/Or pick another model below/)).toBeTruthy();
    expect(banner().queryByRole("button", { name: "New chat" })).toBeNull();
    await act(async () => fireEvent.click(banner().getByRole("button", { name: "Check again" })));
    expect(invoke).toHaveBeenCalledWith("list_providers");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stays, with what was known, when looking again finds nothing new or fails", async () => {
    useApp.setState({ providers: missing("claude") });
    invoke.mockImplementation(async (command: string) => {
      if (command === "list_providers") throw new Error("offline");
      return [];
    });
    render(<ChatPanel />);
    await act(async () => fireEvent.click(banner().getByRole("button", { name: "Check again" })));
    expect(banner().getByText("Claude Code is not installed.")).toBeTruthy();
    expect(useApp.getState().providers).toEqual(missing("claude"));
  });

  it("looks again when the window gets the focus back, as after installing it in a terminal", async () => {
    useApp.setState({ providers: missing("claude") });
    invoke.mockImplementation(async (command: string) => (command === "list_providers" ? PROVIDERS : []));
    const view = render(<ChatPanel />);
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(invoke).toHaveBeenCalledWith("list_providers");
    expect(screen.queryByRole("alert")).toBeNull();
    // With every CLI there, coming back to the window asks nothing.
    invoke.mockClear();
    await act(async () => void window.dispatchEvent(new Event("focus")));
    expect(invoke).not.toHaveBeenCalledWith("list_providers");
    view.unmount();
  });

  it("sends a chat that belongs to that agent to a new chat, not to another model", () => {
    useApp.setState({ providers: missing("claude"), sessionProvider: "claude" });
    showMessages(said("u", "Hi"), reply({ provider: "claude" }));
    expect(banner().getByText("Start a new chat to use another agent.")).toBeTruthy();
    expect(banner().queryByText(/pick another model/)).toBeNull();
    fireEvent.click(banner().getByRole("button", { name: "New chat" }));
    expect(resetChat).toHaveBeenCalledOnce();
  });

  it("says why a new chat has to wait while the agent works", () => {
    useApp.setState({ providers: missing("claude"), sessionProvider: "claude", running: true });
    showMessages(said("u", "Hi"), reply({ provider: "claude", status: "streaming" }));
    const button = banner().getByRole("button", { name: "New chat" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Stop the current turn to start a new chat");
  });
});

describe("ChatPanel: steps of a reply", () => {
  const edits = (count: number) =>
    Array.from({ length: count }, (_, i) => tool("Edit", { file_path: `/decks/talk/assets/${i}.css` }));

  it("folds the tool calls of a finished reply into one line, which unfolds", () => {
    showMessages(reply({ parts: [{ kind: "text", text: "On it." }, ...edits(12), { kind: "text", text: "Done." }] }));
    const steps = screen.getByRole("button", { name: "12 steps" });
    expect(steps.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Edited/ })).toBeNull();
    fireEvent.click(steps);
    expect(screen.getAllByRole("button", { name: /^Edited/ })).toHaveLength(12);
    fireEvent.click(steps);
    expect(screen.queryByRole("button", { name: /^Edited/ })).toBeNull();
  });

  it("shows each step as it happens while the reply comes in", () => {
    useApp.setState({ running: true });
    showMessages(reply({ status: "streaming", parts: edits(3) }));
    expect(screen.queryByRole("button", { name: /steps/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Edited/ })).toHaveLength(3);
  });

  it("says when steps failed, and leaves a single tool call as it is", () => {
    const failed = tool("Bash", { command: "false" }, "error", "exit 1");
    showMessages(
      reply({ parts: [...edits(2), failed, { kind: "text", text: "Hm." }, tool("Read", { file_path: "/x" })] }),
    );
    expect(screen.getByRole("button", { name: "3 steps · 1 failed" })).toBeTruthy();
    expect(toolRow("Read /x")).toBeTruthy();
  });

  it("names the app's own tools in plain words, and other tools without their server", () => {
    showMessages(
      reply({ parts: [tool("mcp__slopslide__lint_deck", { path: "talk/deck.html" })] }),
      reply({ id: "a2", parts: [tool("mcp__github__create_issue", { title: "x" })] }),
    );
    expect(toolRow("Checked the deck's HTML talk/deck.html")).toBeTruthy();
    expect(toolRow("Create issue")).toBeTruthy();
    expect(screen.queryByText(/mcp__/)).toBeNull();
    // The name as the agent has it is still in the details.
    fireEvent.click(screen.getAllByRole("button", { name: /^Show arguments and output/ })[1]!);
    expect(screen.getByText("Arguments · mcp__github__create_issue")).toBeTruthy();
  });
});

describe("ChatPanel: attachments still being saved", () => {
  const paste = (files: File[]) => fireEvent.paste(textarea(), { clipboardData: { files, getData: () => "" } });
  const shot = () => new File(["hi"], "image.png", { type: "image/png" });
  /** A `save_asset` that answers when told to. */
  function slowSave() {
    let finish!: (path: string) => void;
    let fail!: (error: Error) => void;
    invoke.mockImplementation((command: string) =>
      command === "save_asset"
        ? new Promise<string>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          })
        : Promise.resolve([]),
    );
    return {
      /** Once the image is read and its saving began. */
      asked: () => waitFor(() => expect(invoke).toHaveBeenCalledWith("save_asset", expect.anything())),
      finish: (path: string) => act(async () => finish(path)),
      fail: (e: Error) => act(async () => fail(e)),
    };
  }

  it("shows that an attachment is on its way, and holds a message sent meanwhile until it is there", async () => {
    const save = slowSave();
    render(<ChatPanel />);
    type("What is this?");
    await act(async () => paste([shot()]));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Attaching…"));
    await save.asked();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("What is this?");
    expect(sendButton().getAttribute("aria-busy")).toBe("true");
    expect(sendButton().title).toBe("Sends once the attachment is saved");
    await save.finish("assets/pasted-image.png");
    expect(send).toHaveBeenCalledWith("What is this?", {
      includeSlide: true,
      attachments: ["assets/pasted-image.png"],
    });
    expect(textarea().value).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByLabelText(/attached image/)).toBeNull();
  });

  it("attaches what was saved while the chat was out of view, and sends the message held for it", async () => {
    const save = slowSave();
    const { rerender } = render(<ChatPanel active />);
    type("What is this?");
    await act(async () => paste([shot()]));
    await save.asked();
    fireEvent.keyDown(textarea(), { key: "Enter" });
    rerender(<ChatPanel active={false} />);
    await save.finish("assets/pasted-image.png");
    expect(send).not.toHaveBeenCalled();

    rerender(<ChatPanel active />);
    expect(send).toHaveBeenCalledWith("What is this?", {
      includeSlide: true,
      attachments: ["assets/pasted-image.png"],
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the message back when its attachment could not be saved", async () => {
    const save = slowSave();
    render(<ChatPanel />);
    type("What is this?");
    await act(async () => paste([shot()]));
    await save.asked();
    fireEvent.click(sendButton());
    await save.fail(new Error("disk full"));
    expect(send).not.toHaveBeenCalled();
    expect(textarea().value).toBe("What is this?");
    expect(lastError(useApp.getState())).toBe("disk full");
    expect(sendButton().getAttribute("aria-busy")).toBeNull();
    // Sent again, it goes out without it.
    fireEvent.click(sendButton());
    expect(send).toHaveBeenCalledWith("What is this?", { includeSlide: true, attachments: [] });
  });

  it("sends at once when nothing is being saved", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { name: string }) => `assets/${args.name}`);
    render(<ChatPanel />);
    await act(async () => paste([shot()]));
    await waitFor(() => expect(screen.getByLabelText("Show 1 attached image")).toBeTruthy());
    type("Now");
    fireEvent.keyDown(textarea(), { key: "Enter" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("offers every kind of file in the picker", async () => {
    openDialog.mockResolvedValue(null);
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    const { filters } = openDialog.mock.calls[0]![0] as { filters: { name: string; extensions: string[] }[] };
    expect(filters.at(-1)).toEqual({ name: "All files", extensions: ["*"] });
  });

  it("removes an image from its card in the fan while there are four or fewer", async () => {
    const names = ["a.png", "b.jpg", "c.gif"];
    openDialog.mockResolvedValue(names.map((n) => `/${n}`));
    invoke.mockResolvedValue(names.map((n) => `assets/${n}`));
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    fireEvent.click(screen.getByRole("button", { name: "Remove b.jpg" }));
    // One step: the grid never opened.
    expect(screen.queryByRole("dialog", { name: "Attached images" })).toBeNull();
    expect(screen.getByLabelText("Show 2 attached images")).toBeTruthy();
    expect(screen.queryByAltText("b.jpg")).toBeNull();
  });

  it("says where to drop while files are dragged over the window", async () => {
    render(<ChatPanel />);
    await waitFor(() => expect(dragDrop).not.toBeNull());
    expect(screen.queryByTestId("drop-overlay")).toBeNull();
    act(() => dragDrop!({ payload: { type: "enter", paths: ["/tmp/a.png"], position: { x: 10, y: 10 } } }));
    expect(screen.getByTestId("drop-overlay").textContent).toBe("Drop to attach");
    act(() => dragDrop!({ payload: { type: "leave" } }));
    expect(screen.queryByTestId("drop-overlay")).toBeNull();
  });
});

describe("ChatPanel: the chat's header", () => {
  const thread = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
    id,
    title,
    current: false,
    createdAt: Date.now() - 2 * 3_600_000,
    messageCount: 4,
    association: null,
    deck: null,
    ...patch,
  });
  const selectChatThread = vi.fn(async () => {});
  const realSelect = useApp.getState().selectChatThread;
  beforeEach(() => {
    selectChatThread.mockClear();
    useApp.setState({ selectChatThread });
  });
  afterEach(() => useApp.setState({ selectChatThread: realSelect }));
  const threads = (...items: unknown[]) =>
    invoke.mockImplementation(async (command: string) => (command === "list_chat_threads" ? items : []));
  const openList = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
    await waitFor(() => expect(screen.queryByText("Loading chats…")).toBeNull());
  };
  const search = () => screen.getByRole("textbox", { name: "Search chats" });

  it("calls them chats everywhere, and starts a new one with a compose icon", async () => {
    threads();
    render(<ChatPanel />);
    const fresh = screen.getByRole("button", { name: "New chat" });
    expect(fresh.title).toBe("New chat (files are kept)");
    expect(fresh.querySelector(".lucide-square-pen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
    expect(screen.getByRole("region", { name: "Past chats" })).toBeTruthy();
    expect(screen.getByText("Loading chats…")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Loading chats…")).toBeNull());
    expect(document.body.textContent).not.toMatch(/conversation/i);
  });

  it("says when there are no past chats, and when none match", async () => {
    threads();
    render(<ChatPanel />);
    await openList();
    expect(screen.getByText("No past chats yet.")).toBeTruthy();
    cleanup();
    threads(thread("a", "Quarterly pitch"));
    render(<ChatPanel />);
    await openList();
    fireEvent.change(search(), { target: { value: "zebra" } });
    expect(screen.getByText("No chats match.")).toBeTruthy();
    expect(screen.queryByText("No past chats yet.")).toBeNull();
  });

  it("counts one message as one, and says how long ago a chat started", async () => {
    threads(
      thread("a", "Short", { messageCount: 1 }),
      thread("b", "Long"),
      thread("c", "Blank", { createdAt: null, messageCount: 0 }),
    );
    render(<ChatPanel />);
    await openList();
    expect(screen.getByRole("button", { name: /Short/ }).textContent).toContain("Started 2h ago · 1 message");
    expect(screen.getByRole("button", { name: /Short/ }).textContent).not.toContain("1 messages");
    expect(screen.getByRole("button", { name: /Long/ }).textContent).toContain("4 messages");
    expect(screen.getByRole("button", { name: /Blank/ }).textContent).toContain("Empty chat · 0 messages");
  });

  it("opens with the keyboard in the search field, and goes through the chats with the arrows and Enter", async () => {
    threads(
      thread("a", "Alpha", { current: true }),
      thread("b", "Beta"),
      thread("c", "Gamma", { deck: "/decks/talk/g.html" }),
    );
    render(<ChatPanel />);
    await openList();
    expect(document.activeElement).toBe(search());
    const marked = () =>
      screen.getAllByRole("button").find((b) => b.dataset.index && b.className.includes(" bg-accent"));
    expect(marked()!.textContent).toContain("Alpha");
    // The chat on show cannot be gone on with: Enter on it does nothing.
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(selectChatThread).not.toHaveBeenCalled();
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(marked()!.textContent).toContain("Gamma");
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(marked()!.textContent).toContain("Beta");
    await act(async () => fireEvent.keyDown(search(), { key: "Enter" }));
    expect(selectChatThread).toHaveBeenCalledWith("b", null);
    expect(screen.queryByRole("region", { name: "Past chats" })).toBeNull();
  });

  it("starts each look at the list from all of it", async () => {
    threads(thread("a", "Alpha"), thread("b", "Beta"));
    render(<ChatPanel />);
    await openList();
    fireEvent.change(search(), { target: { value: "beta" } });
    expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Past chats" }));
    await openList();
    expect(search()).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: /Alpha/ })).toBeTruthy();
  });

  it("says why a new chat has to wait while the agent works", () => {
    useApp.setState({ running: true });
    render(<ChatPanel />);
    const fresh = screen.getByRole("button", { name: "New chat" }) as HTMLButtonElement;
    expect(fresh.disabled).toBe(true);
    expect(fresh.title).toBe("Stop the current turn to start a new chat");
  });

  it("dims the chat and holds it still while it switches", async () => {
    let done!: () => void;
    resetChat.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    const { container } = render(<ChatPanel />);
    const body = container.querySelector("[inert], .transition-opacity") as HTMLElement;
    expect(body.className).not.toContain("opacity-50");
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(body.className).toContain("opacity-50");
    expect(body.hasAttribute("inert")).toBe(true);
    expect(body.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("button", { name: "Switching…" })).toBeTruthy();
    await act(async () => done());
    expect(body.className).not.toContain("opacity-50");
    expect(body.hasAttribute("inert")).toBe(false);
  });
});

describe("ChatPanel: what goes along with a message", () => {
  it("says with the slide chip whether the slide goes along", () => {
    render(<ChatPanel />);
    const chip = screen.getByRole("button", { name: "Slide 1" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("cuts a long file name short on its chip, with a target of its own to remove it", async () => {
    const name = "a-very-long-file-name-that-would-push-the-chips-out-of-the-composer.csv";
    openDialog.mockResolvedValue([`/${name}`]);
    invoke.mockResolvedValue([`assets/${name}`]);
    render(<ChatPanel />);
    await act(async () => fireEvent.click(screen.getByTitle("Attach images or files")));
    const label = screen.getByText(name);
    expect(label.className).toContain("truncate");
    expect(label.parentElement!.className).toContain("max-w-full");
    expect(label.parentElement!.title).toBe(`assets/${name}`);
    expect(screen.getByRole("button", { name: `Remove ${name}` }).className).toContain("size-5");
  });

  it("shows on a queued message what goes along with it", () => {
    useApp.setState({
      running: true,
      queue: [
        { id: "q1", text: "Plain", options: { includeSlide: false, attachments: [], slide: null } },
        {
          id: "q2",
          text: "With things",
          options: {
            includeSlide: true,
            slide: "outro",
            attachments: ["assets/a.png", "assets/b.csv"],
            screenshot: "/home/.slopslides/sessions/1-ab/sketches/1-ab.png",
          },
        },
      ],
    });
    render(<ChatPanel />);
    const rows = within(screen.getByRole("region", { name: "Queued messages" })).getAllByRole("listitem");
    expect(rows[0]!.textContent).toBe("Plain");
    expect(rows[1]!.textContent).toBe("With thingsSlide 3 · 2 attachments · screenshot");
  });
});
