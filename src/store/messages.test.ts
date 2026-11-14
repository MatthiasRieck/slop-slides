// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ContextUsage } from "../lib/context";
import {
  type AssistantMessage,
  attachmentSent,
  type ChatMessage,
  chatContext,
  chatCost,
  firstMessageTitle,
  slideChanges,
} from "./messages";
import type { ModelSelection } from "./models";

const selection = (provider: ModelSelection["provider"]) => ({ provider }) as ModelSelection;

/** A reply whose context is `context`, counting in `reads` how often it was looked at. */
const reply = (reads: { count: number }, context?: ContextUsage): ChatMessage => {
  const message = { role: "assistant", id: "a" } as AssistantMessage;
  Object.defineProperty(message, "context", {
    get: () => {
      reads.count++;
      return context;
    },
  });
  return message;
};

describe("chatContext", () => {
  it("gives the newest usage the selected provider reported", () => {
    const reads = { count: 0 };
    const old: ContextUsage = { provider: "claude", tokens: 100, window: 1000 };
    const newest: ContextUsage = { provider: "claude", tokens: 500, window: 1000 };
    const messages = [
      reply(reads, old),
      reply(reads, { provider: "codex", tokens: 9, window: null }),
      reply(reads, newest),
    ];
    expect(chatContext({ messages, selection: selection("claude") })).toBe(newest);
    expect(chatContext({ messages, selection: selection("codex") })?.tokens).toBe(9);
    expect(chatContext({ messages, selection: selection("copilot") })).toBeNull();
  });

  it("looks through the messages once, however often the app asks, until they are others", () => {
    const reads = { count: 0 };
    // A provider that reports no usage: every message is looked at to find that out.
    const messages = Array.from({ length: 200 }, () => reply(reads));
    const state = { messages, selection: selection("codex") };
    expect(chatContext(state)).toBeNull();
    expect(reads.count).toBe(200);
    for (let update = 0; update < 50; update++) expect(chatContext({ ...state })).toBeNull();
    expect(reads.count).toBe(200);

    chatContext({ ...state, messages: [...messages] });
    expect(reads.count).toBe(400);
    chatContext({ ...state, messages, selection: selection("claude") });
    expect(reads.count).toBe(600);
  });
});

describe("slideChanges", () => {
  const slides = (...pairs: [string, string][]) => pairs.map(([id, hash]) => ({ id, hash }));

  it("names the slides changed and added, in deck order, and counts those gone", () => {
    const before = slides(["a", "1"], ["b", "1"], ["c", "1"], ["d", "1"]);
    const after = slides(["n", "1"], ["c", "2"], ["a", "1"], ["b", "9"]);
    expect(slideChanges("m", before, after)).toEqual({ message: "m", changed: ["c", "b"], added: ["n"], removed: 1 });
  });

  it("is nothing when only the order changed, or nothing did", () => {
    expect(slideChanges("m", slides(["a", "1"], ["b", "1"]), slides(["b", "1"], ["a", "1"]))).toBeNull();
    expect(slideChanges("m", [], [])).toBeNull();
  });
});

describe("what the header and the composer know of the chat", () => {
  const user = (text: string, attachments: string[] = []): ChatMessage => ({
    id: text,
    role: "user",
    text,
    slide: null,
    attachments,
    createdAt: 0,
  });

  it("calls a chat by the start of its first message, on one line", () => {
    expect(firstMessageTitle([user("  Make it\n  bigger ")])).toBe("Make it bigger");
    expect(firstMessageTitle([user("x".repeat(150))])).toHaveLength(100);
    expect(firstMessageTitle([])).toBeNull();
  });

  it("adds up the cost of the replies", () => {
    const paid = { role: "assistant", costUsd: 0.5 } as AssistantMessage;
    expect(chatCost({ messages: [user("a"), paid, paid] })).toBe(1);
    expect(chatCost({ messages: [user("a")] })).toBeNull();
  });

  it("knows a file went along with a message sent or waiting", () => {
    const state = {
      messages: [user("a", ["assets/a.png"])],
      queue: [{ id: "q", text: "later", options: { includeSlide: false, attachments: ["assets/b.png"] } }],
    };
    expect(attachmentSent(state, "assets/a.png")).toBe(true);
    expect(attachmentSent(state, "assets/b.png")).toBe(true);
    expect(attachmentSent(state, "assets/c.png")).toBe(false);
  });
});
