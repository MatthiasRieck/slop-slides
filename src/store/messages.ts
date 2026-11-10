// The chat's messages as the chat shows them, the helpers that settle them, and saving them.
import { api } from "../lib/api";
import type { PlacedComment } from "../lib/comments";
import type { ContextUsage } from "../lib/context";
import type { EditElement } from "../lib/editTools";
import type { Provider } from "../lib/models";
import type { Approval } from "../lib/permissions";
import type { AppStore } from "./types";

export type ChatPart =
  | { kind: "approval"; approval: Approval; status: "pending" | "resolved" | "expired" }
  | { kind: "approvalReview"; id: string; status: string; detail: string | null }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: "running" | "done" | "error";
    };

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  slide: string | null;
  attachments: string[];
  /** The user drew on the slide before sending; absent in chats saved before sketches. */
  sketch?: Sketch | null;
  /** The comments on slides sent along; absent in chats saved before comments. */
  comments?: PlacedComment[];
  /** Absolute path of a screenshot of the slide sent along (for tidying hand edits). */
  screenshot?: string | null;
  /** The element on the slide the message is about. */
  element?: EditElement | null;
  /** Set when the message ran a command instead of prompting the agent. */
  command?: "compact";
  /** The deck changes of its turn were undone, and the chat kept it. */
  reverted?: boolean;
  createdAt: number;
}

/** What the agent is told about a drawing on the current slide. */
export interface Sketch {
  /** Absolute path of the slide screenshot with the drawing (in the deck's session); null if it failed. */
  image: string | null;
  /** The marked area in slide pixels. */
  bounds: { left: number; top: number; right: number; bottom: number };
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  parts: ChatPart[];
  status: "streaming" | "done" | "interrupted" | "error";
  thinking: boolean;
  error: string | null;
  costUsd: number | null;
  durationMs: number | null;
  /** The provider that wrote this reply; absent in chats saved before it was recorded. */
  provider?: Provider;
  /** How full the provider's context was after this reply, as far as it was reported. */
  context?: ContextUsage | null;
  /** The agent is summarizing the conversation. */
  compacting?: boolean;
  /** The conversation was summarized during this reply. */
  compacted?: boolean;
  createdAt: number;
}

export type ChatMessage = UserMessage | AssistantMessage;

/** What goes along with a chat message. */
export interface SendOptions {
  includeSlide: boolean;
  attachments: string[];
  screenshot?: string;
  element?: EditElement;
  /** The slide it is about, when not the one selected now (a queued message keeps its own). */
  slide?: string | null;
}

/** A message waiting for the agent's turn to end (see `ChatSlice.queue`). */
export interface QueuedMessage {
  id: string;
  text: string;
  options: SendOptions;
  /**
   * A message already made ready for the agent (its sketch shot, its comments taken), which a
   * steer could not get into the turn; it goes out as it is.
   */
  ready?: ReadyMessage;
}

/** A user's message and the prompt that tells the agent about it. */
export interface ReadyMessage {
  user: UserMessage;
  prompt: string;
}

export const newId = () => crypto.randomUUID();

/** A reply of `provider` that has just started. */
export function newReply(provider: Provider): AssistantMessage {
  return {
    id: newId(),
    role: "assistant",
    parts: [],
    status: "streaming",
    thinking: true,
    error: null,
    costUsd: null,
    durationMs: null,
    provider,
    createdAt: Date.now(),
  };
}

export function expireApprovals(parts: ChatPart[]): ChatPart[] {
  return parts.map((p) => (p.kind === "approval" && p.status === "pending" ? { ...p, status: "expired" } : p));
}

/** A reply's state once its part of the turn is over: nothing in it is still going on. */
export function settleReply(m: AssistantMessage): Partial<AssistantMessage> {
  return {
    thinking: false,
    compacting: false,
    parts: expireApprovals(m.parts).map((p) =>
      p.kind === "tool" && p.status === "running" ? { ...p, status: "done" } : p,
    ),
  };
}

/** A transcript saved mid-turn (app quit) cannot resume streaming. */
export function settleInterrupted(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    ...(message.status === "streaming" ? { status: "interrupted" as const, thinking: false, compacting: false } : {}),
    parts: expireApprovals(message.parts),
  };
}

/** Saves the chat as it is now to the workspace's session. */
export function persistChat(app: AppStore) {
  const { workspace, messages } = app.getState();
  if (workspace) void api.saveChat(workspace.path, messages);
}
