// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { chatAttention, chatVisible } from "./attention";
import type { AssistantMessage, ChatMessage, ChatPart } from "./messages";

const approval = (status: "pending" | "resolved" | "expired"): ChatPart => ({
  kind: "approval",
  status,
  approval: {
    id: "p1",
    title: "Run a command",
    reason: null,
    details: "ls",
    acceptLabel: "Allow once",
    decisions: ["accept"],
  },
});
const assistant = (parts: ChatPart[]): AssistantMessage => ({
  id: "a1",
  role: "assistant",
  parts,
  status: "streaming",
  thinking: false,
  error: null,
  costUsd: null,
  durationMs: null,
  createdAt: 1,
});
const user: ChatMessage = { id: "u1", role: "user", text: "Go", slide: null, attachments: [], createdAt: 0 };

describe("chatAttention", () => {
  it("is nothing while the chat is at rest", () => {
    expect(chatAttention({ messages: [], running: false })).toBeNull();
    expect(
      chatAttention({ messages: [user, assistant([{ kind: "text", text: "Done." }])], running: false }),
    ).toBeNull();
  });

  it("is the work while a turn runs", () => {
    expect(chatAttention({ messages: [user, assistant([])], running: true })).toBe("working");
    expect(chatAttention({ messages: [], running: true })).toBe("working");
  });

  it("is the approval the agent waits for, which comes before the work", () => {
    const messages = [user, assistant([{ kind: "text", text: "Let me look." }, approval("pending")])];
    expect(chatAttention({ messages, running: true })).toBe("approval");
  });

  it("is not an approval that was given or that expired, nor one of an earlier reply", () => {
    expect(chatAttention({ messages: [user, assistant([approval("resolved")])], running: true })).toBe("working");
    expect(chatAttention({ messages: [user, assistant([approval("expired")])], running: false })).toBeNull();
    const earlier = [user, assistant([approval("pending")]), user, assistant([])];
    expect(chatAttention({ messages: earlier, running: true })).toBe("working");
  });
});

describe("chatAttention, asked on every update of the store", () => {
  it("looks through the messages only when they changed", () => {
    const messages = [user, assistant([approval("pending")])];
    const findLast = vi.spyOn(messages, "findLast");
    expect(chatAttention({ messages, running: true })).toBe("approval");
    for (let update = 0; update < 50; update++) chatAttention({ messages, running: update % 2 === 0 });
    expect(findLast).toHaveBeenCalledOnce();
    // Whether a turn runs is read each time all the same.
    const resting = [user, assistant([])];
    expect(chatAttention({ messages: resting, running: true })).toBe("working");
    expect(chatAttention({ messages: resting, running: false })).toBeNull();
  });
});

describe("chatVisible", () => {
  it("is the open sidebar on the chat's tab", () => {
    expect(chatVisible({ sidebarOpen: true, sidebarTab: "chat" })).toBe(true);
    expect(chatVisible({ sidebarOpen: true, sidebarTab: "files" })).toBe(false);
    expect(chatVisible({ sidebarOpen: false, sidebarTab: "chat" })).toBe(false);
  });
});
