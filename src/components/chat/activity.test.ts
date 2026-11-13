// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { AssistantMessage, ChatPart } from "../../store/messages";
import { formatElapsed, replyActivity } from "./activity";

const reply = (patch: Partial<AssistantMessage>): AssistantMessage => ({
  id: "a",
  role: "assistant",
  parts: [],
  status: "streaming",
  thinking: false,
  error: null,
  costUsd: null,
  durationMs: null,
  createdAt: 0,
  ...patch,
});
const text: ChatPart = { kind: "text", text: "Hello" };
const tool: ChatPart = { kind: "tool", id: "t", name: "Bash", input: {}, status: "running" };
const approval = (status: "pending" | "resolved"): ChatPart => ({
  kind: "approval",
  status,
  approval: { id: "ap", title: "Run", reason: null, details: "ls", acceptLabel: "Allow", decisions: ["accept"] },
});

describe("replyActivity", () => {
  it.each([
    ["nothing yet", reply({}), "Thinking…"],
    ["thinking after some text", reply({ thinking: true, parts: [text] }), "Thinking…"],
    ["text coming in", reply({ parts: [tool, text] }), "Writing…"],
    ["a tool running", reply({ parts: [text, tool] }), "Working…"],
    [
      "a tool that finished, before what comes next",
      reply({ parts: [{ ...tool, status: "done" } as ChatPart] }),
      "Working…",
    ],
    ["an approval waiting", reply({ parts: [tool, approval("pending")] }), "Waiting for your approval…"],
    ["an approval answered", reply({ parts: [approval("resolved")] }), "Working…"],
    ["compacting", reply({ compacting: true, thinking: true }), "Compacting the conversation…"],
  ])("says what the agent is doing with %s", (_, message, label) => {
    expect(replyActivity(message)).toBe(label);
  });
});

describe("formatElapsed", () => {
  it.each([
    [-5, "0s"],
    [0, "0s"],
    [999, "0s"],
    [8_400, "8s"],
    [59_999, "59s"],
    [60_000, "1m 00s"],
    [65_000, "1m 05s"],
    [3_599_000, "59m 59s"],
    [3_720_000, "1h 02m"],
  ])("writes %i ms as %s", (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});
