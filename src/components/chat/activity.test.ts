import { describe, expect, it } from "vitest";

import type { AssistantMessage, ChatPart } from "../../store/messages";
import { dayLabel, dayOf, formatElapsed, replyActivity, timeLabel } from "./activity";

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
    ["a tool running", reply({ parts: [text, tool] }), "Running a command…"],
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

  it("names the file a running edit is on, and says when the turn is stopping", () => {
    const edit: ChatPart = { ...tool, name: "Edit", input: { file_path: "/d/talk/deck.html" } } as ChatPart;
    expect(replyActivity(reply({ parts: [edit] }), "/d/talk/deck.html")).toBe("Editing deck.html…");
    expect(replyActivity(reply({ parts: [edit] }), "", true)).toBe("Stopping…");
  });
});

describe("dayLabel and timeLabel", () => {
  const now = new Date(2026, 10, 14, 15, 0).getTime();
  it("names today and yesterday, and dates the days before", () => {
    expect(dayLabel(new Date(2026, 10, 14, 1, 0).getTime(), now)).toBe("Today");
    expect(dayLabel(new Date(2026, 10, 13, 23, 0).getTime(), now)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 10, 2).getTime(), now)).not.toMatch(/Today|Yesterday|2026/);
    expect(dayLabel(new Date(2025, 10, 2).getTime(), now)).toMatch(/2025/);
  });

  it("gives the time alone for today, with the day otherwise", () => {
    expect(timeLabel(new Date(2026, 10, 14, 9, 5).getTime(), now)).not.toMatch(/Today|,/);
    expect(timeLabel(new Date(2026, 10, 13, 9, 5).getTime(), now)).toMatch(/^Yesterday, /);
    expect(dayOf(new Date(2026, 10, 14, 0, 1).getTime())).toBe(dayOf(new Date(2026, 10, 14, 23, 59).getTime()));
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
