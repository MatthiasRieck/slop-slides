// The chat's messages as the chat shows them, the helpers that settle them, and saving them.
import { api } from "../lib/api";
import type { PlacedComment } from "../lib/comments";
import { type ContextUsage, latestContext, totalCost } from "../lib/context";
import type { EditElement } from "../lib/editTools";
import { memoizeLast } from "../lib/memo";
import type { Provider } from "../lib/models";
import type { Approval, ApprovalDecision } from "../lib/permissions";
import type { AppState, AppStore } from "./types";

export type ChatPart =
  | {
      kind: "approval";
      approval: Approval;
      status: "pending" | "resolved" | "expired";
      /** How the user answered it; absent while they have not, and in chats saved before it was kept. */
      decision?: ApprovalDecision;
    }
  | { kind: "approvalReview"; id: string; status: string; detail: string | null }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: "running" | "done" | "error";
      /** What the tool gave back, as text; absent while it runs, when it gave nothing, and in chats saved before it was kept. */
      output?: string | null;
      /** Absolute paths, in the chat's session, of the images the tool gave back; absent when it gave none. */
      images?: string[];
    };

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  slide: string | null;
  /** The other slides the message refers to, by id; absent when there are none. */
  slides?: string[];
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
  /** What the turn this reply ended changed in the deck; absent when it changed no slide, and on the replies before a steer. */
  changes?: TurnChanges;
  createdAt: number;
}

/** What an agent's turn changed in the deck's slides, by their ids. */
export interface TurnChanges {
  /** The user's message that started the turn, which the deck's history knows its changes by. */
  message: string;
  /** Slides that were there before and are different now, in deck order. */
  changed: string[];
  /** Slides that are new, in deck order. */
  added: string[];
  /** How many slides are gone. */
  removed: number;
}

/**
 * What differs between the slides a turn started with (`before`) and those it left (`after`);
 * null when they are the same slides. A slide only moved counts as neither changed nor new.
 */
export function slideChanges(
  message: string,
  before: readonly { id: string; hash: string }[],
  after: readonly { id: string; hash: string }[],
): TurnChanges | null {
  const was = new Map(before.map((slide) => [slide.id, slide.hash]));
  const is = new Set(after.map((slide) => slide.id));
  const changed = after.filter((slide) => was.has(slide.id) && was.get(slide.id) !== slide.hash).map((s) => s.id);
  const added = after.filter((slide) => !was.has(slide.id)).map((s) => s.id);
  const removed = before.filter((slide) => !is.has(slide.id)).length;
  return changed.length + added.length + removed > 0 ? { message, changed, added, removed } : null;
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
  /** The other slides it refers to, by id: those picked beside the one it is about, and those added with "@". */
  slides?: string[];
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

/**
 * The user's message a retry sends again: the one the chat's last reply answered, when that reply
 * failed or was stopped. Null when there is nothing to retry.
 */
export function retryTarget(messages: readonly ChatMessage[]): UserMessage | null {
  const reply = messages.at(-1);
  const asked = messages.at(-2);
  if (reply?.role !== "assistant" || asked?.role !== "user") return null;
  return reply.status === "error" || reply.status === "interrupted" ? asked : null;
}

/** What went along with `message`, to send it again as it was. */
export function sendOptionsOf(message: UserMessage): SendOptions {
  return {
    includeSlide: message.slide !== null,
    slide: message.slide,
    ...(message.slides?.length && { slides: message.slides }),
    attachments: message.attachments,
    ...(message.screenshot && { screenshot: message.screenshot }),
    ...(message.element && { element: message.element }),
  };
}

/** The text of the user's newest message that was not a command; null when there is none. */
export function lastSentText(messages: readonly ChatMessage[]): string | null {
  const last = messages.findLast((m) => m.role === "user" && !m.command);
  return last?.role === "user" ? last.text : null;
}

const contextIn = memoizeLast(latestContext);

/**
 * How full the selected provider's context is, as its newest reply in the chat says; null until
 * it reports. A selector: asked on every update of the store, it looks through the messages
 * only when they or the provider changed, as a provider that reports nothing has it look at
 * every one of them.
 */
export function chatContext(state: Pick<AppState, "messages" | "selection">): ContextUsage | null {
  return contextIn(state.messages, state.selection.provider);
}

const costIn = memoizeLast(totalCost);

/**
 * What the chat's replies cost together, in US dollars, as their agents reported it; null when
 * none did. A selector, added up again only when the messages changed.
 */
export function chatCost(state: Pick<AppState, "messages">): number | null {
  return costIn(state.messages);
}

/**
 * What the chat on show is called while the user gave it no name: the start of its first
 * message, as the list of past chats names it; null for a chat with no message yet.
 */
export function firstMessageTitle(messages: readonly ChatMessage[]): string | null {
  const first = messages.find((m) => m.role === "user");
  return first?.role === "user" ? first.text.replace(/\s+/g, " ").trim().slice(0, 100) || null : null;
}

/** Whether `path` went along with a message of the chat, or goes along with one that waits. */
export function attachmentSent(state: Pick<AppState, "messages" | "queue">, path: string): boolean {
  return (
    state.messages.some((m) => m.role === "user" && m.attachments.includes(path)) ||
    state.queue.some((item) => item.options.attachments.includes(path))
  );
}

/** Saves the chat as it is now to its session. */
export function persistChat(app: AppStore) {
  const { chatKey, messages } = app.getState();
  if (chatKey) void api.saveChat(chatKey, messages);
}
