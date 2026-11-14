import { AlertTriangle, FoldVertical, RotateCw } from "lucide-react";
import { memo, useMemo } from "react";

import { cn } from "../../lib/utils";
import { type AssistantMessage, useApp } from "../../store";
import { ApprovalCard, ApprovalReview } from "../Permissions";
import { formatElapsed, replyActivity } from "./activity";
import { ChatMarkdown } from "./ChatMarkdown";
import { CopyButton } from "./CopyButton";
import { MESSAGE, ON_HOVER } from "./messageStyles";
import { ToolRow, ToolSteps } from "./ToolRow";
import { groupParts } from "./toolCalls";
import { useElapsed } from "./useElapsed";

/**
 * A reply of the agent's: its text, tool calls and approvals, and how the turn went. While it
 * comes in, its last line says what the agent is doing and for how long. Finished, tool calls in
 * a row fold into one line of steps; `retry` offers to send the message it answered again.
 *
 * It renders again only when its message is another: the chat keeps the messages (and the parts
 * of a reply) that an event does not touch as they are, so a reply coming in renders itself and
 * the one part that grew, and nothing of the conversation before it.
 */
export const AssistantBlock = memo(function AssistantBlock(props: { message: AssistantMessage; retry: boolean }) {
  const { message, retry } = props;
  const streaming = message.status === "streaming";
  // While the agent works, each step shows as it happens.
  const groups = useMemo(() => groupParts(message.parts, !streaming), [message.parts, streaming]);
  return (
    <div className={cn(MESSAGE, "gap-2")}>
      {groups.map((group) => {
        if (group.kind === "steps") return <ToolSteps key={group.tools[0]!.id} tools={group.tools} />;
        const { part, key } = group;
        return part.kind === "text" ? (
          <div key={key} className="markdown selectable">
            <ChatMarkdown>{part.text}</ChatMarkdown>
          </div>
        ) : part.kind === "approval" ? (
          <ApprovalCard key={key} part={part} />
        ) : part.kind === "approvalReview" ? (
          <ApprovalReview key={key} part={part} />
        ) : (
          <ToolRow key={key} part={part} />
        );
      })}
      {message.compacted && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FoldVertical className="size-3.5 shrink-0" />
          Conversation compacted
        </span>
      )}
      {streaming && <ReplyStatus message={message} />}
      {message.error && (
        <div className="selectable flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{message.error}</span>
        </div>
      )}
      {!streaming && message.parts.some((p) => p.kind === "text" && p.text.trim()) && (
        <div>
          <CopyButton
            label="Copy message"
            className={ON_HOVER}
            text={message.parts
              .filter((p) => p.kind === "text")
              .map((p) => p.text)
              .join("\n\n")}
          />
        </div>
      )}
      {(message.status === "interrupted" || retry) && (
        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          {message.status === "interrupted" && <span>Stopped</span>}
          {retry && (
            <button
              type="button"
              title="Send the message again, with its slide and attachments"
              onClick={() => void useApp.getState().retryLast()}
              className="flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
            >
              <RotateCw className="size-3" />
              Retry
            </button>
          )}
        </div>
      )}
      {message.status === "done" && message.durationMs !== null && (
        <span className="text-2xs text-muted-foreground/70">
          {(message.durationMs / 1000).toFixed(1)}s{message.costUsd ? ` · $${message.costUsd.toFixed(3)}` : ""}
        </span>
      )}
    </div>
  );
});

/** The last line of a reply coming in: what the agent is doing, read out as it changes, and for how long. */
function ReplyStatus({ message }: { message: AssistantMessage }) {
  const elapsed = useElapsed(message.createdAt, true);
  return (
    <div data-testid="reply-status" className="flex items-center gap-2 text-xs">
      <span aria-live="polite" className="shimmer-text">
        {replyActivity(message)}
      </span>
      {/* Counting is for the eye only: read out, it would never stop. */}
      <span aria-hidden className="tabular-nums text-muted-foreground/70">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}
