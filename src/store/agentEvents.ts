// How the agent's streamed events change the reply they belong to. The events that do more than
// that (opening a file, a steer, the end of the turn) are handled by the chat (see chat.ts).
import type { AgentEvent } from "../lib/api";
import { latestContext, mergeContext } from "../lib/context";
import type { Provider } from "../lib/models";
import type { AssistantMessage, ChatMessage, ChatPart } from "./messages";

/** The events that only change the reply streaming now. */
export type ReplyEvent = Exclude<AgentEvent, { type: "openFile" | "started" | "steered" | "finished" }>;

/** What the reply's context is worked out from: the chat it is in, and the provider of replies that recorded none. */
export interface ReplyContext {
  messages: ChatMessage[];
  provider: Provider;
}

/** The provider that wrote `message`; replies saved before it was recorded are the selected provider's. */
export function replyProvider(message: AssistantMessage, fallback: Provider): Provider {
  return message.provider ?? fallback;
}

/** `m` with `event` applied. */
export function applyReplyEvent(m: AssistantMessage, event: ReplyEvent, chat: ReplyContext): AssistantMessage {
  switch (event.type) {
    case "approvalRequested":
      return {
        ...m,
        thinking: false,
        parts: [...m.parts, { kind: "approval", approval: event.approval, status: "pending" }],
      };
    case "approvalResolved":
      return {
        ...m,
        parts: m.parts.map((p) =>
          p.kind === "approval" && p.approval.id === event.id ? { ...p, status: "resolved" } : p,
        ),
      };
    case "approvalReview": {
      const part: ChatPart = { kind: "approvalReview", id: event.id, status: event.status, detail: event.detail };
      const existing = m.parts.some((p) => p.kind === "approvalReview" && p.id === event.id);
      return {
        ...m,
        thinking: false,
        parts: existing
          ? m.parts.map((p) => (p.kind === "approvalReview" && p.id === event.id ? part : p))
          : [...m.parts, part],
      };
    }
    case "thinking":
      return { ...m, thinking: true };
    case "textStart":
      return { ...m, thinking: false, parts: [...m.parts, { kind: "text", text: "" }] };
    case "textDelta": {
      const parts = [...m.parts];
      const last = parts.at(-1);
      if (last?.kind === "text") parts[parts.length - 1] = { ...last, text: last.text + event.text };
      else parts.push({ kind: "text", text: event.text });
      return { ...m, thinking: false, parts };
    }
    case "toolUse":
      return {
        ...m,
        thinking: false,
        parts: [
          ...m.parts.filter((p) => p.kind !== "text" || p.text.trim() !== ""),
          { kind: "tool", id: event.id, name: event.name, input: event.input, status: "running" },
        ],
      };
    case "toolResult":
      return {
        ...m,
        parts: m.parts.map((p) =>
          p.kind === "tool" && p.id === event.id
            ? {
                ...p,
                status: event.isError ? "error" : "done",
                output: event.output,
                ...(event.images?.length ? { images: event.images } : {}),
              }
            : p,
        ),
      };
    case "result": {
      const hasText = m.parts.some((p) => p.kind === "text" && p.text.trim() !== "");
      const parts: ChatPart[] =
        !hasText && !event.isError && event.text ? [...m.parts, { kind: "text", text: event.text }] : m.parts;
      return {
        ...m,
        parts,
        costUsd: event.costUsd,
        durationMs: event.durationMs,
        error: event.isError ? (event.text ?? "The agent reported an error.") : m.error,
      };
    }
    case "error":
      return { ...m, error: event.message };
    case "usage": {
      const provider = replyProvider(m, chat.provider);
      return { ...m, context: mergeContext(latestContext(chat.messages, provider), provider, event) };
    }
    case "compacting":
      return { ...m, thinking: false, compacting: true };
    case "compacted": {
      const provider = replyProvider(m, chat.provider);
      const window = latestContext(chat.messages, provider)?.window ?? null;
      // The new size is only known once the agent reports usage again.
      return { ...m, compacting: false, compacted: true, context: { provider, tokens: null, window } };
    }
  }
}
