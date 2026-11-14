// What the agent needs from the user while the chat is out of sight, for the marks on the
// sidebar's toggle and on the Chat tab.
import { memoizeLast } from "../lib/memo";
import type { AppState } from "./types";

/** Why the chat wants a look: the agent waits for an approval, or its turn is running. */
export type ChatAttention = "approval" | "working";

/** What the chat on show is up to that the user may want to know of; null when it is at rest. */
export function chatAttention(state: Pick<AppState, "messages" | "running">): ChatAttention | null {
  if (awaitsApproval(state.messages)) return "approval";
  return state.running ? "working" : null;
}

/**
 * Whether the agent's last reply waits for an approval. The marks ask on every update of the
 * store; the messages are looked through only when they changed.
 */
const awaitsApproval = memoizeLast((messages: AppState["messages"]): boolean => {
  const last = messages.findLast((message) => message.role === "assistant");
  return last?.role === "assistant" && last.parts.some((p) => p.kind === "approval" && p.status === "pending");
});

/** Whether the chat is on show: the sidebar is open on its tab. */
export function chatVisible(state: Pick<AppState, "sidebarOpen" | "sidebarTab">): boolean {
  return state.sidebarOpen && state.sidebarTab === "chat";
}

/** What the chat wants a look for while it is out of sight; null when it is on show or at rest. */
export function hiddenChatAttention(state: AppState): ChatAttention | null {
  return chatVisible(state) ? null : chatAttention(state);
}
