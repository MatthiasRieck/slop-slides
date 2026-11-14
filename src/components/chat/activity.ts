import type { AssistantMessage } from "../../store/messages";
import { describeTool } from "./toolCalls";

/**
 * What the agent is doing in a reply still coming in, in a word or two. A tool call that runs is
 * named ("Editing deck.html…", with paths relative to the folder of deck `deckId`), as it is the
 * one thing worth reading while the steps before it fold away. `stopping` is on once the user
 * asked the turn to stop and it has not ended yet.
 */
export function replyActivity(message: AssistantMessage, deckId = "", stopping = false): string {
  if (stopping) return "Stopping…";
  if (message.compacting) return "Compacting the conversation…";
  const last = message.parts.at(-1);
  if (message.parts.some((p) => p.kind === "approval" && p.status === "pending")) return "Waiting for your approval…";
  if (message.thinking || !last) return "Thinking…";
  if (last.kind === "text") return "Writing…";
  if (last.kind === "tool" && last.status === "running") return describeTool(last, deckId).doing;
  return "Working…";
}

/** How long something has taken so far: `8s`, `1m 05s`, `1h 02m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
}

/** The day a message was written, as a number that is the same for every moment of that day. */
export function dayOf(ms: number): number {
  const date = new Date(ms);
  return date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate();
}

/** What the conversation calls the day of `ms`, seen from `now`: "Today", "Yesterday", else its date. */
export function dayLabel(ms: number, now = Date.now()): string {
  const day = (at: number) => {
    const date = new Date(at);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(ms)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** When a message was written, for its tooltip: the time, after the date when that is not today. */
export function timeLabel(ms: number, now = Date.now()): string {
  const time = new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return dayOf(ms) === dayOf(now) ? time : `${dayLabel(ms, now)}, ${time}`;
}
