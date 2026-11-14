// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { ContextUsage } from "../lib/context";
import { type AssistantMessage, type ChatMessage, chatContext } from "./messages";
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
