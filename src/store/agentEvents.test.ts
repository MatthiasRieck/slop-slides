import { describe, expect, it } from "vitest";

import type { Provider } from "../lib/models";
import { applyReplyEvent, type ReplyEvent } from "./agentEvents";
import type { AssistantMessage, ChatMessage } from "./messages";
import { assistantMessage, userMessage } from "./testing";

const CHAT: ChatMessage[] = [userMessage("hi"), assistantMessage({ status: "streaming", thinking: true })];

/** The last reply of `chat` once `events` reached it, each in the chat as the one before left it, as the store does. */
function replay(events: ReplyEvent[], chat = CHAT, provider: Provider = "claude"): AssistantMessage {
  let messages = chat;
  for (const event of events) {
    const last = messages.findLast((m) => m.role === "assistant") as AssistantMessage;
    const next = applyReplyEvent(last, event, { messages, provider });
    messages = messages.map((m) => (m === last ? next : m));
  }
  return messages.findLast((m) => m.role === "assistant") as AssistantMessage;
}

describe("agent events on the reply", () => {
  it("streams text into the reply", () => {
    expect(replay([{ type: "textStart" }])).toMatchObject({ thinking: false, parts: [{ kind: "text", text: "" }] });
    const streamed = replay([
      { type: "textStart" },
      { type: "textDelta", text: "Hel" },
      { type: "textDelta", text: "lo" },
    ]);
    expect(streamed.parts).toEqual([{ kind: "text", text: "Hello" }]);
  });

  it("starts a text part when a delta arrives without textStart", () => {
    const reply = replay([
      { type: "toolUse", id: "t1", name: "Read", input: {} },
      { type: "textDelta", text: "after tool" },
    ]);
    expect(reply.parts.map((p) => p.kind)).toEqual(["tool", "text"]);
  });

  it("shows thinking again between blocks", () => {
    const streamed: ReplyEvent = { type: "textDelta", text: "x" };
    expect(replay([streamed]).thinking).toBe(false);
    expect(replay([streamed, { type: "thinking" }]).thinking).toBe(true);
  });

  it("tracks tool calls and drops empty text before them", () => {
    const started: ReplyEvent[] = [
      { type: "textStart" },
      { type: "textDelta", text: "  \n" },
      { type: "toolUse", id: "t1", name: "Edit", input: { file_path: "/d/deck.html" } },
      { type: "toolUse", id: "t2", name: "Read", input: {} },
    ];
    expect(replay(started).parts).toEqual([
      { kind: "tool", id: "t1", name: "Edit", input: { file_path: "/d/deck.html" }, status: "running" },
      { kind: "tool", id: "t2", name: "Read", input: {}, status: "running" },
    ]);
    const done = replay([
      ...started,
      { type: "toolResult", id: "t2", isError: true, output: "No such file", images: [] },
      { type: "toolResult", id: "t1", isError: false, output: null, images: ["/s/tool-images/1.png"] },
    ]);
    expect(done.parts.map((p) => p.kind === "tool" && p.images)).toEqual([["/s/tool-images/1.png"], undefined]);
    expect(done.parts.map((p) => p.kind === "tool" && p.status)).toEqual(["done", "error"]);
    expect(done.parts.map((p) => p.kind === "tool" && p.output)).toEqual([null, "No such file"]);
    expect(done.parts.map((p) => p.kind === "tool" && p.input)).toEqual([{ file_path: "/d/deck.html" }, {}]);
  });

  it("keeps text that has content when a tool starts", () => {
    const reply = replay([
      { type: "textDelta", text: "Editing now." },
      { type: "toolUse", id: "t1", name: "Edit", input: {} },
    ]);
    expect(reply.parts[0]).toEqual({ kind: "text", text: "Editing now." });
  });

  it("uses the result text when nothing was streamed", () => {
    expect(
      replay([{ type: "result", isError: false, text: "All done.", costUsd: 0.12, durationMs: 3400 }]),
    ).toMatchObject({ parts: [{ kind: "text", text: "All done." }], costUsd: 0.12, durationMs: 3400, error: null });
  });

  it("does not repeat the result text after streamed text", () => {
    const reply = replay([
      { type: "textDelta", text: "All done." },
      { type: "result", isError: false, text: "All done.", costUsd: null, durationMs: null },
    ]);
    expect(reply.parts).toEqual([{ kind: "text", text: "All done." }]);
  });

  it("turns an error result into an error message", () => {
    const failed: ReplyEvent = {
      type: "result",
      isError: true,
      text: "Credit balance too low",
      costUsd: null,
      durationMs: 10,
    };
    expect(replay([failed])).toMatchObject({ error: "Credit balance too low", parts: [] });
    const unexplained: ReplyEvent = { type: "result", isError: true, text: null, costUsd: null, durationMs: null };
    expect(replay([failed, unexplained]).error).toBe("The agent reported an error.");
  });

  it("records backend errors", () => {
    expect(replay([{ type: "error", message: "Claude Code stopped unexpectedly: boom" }]).error).toBe(
      "Claude Code stopped unexpectedly: boom",
    );
  });

  it("updates automatic reviews rather than adding duplicate cards", () => {
    const reply = replay([
      { type: "approvalReview", id: "review-1", status: "inProgress", detail: null },
      { type: "approvalReview", id: "review-1", status: "approved", detail: "Within scope" },
    ]);
    expect(reply.parts).toEqual([
      { kind: "approvalReview", id: "review-1", status: "approved", detail: "Within scope" },
    ]);
  });

  describe("context usage", () => {
    it("records the context size on the reply, keeping what a report leaves out", () => {
      const chat = [userMessage("hi"), assistantMessage({ status: "streaming", provider: "claude" })];
      const tokens: ReplyEvent = { type: "usage", contextTokens: 20_000, contextWindow: null };
      expect(replay([tokens], chat).context).toEqual({ provider: "claude", tokens: 20_000, window: null });
      const window: ReplyEvent = { type: "usage", contextTokens: null, contextWindow: 200_000 };
      expect(replay([tokens, window], chat).context).toEqual({ provider: "claude", tokens: 20_000, window: 200_000 });
    });

    it("carries the window over from an earlier reply of the same provider", () => {
      const chat = [
        assistantMessage({
          id: "a-0",
          provider: "claude",
          context: { provider: "claude", tokens: 5, window: 1_000_000 },
        }),
        assistantMessage({
          id: "a-1",
          provider: "copilot",
          context: { provider: "copilot", tokens: 9, window: 128_000 },
        }),
        userMessage("hi"),
        assistantMessage({ id: "a-2", status: "streaming", provider: "claude" }),
      ];
      const reply = replay([{ type: "usage", contextTokens: 60_000, contextWindow: null }], chat);
      expect(reply.context).toEqual({ provider: "claude", tokens: 60_000, window: 1_000_000 });
    });
  });
});
