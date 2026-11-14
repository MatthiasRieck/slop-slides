// What renders when: typing, an event of the agent's, a save of the deck and a chat out of view
// must each cost what they change, not what the conversation holds.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { memo, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

/** The texts handed to the Markdown parser, in order: each is one parse. */
const parsed: string[] = [];
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const Counted: typeof actual.default = (props) => {
    parsed.push(String(props.children));
    return actual.default(props);
  };
  return { ...actual, default: Counted };
});

/** How often each part of the chat rendered: the chat's own parts by name, messages by their ids. */
const renders: Record<string, number> = {};
const count = (name: string) => {
  renders[name] = (renders[name] ?? 0) + 1;
};
// Rendered by the panel each time that renders (and when the turn starts or ends, which it shows).
vi.mock("./ThreadNavigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ThreadNavigation")>();
  const ThreadNavigation: typeof actual.ThreadNavigation = (props) => {
    count("header");
    return actual.ThreadNavigation(props);
  };
  return { ThreadNavigation };
});
vi.mock("./Composer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Composer")>();
  const Composer: typeof actual.Composer = () => {
    count("composer");
    return actual.Composer();
  };
  return { ...actual, Composer };
});
// The messages render when the list hands them something new, which is what these count.
vi.mock("./AssistantBlock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./AssistantBlock")>();
  const AssistantBlock = memo((props: Parameters<typeof actual.AssistantBlock>[0]) => {
    count(props.message.id);
    return <actual.AssistantBlock {...props} />;
  });
  return { AssistantBlock };
});
vi.mock("./UserBubble", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./UserBubble")>();
  const UserBubble = memo((props: Parameters<typeof actual.UserBubble>[0]) => {
    count(props.message.id);
    return <actual.UserBubble {...props} />;
  });
  return { UserBubble };
});

import { type AssistantMessage, type ChatMessage, type ChatPart, useApp } from "../../store";
import { applyAgentEvent } from "../../store/chat";
import { forgetDrafts } from "../../store/composer";
import { DECK_HTML, deckFor } from "../../test/fixtures";
import { invoke } from "../../test/tauri";
import { ChatPanel } from "../ChatPanel";
import { MessageList } from "./MessageList";

const said = (id: string, text: string, slide: string | null = null): ChatMessage => ({
  id,
  role: "user",
  text,
  slide,
  attachments: [],
  createdAt: 0,
});

const reply = (id: string, parts: ChatPart[], patch: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  role: "assistant",
  parts,
  status: "done",
  thinking: false,
  error: null,
  costUsd: null,
  durationMs: null,
  createdAt: 0,
  ...patch,
});

const text = (value: string): ChatPart => ({ kind: "text", text: value });
const edit = (id: string, slide: string): ChatPart => ({
  kind: "tool",
  id,
  name: "Edit",
  input: { file_path: "/decks/talk/deck.html", new_string: `<section class="slide" id="${slide}">` },
  status: "done",
});

/** A conversation of `turns` questions and answers, each answer a text of two blocks and an edit of the deck. */
const transcript = (turns: number): ChatMessage[] =>
  Array.from({ length: turns }, (_, i) => [
    said(`u${i}`, `Question ${i}`, "intro"),
    reply(`a${i}`, [text(`Answer ${i}.\n\n- with\n- a list`), edit(`t${i}`, "intro")]),
  ]).flat();

const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

/** Forgets what rendered so far: what is counted from here is what the next step costs. */
function startCounting() {
  parsed.length = 0;
  for (const name of Object.keys(renders)) delete renders[name];
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue([]);
  forgetDrafts();
  useApp.setState({
    workspace: { path: "/decks/talk", name: "talk" },
    chatKey: "/decks/talk/deck.html",
    deck: deckFor(DECK_HTML),
    selected: "intro",
    messages: [],
    queue: [],
    running: false,
    providers: [],
    composerFill: null,
    composerImages: [],
    revertNotes: [],
    rewindAsk: null,
  });
});

afterEach(() => vi.useRealTimers());

describe("typing in the composer", () => {
  it("renders the composer once per key, and nothing else of the chat", () => {
    useApp.setState({ messages: transcript(15) });
    render(<ChatPanel />);
    expect(useApp.getState().messages).toHaveLength(30);
    expect(parsed.length).toBeGreaterThan(0);
    startCounting();

    const draft = "Make it red";
    for (let length = 1; length <= draft.length; length++) {
      fireEvent.change(textarea(), { target: { value: draft.slice(0, length) } });
    }
    expect(textarea().value).toBe(draft);
    expect(parsed).toEqual([]);
    expect(renders).toEqual({ composer: draft.length });
  });

  it("renders nothing of the conversation when a prepared message is handed over", () => {
    useApp.setState({ messages: transcript(3) });
    render(<ChatPanel />);
    startCounting();
    act(() => useApp.getState().fillComposer("Fix the lint issues"));
    expect(textarea().value).toBe("Fix the lint issues");
    expect(parsed).toEqual([]);
    expect(Object.keys(renders)).toEqual(["composer"]);
  });
});

describe("a reply coming in", () => {
  const streaming = () => {
    const last = reply("now", [text("First block.\n\nSecond")], { status: "streaming" });
    useApp.setState({ messages: [...transcript(15), said("ask", "And now?"), last], running: true });
    render(<ChatPanel />);
    startCounting();
  };
  const delta = (more: string) => act(() => applyAgentEvent(useApp, { type: "textDelta", text: more }));

  it("parses only the last block of the reply when text comes in", () => {
    streaming();
    delta(" block");
    delta(" grows.");
    expect(parsed).toEqual(["\nSecond block", "\nSecond block grows."]);
    expect(screen.getByText("Second block grows.")).toBeTruthy();
  });

  it("renders the reply alone: no message before it, not the panel, not the composer", () => {
    streaming();
    delta(" block");
    delta(" grows.");
    expect(renders).toEqual({ now: 2 });
  });

  it("parses a finished block once more when the next one starts, and then no more", () => {
    streaming();
    delta(" block.\n\n");
    delta("Third");
    delta(" block.");
    // The second block gives its blank lines to the third as that starts.
    expect(parsed).toEqual(["\nSecond block.\n\n", "\nSecond block.\n", "\nThird", "\nThird block."]);
  });

  it("renders only the reply for a tool call and its result", () => {
    streaming();
    act(() => applyAgentEvent(useApp, { type: "toolUse", id: "call", name: "Read", input: { file_path: "a.md" } }));
    act(() => applyAgentEvent(useApp, { type: "toolResult", id: "call", output: "read", isError: false, images: [] }));
    expect(parsed).toEqual([]);
    expect(renders).toEqual({ now: 2 });
  });

  it("renders the reply alone of the messages when the turn ends, and parses nothing again", () => {
    streaming();
    act(() => applyAgentEvent(useApp, { type: "finished", interrupted: false }));
    expect(parsed).toEqual([]);
    // The header and the composer show that the agent is done; of the messages only the reply changed.
    const { header: _header, composer: _composer, ...messages } = renders;
    expect(messages).toEqual({ now: 1 });
  });
});

describe("the deck changing under the conversation", () => {
  /** Renders the conversation alone, counting every time anything in it renders. */
  const shown = (messages: ChatMessage[]) => {
    const commits = vi.fn();
    useApp.setState({ messages });
    render(
      <Profiler id="conversation" onRender={commits}>
        <MessageList />
      </Profiler>,
    );
    commits.mockClear();
    return commits;
  };

  it("renders nothing when the deck is another with the same slides, as after every save", () => {
    const commits = shown(transcript(15));
    expect(screen.getAllByText("on slide 1")).toHaveLength(15);
    const deck = useApp.getState().deck!;
    act(() => useApp.setState({ deck: { ...deck, shellHash: "another", slides: deck.slides.map((s) => ({ ...s })) } }));
    expect(commits).not.toHaveBeenCalled();
  });

  it("renders nothing when the deck is saved under replies that say what they changed and steps that sum up", () => {
    const changes = { message: "u0", changed: ["intro"], added: ["outro"], removed: 0 };
    const steps = [edit("s1", "intro"), edit("s2", "outro"), edit("s3", "intro")];
    const commits = shown([...transcript(5), said("u9", "More"), reply("a9", steps, { changes })]);
    expect(screen.getByTestId("turn-changes")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edited 2 slides" })).toBeTruthy();
    const deck = useApp.getState().deck!;
    act(() => useApp.setState({ deck: { ...deck, shellHash: "another", slides: deck.slides.map((s) => ({ ...s })) } }));
    expect(commits).not.toHaveBeenCalled();
  });

  it("still follows the slides: a slide moved is named by its new number, one gone not at all", () => {
    shown([said("u", "Change it", "outro"), reply("a", [edit("t", "outro")])]);
    const deck = useApp.getState().deck!;
    const number = deck.slides.findIndex((slide) => slide.id === "outro") + 1;
    expect(number).toBeGreaterThan(1);
    expect(screen.getByText(`on slide ${number}`)).toBeTruthy();
    expect(screen.getByText(`· slide ${number}`)).toBeTruthy();

    const first = deck.slides.find((slide) => slide.id === "outro")!;
    const rest = deck.slides.filter((slide) => slide !== first);
    act(() => useApp.setState({ deck: { ...deck, slides: [first, ...rest] } }));
    expect(screen.getByText("on slide 1")).toBeTruthy();
    expect(screen.getByText("· slide 1")).toBeTruthy();

    act(() => useApp.setState({ deck: { ...deck, slides: rest } }));
    expect(screen.queryByText(/on slide/)).toBeNull();
    expect(screen.queryByText(/· slide/)).toBeNull();
  });
});

describe("the chat out of view", () => {
  const streaming = (): ChatMessage[] => [
    ...transcript(2),
    said("ask", "And now?"),
    reply("now", [text("So far")], { status: "streaming", createdAt: Date.now() }),
  ];

  it("renders and parses nothing while the agent goes on, and catches up when shown again", () => {
    useApp.setState({ messages: streaming(), running: true });
    const { rerender } = render(<ChatPanel active />);
    rerender(<ChatPanel active={false} />);
    startCounting();

    act(() => applyAgentEvent(useApp, { type: "textDelta", text: ", and more" }));
    act(() => applyAgentEvent(useApp, { type: "toolUse", id: "call", name: "Read", input: {} }));
    act(() => useApp.setState({ deck: deckFor(DECK_HTML) }));
    expect(parsed).toEqual([]);
    expect(renders).toEqual({});

    rerender(<ChatPanel active />);
    expect(screen.getByText("So far, and more")).toBeTruthy();
    // Only what changed meanwhile was read again.
    expect(parsed).toEqual(["So far, and more"]);
  });

  it("counts no seconds, and shows how long the turn has taken when it is back", () => {
    vi.useFakeTimers();
    useApp.setState({ messages: streaming(), running: true });
    const { rerender } = render(<ChatPanel active />);
    const elapsed = () => screen.getByTestId("reply-status").lastElementChild!.textContent;
    act(() => void vi.advanceTimersByTime(3000));
    expect(elapsed()).toBe("3s");

    rerender(<ChatPanel active={false} />);
    expect(vi.getTimerCount()).toBe(0);
    act(() => void vi.advanceTimersByTime(60_000));

    rerender(<ChatPanel active />);
    expect(elapsed()).toBe("1m 03s");
    act(() => void vi.advanceTimersByTime(1000));
    expect(elapsed()).toBe("1m 04s");
  });

  it("keeps the draft and the tool calls unfolded", () => {
    useApp.setState({ messages: transcript(1) });
    const { rerender } = render(<ChatPanel active />);
    fireEvent.change(textarea(), { target: { value: "Half a thought" } });
    fireEvent.click(screen.getByRole("button", { name: /^Show details of/ }));
    expect(screen.getByText("Asked for")).toBeTruthy();

    rerender(<ChatPanel active={false} />);
    rerender(<ChatPanel active />);
    expect(textarea().value).toBe("Half a thought");
    expect(screen.getByText("Asked for")).toBeTruthy();
  });

  it("is hidden, not gone, and takes the keyboard focus when the app asks for the composer", () => {
    const { rerender, container } = render(<ChatPanel active={false} />);
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.style.display).toBe("none");

    rerender(<ChatPanel active />);
    act(() => useApp.getState().focusComposer());
    expect(panel.style.display).toBe("");
    expect(document.activeElement).toBe(textarea());
  });

  it("takes a message prepared while it was hidden when it is shown, once", () => {
    const { rerender } = render(<ChatPanel active />);
    fireEvent.change(textarea(), { target: { value: "Typed before" } });
    rerender(<ChatPanel active={false} />);
    act(() => useApp.getState().fillComposer("Fix it"));
    expect(useApp.getState().composerFill).not.toBeNull();

    rerender(<ChatPanel active />);
    expect(textarea().value).toBe("Typed before\n\nFix it");
    expect(useApp.getState().composerFill).toBeNull();
    rerender(<ChatPanel active={false} />);
    rerender(<ChatPanel active />);
    expect(textarea().value).toBe("Typed before\n\nFix it");
  });
});

describe("a message of the conversation", () => {
  it("is marked for the browser to leave out of the layout while out of view", () => {
    useApp.setState({ messages: transcript(2) });
    const { container } = render(<MessageList />);
    expect(container.querySelectorAll(".chat-message")).toHaveLength(4);
  });
});
