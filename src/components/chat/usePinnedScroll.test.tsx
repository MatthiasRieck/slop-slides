import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AssistantMessage, type ChatMessage, useApp } from "../../store";
import { applyAgentEvent } from "../../store/chat";
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
const reply = (text: string, status: AssistantMessage["status"] = "streaming"): AssistantMessage => ({
  id: "a",
  role: "assistant",
  parts: [{ kind: "text", text }],
  status,
  thinking: false,
  error: null,
  costUsd: null,
  durationMs: null,
  createdAt: 0,
});

/** The conversation on show, `height` tall in a box of 400, with how often its height was asked for. */
function conversation(height: number) {
  useApp.setState({ messages: [said("u", "Hi"), reply("Hello")], running: true, workspace: null, deck: null });
  const { container } = render(<MessageList />);
  const list = container.firstElementChild as HTMLElement;
  const size = { height, shown: 400, measured: 0 };
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    get: () => {
      size.measured++;
      return size.height;
    },
  });
  Object.defineProperty(list, "clientHeight", { configurable: true, get: () => size.shown });
  return { list, size };
}

/** The browser saying that the conversation, or the room for it, changed size. */
const resized = () => act(() => observers.forEach((observer) => void observer.tell()));
const grow = (text: string) => act(() => applyAgentEvent(useApp, { type: "textDelta", text }));
const pill = () => screen.queryByRole("button", { name: "Jump to latest message" });

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});
afterEach(() => vi.unstubAllGlobals());

describe("usePinnedScroll", () => {
  it("watches the conversation and the room it has, and stops when it goes", () => {
    useApp.setState({ messages: [], running: false });
    const { container, unmount } = render(<MessageList />);
    const list = container.firstElementChild!;
    expect(observers).toHaveLength(1);
    expect(observers[0]!.watched).toEqual([list.firstElementChild, list]);
    unmount();
    expect(observers).toHaveLength(0);
  });

  it("stays at the end as the conversation grows, when the browser says it did", () => {
    const { list, size } = conversation(1000);
    resized();
    expect(list.scrollTop).toBe(1000);
    // A reply coming in, or a picture that loaded late: the content is taller.
    size.height = 1600;
    resized();
    expect(list.scrollTop).toBe(1600);
    // The composer got taller: there is less room.
    size.shown = 300;
    resized();
    expect(list.scrollTop).toBe(1600);
    expect(pill()).toBeNull();
  });

  it("measures nothing when the conversation renders, only when its size changed", () => {
    const { list, size } = conversation(1000);
    resized();
    size.measured = 0;
    grow(" there");
    grow(", how are you?");
    expect(screen.getByText("Hello there, how are you?")).toBeTruthy();
    expect(size.measured).toBe(0);
    size.height = 1040;
    resized();
    expect(size.measured).toBe(1);
    expect(list.scrollTop).toBe(1040);
  });

  it("leaves a reader who scrolled up where they are, and offers the way back", () => {
    const { list, size } = conversation(2000);
    list.scrollTop = 500;
    fireEvent.scroll(list);
    expect(pill()).not.toBeNull();
    size.height = 2600;
    resized();
    expect(list.scrollTop).toBe(500);

    fireEvent.click(pill()!);
    expect(list.scrollTop).toBe(2600);
    expect(pill()).toBeNull();
    size.height = 3000;
    resized();
    expect(list.scrollTop).toBe(3000);
  });

  it("counts as at the end within 48 pixels of it", () => {
    const { list, size } = conversation(2000);
    list.scrollTop = 2000 - 400 - 47;
    fireEvent.scroll(list);
    expect(pill()).toBeNull();
    size.height = 2100;
    resized();
    expect(list.scrollTop).toBe(2100);

    list.scrollTop = 2100 - 400 - 48;
    fireEvent.scroll(list);
    expect(pill()).not.toBeNull();
  });

  it("goes to the end when the reader sends, and not for anything else the conversation gets", () => {
    const { list } = conversation(2000);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    act(() => applyAgentEvent(useApp, { type: "toolUse", id: "t", name: "Read", input: {} }));
    expect(list.scrollTop).toBe(0);
    act(() => useApp.setState((s) => ({ messages: [...s.messages, said("u2", "And another thing")] })));
    expect(list.scrollTop).toBe(2000);
    expect(pill()).toBeNull();
  });

  it("takes no word from a conversation out of view, which has no size", () => {
    const { list, size } = conversation(2000);
    list.scrollTop = 500;
    fireEvent.scroll(list);
    // Hidden, it is 0 tall and scrolled nowhere: that is not the reader coming back to the end.
    size.shown = 0;
    size.height = 0;
    list.scrollTop = 0;
    fireEvent.scroll(list);
    size.shown = 400;
    size.height = 2000;
    list.scrollTop = 500;
    resized();
    expect(list.scrollTop).toBe(500);
    expect(pill()).not.toBeNull();
  });
});
