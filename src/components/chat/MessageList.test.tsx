// Staying with the conversation: at its end while the reader is there, where they are when they
// are not, and with what they send. The scrolling itself is the `MessageScroller`'s; what is
// checked here is that the chat's messages, its hiding and its jump button work with it.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Activity, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AssistantMessage, type ChatMessage, useApp } from "../../store";
import { applyAgentEvent } from "../../store/chat";
import { layOutConversation, nextFrame } from "./conversationLayout.testing";
import { MessageList } from "./MessageList";

/** What the browser tells of sizes, by hand: jsdom lays nothing out. */
const observers: { watched: Element[]; tell: () => void }[] = [];
class ResizeObserverStub {
  private readonly entry: { watched: Element[]; tell: () => void };
  constructor(callback: ResizeObserverCallback) {
    this.entry = { watched: [], tell: () => callback([], this as unknown as ResizeObserver) };
    observers.push(this.entry);
  }
  observe(el: Element) {
    this.entry.watched.push(el);
  }
  unobserve() {}
  disconnect() {
    observers.splice(observers.indexOf(this.entry), 1);
  }
}

const said = (id: string, text: string): ChatMessage => ({
  id,
  role: "user",
  text,
  slide: null,
  attachments: [],
  createdAt: 0,
});
const reply = (text: string, status: AssistantMessage["status"] = "streaming", id = "a"): AssistantMessage => ({
  id,
  role: "assistant",
  parts: [{ kind: "text", text }],
  status,
  thinking: false,
  error: null,
  costUsd: null,
  durationMs: null,
  createdAt: 0,
});

let layout: ReturnType<typeof layOutConversation>;

/** The conversation on show: a question and a reply coming in, each `each` tall, in a box of 400. */
function conversation(each = 500, view: (list: React.ReactNode) => React.ReactNode = (list) => list) {
  layout.size.each = each;
  useApp.setState({ messages: [said("u", "Hi"), reply("Hello")], running: true, workspace: null, deck: null });
  const shown = render(view(<MessageList />));
  return { ...shown, list: layout.viewport() };
}

/** The browser saying that the conversation, or the room for it, changed size; the scroller acts a frame later. */
const resized = async () => {
  act(() => observers.forEach((observer) => void observer.tell()));
  await nextFrame();
};
const grow = (text: string) => act(() => applyAgentEvent(useApp, { type: "textDelta", text }));
const pill = () => screen.getByRole("button", { name: /jump to/i });
/** Whether the way back to the end is offered: the button is always there, and only then to be pressed. */
const offered = () => pill().dataset.active === "true";
/** The end of what there is to scroll. */
const end = (list: HTMLElement) => list.scrollHeight - list.clientHeight;

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  layout = layOutConversation();
});
afterEach(() => {
  layout.restore();
  vi.unstubAllGlobals();
});

describe("the conversation's scroller", () => {
  it("is a region named for what it holds, whose messages are a log", () => {
    const { list } = conversation();
    expect(screen.getByRole("region", { name: "Conversation" })).toBe(list);
    const log = screen.getByRole("log");
    expect(list.contains(log)).toBe(true);
    // Read out once the reply is whole, not word by word as it comes in.
    expect(log.getAttribute("aria-busy")).toBe("true");
    act(() => useApp.setState({ running: false }));
    expect(log.hasAttribute("aria-busy")).toBe(false);
  });

  it("holds each message by its id, and tells the turns of the user from the replies", () => {
    conversation();
    const items = [...document.querySelectorAll<HTMLElement>("[data-slot=message-scroller-item]")];
    expect(items.map((item) => [item.dataset.messageId, item.dataset.scrollAnchor])).toEqual([
      ["u", "true"],
      ["a", "false"],
    ]);
  });

  it("watches the conversation and the room it has, and stops when it goes", () => {
    useApp.setState({ messages: [], running: false });
    const { unmount } = render(<MessageList />);
    const watched = observers.flatMap((observer) => observer.watched);
    expect(watched).toContain(layout.viewport());
    expect(watched).toContain(screen.getByRole("log"));
    unmount();
    expect(observers).toHaveLength(0);
  });

  it("opens at the end, with no way back offered", () => {
    const { list } = conversation();
    expect(list.scrollTop).toBe(600);
    expect(offered()).toBe(false);
    expect(pill().tabIndex).toBe(-1);
  });

  it("opens at the end under React's strict mode too, which runs every effect twice", () => {
    const { list } = conversation(500, (view) => <StrictMode>{view}</StrictMode>);
    expect(list.scrollTop).toBe(600);
    expect(offered()).toBe(false);
  });

  it("stays at the end as the conversation grows, when the browser says it did", async () => {
    const { list } = conversation();
    // A reply coming in, or a picture that loaded late: the content is taller.
    layout.size.each = 800;
    await resized();
    expect(list.scrollTop).toBe(1200);
    // The composer got taller: there is less room.
    layout.size.shown = 300;
    await resized();
    expect(list.scrollTop).toBe(1300);
    expect(offered()).toBe(false);
  });

  it("measures nothing when the conversation renders, only when its size changed", async () => {
    const { list } = conversation();
    await resized();
    await nextFrame();
    // Every measurement of the scroller's starts from where the box of the conversation is.
    const measure = list.getBoundingClientRect.bind(list);
    let measured = 0;
    list.getBoundingClientRect = () => {
      measured++;
      return measure();
    };
    grow(" there");
    grow(", how are you?");
    expect(screen.getByText("Hello there, how are you?")).toBeTruthy();
    expect(measured).toBe(0);
    layout.size.each = 520;
    await resized();
    expect(measured).toBeGreaterThan(0);
    expect(list.scrollTop).toBe(640);
  });

  it("leaves a reader who scrolled up where they are, and offers the way back", async () => {
    const { list } = conversation(1000);
    layout.scroll(500);
    expect(offered()).toBe(true);
    expect(pill().getAttribute("aria-label")).toBe("Jump to latest message");
    expect(pill().textContent).toBe(" Jump to latest");
    layout.size.each = 1300;
    await resized();
    expect(list.scrollTop).toBe(500);

    fireEvent.click(pill());
    expect(list.scrollTop).toBe(end(list));
    expect(offered()).toBe(false);
    layout.size.each = 1500;
    await resized();
    expect(list.scrollTop).toBe(end(list));
  });

  it("counts as at the end within 48 pixels of it", async () => {
    const { list } = conversation(1000);
    layout.scroll(end(list) - 47);
    expect(offered()).toBe(false);
    layout.size.each = 1050;
    await resized();
    expect(list.scrollTop).toBe(end(list));

    layout.scroll(end(list) - 49);
    expect(offered()).toBe(true);
  });

  it("brings what the reader sends into view, and nothing else the conversation gets", async () => {
    const { list } = conversation(1000);
    layout.scroll(0);
    await act(async () => applyAgentEvent(useApp, { type: "toolUse", id: "t", name: "Read", input: {} }));
    expect(list.scrollTop).toBe(0);
    expect(layout.inView("u")).toBe(true);
    // The scroller hears of a message more as the page changes, a moment after the chat has it.
    await act(async () => useApp.setState((s) => ({ messages: [...s.messages, said("u2", "And another thing")] })));
    expect(layout.inView("u2")).toBe(true);
    // The turn starts at the top of what shows, under a strip of what came before it.
    expect(list.scrollTop).toBeGreaterThan(1900);
    expect(list.scrollTop).toBeLessThan(2000);
  });

  it("says on the way back when the agent waits for an approval down there", () => {
    const { list } = conversation(1000);
    layout.scroll(0);
    act(() =>
      useApp.setState({
        messages: [
          said("u", "Hi"),
          {
            ...reply("Hello"),
            parts: [
              {
                kind: "approval",
                status: "pending",
                approval: {
                  id: "r",
                  title: "Run",
                  reason: "",
                  details: "ls",
                  acceptLabel: "Allow",
                  decisions: ["accept"],
                },
              },
            ],
          },
        ],
      }),
    );
    expect(pill().getAttribute("aria-label")).toBe("Approval needed: jump to the request");
    expect(pill().textContent).toContain("Approval needed");
    expect(pill().className).toContain("text-warning");
    expect(offered()).toBe(true);
    fireEvent.click(pill());
    expect(list.scrollTop).toBe(end(list));
  });
});

describe("the conversation out of view", () => {
  /** The conversation in what hides it, as the chat's panel does. */
  const hidden = (mode: "visible" | "hidden") => <Activity mode={mode}>{<MessageList />}</Activity>;

  it("is where the reader left it when it is shown again, the way back still offered", async () => {
    layout.size.each = 1000;
    useApp.setState({ messages: [said("u", "Hi"), reply("Hello")], running: true, workspace: null, deck: null });
    const { rerender } = render(hidden("visible"));
    const list = layout.viewport();
    layout.scroll(500);
    expect(offered()).toBe(true);

    rerender(hidden("hidden"));
    rerender(hidden("visible"));
    // The browser tells of the scrolling that coming back took.
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(500);
    expect(offered()).toBe(true);
    // And the reply going on does not pull the reader down.
    layout.size.each = 1400;
    await resized();
    expect(list.scrollTop).toBe(500);

    // Hidden and shown once more, it is still there: the place is kept each time.
    rerender(hidden("hidden"));
    rerender(hidden("visible"));
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(500);
  });

  it("is at the end when it is shown again, if that is where the reader was", async () => {
    layout.size.each = 1000;
    useApp.setState({ messages: [said("u", "Hi"), reply("Hello")], running: true, workspace: null, deck: null });
    const { rerender } = render(hidden("visible"));
    const list = layout.viewport();
    expect(list.scrollTop).toBe(end(list));

    rerender(hidden("hidden"));
    // The reply went on meanwhile.
    layout.size.each = 1600;
    rerender(hidden("visible"));
    expect(list.scrollTop).toBe(end(list));
    expect(offered()).toBe(false);
    layout.size.each = 1800;
    await resized();
    expect(list.scrollTop).toBe(end(list));
  });

  it("takes no word from a conversation that has no size", () => {
    layout.size.each = 1000;
    useApp.setState({ messages: [said("u", "Hi"), reply("Hello")], running: true, workspace: null, deck: null });
    const { rerender } = render(hidden("visible"));
    const list = layout.viewport();
    layout.scroll(500);
    // Hidden, it is 0 tall and scrolled nowhere: that is not the reader coming back to the end.
    layout.size.shown = 0;
    list.scrollTop = 0;
    fireEvent.scroll(list);
    rerender(hidden("hidden"));
    layout.size.shown = 400;
    rerender(hidden("visible"));
    fireEvent.scroll(list);
    expect(list.scrollTop).toBe(500);
    expect(offered()).toBe(true);
  });
});
