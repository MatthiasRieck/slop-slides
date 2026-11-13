import { Loader2 } from "lucide-react";

import { cn } from "../lib/utils";
import type { ChatAttention } from "../store/attention";

/** What each mark says, as its tooltip and to screen readers. */
export const ATTENTION_LABELS: Record<ChatAttention, string> = {
  approval: "The agent is waiting for your approval",
  working: "The agent is working",
};

/**
 * The mark for a chat that is out of sight: a spinner while the agent works, a warning dot
 * while it waits for an approval. `className` places it.
 */
export function AttentionMark({ attention, className }: { attention: ChatAttention; className?: string }) {
  const label = ATTENTION_LABELS[attention];
  return (
    <span role="img" aria-label={label} title={label} data-attention={attention} className={cn("flex", className)}>
      {attention === "working" ? (
        <Loader2 aria-hidden className="size-3 animate-spin text-primary" />
      ) : (
        <span aria-hidden className="size-2 rounded-full bg-warning" />
      )}
    </span>
  );
}
