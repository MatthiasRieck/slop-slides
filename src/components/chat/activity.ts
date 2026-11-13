import type { AssistantMessage } from "../../store/messages";

/** What the agent is doing in a reply still coming in, in a word or two. */
export function replyActivity(message: AssistantMessage): string {
  if (message.compacting) return "Compacting the conversation…";
  const last = message.parts.at(-1);
  if (message.parts.some((p) => p.kind === "approval" && p.status === "pending")) return "Waiting for your approval…";
  if (message.thinking || !last) return "Thinking…";
  if (last.kind === "text") return "Writing…";
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
