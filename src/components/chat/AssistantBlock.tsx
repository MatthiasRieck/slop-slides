import { AlertTriangle, FoldVertical, RotateCw } from "lucide-react";
import { memo, useMemo } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Trace, TraceDescription, TraceLine, TraceTitle } from "@/components/ui/trace";
import { type AssistantMessage, useApp } from "../../store";
import { ApprovalCard, ApprovalReview } from "../Permissions";
import { formatElapsed, replyActivity } from "./activity";
import { ChatMarkdown } from "./ChatMarkdown";
import { CopyButton } from "./CopyButton";
import { ON_HOVER } from "./messageStyles";
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
    <Message>
      <MessageContent className="gap-2">
        {groups.map((group) => {
          if (group.kind === "steps") return <ToolSteps key={group.tools[0]!.id} tools={group.tools} />;
          const { part, key } = group;
          return part.kind === "text" ? (
            <Bubble key={key} variant="ghost" className="w-full">
              <BubbleContent className="markdown selectable w-full overflow-visible">
                <ChatMarkdown>{part.text}</ChatMarkdown>
              </BubbleContent>
            </Bubble>
          ) : part.kind === "approval" ? (
            <ApprovalCard key={key} part={part} />
          ) : part.kind === "approvalReview" ? (
            <ApprovalReview key={key} part={part} />
          ) : (
            <Trace key={key}>
              <ToolRow part={part} />
            </Trace>
          );
        })}
        {message.compacted && (
          <Marker className="text-xs">
            <MarkerIcon>
              <FoldVertical className="size-3.5" />
            </MarkerIcon>
            <MarkerContent>Conversation compacted</MarkerContent>
          </Marker>
        )}
        {streaming && <ReplyStatus message={message} />}
        {message.error && (
          <Alert variant="destructive" className="selectable border-destructive/30 bg-destructive/10 text-xs">
            <AlertTriangle className="size-3.5" />
            <AlertDescription className="whitespace-pre-wrap break-words text-xs text-destructive">
              {message.error}
            </AlertDescription>
          </Alert>
        )}
        {!streaming && message.parts.some((p) => p.kind === "text" && p.text.trim()) && (
          <MessageFooter className="px-0">
            <CopyButton
              plain
              label="Copy message"
              className={ON_HOVER}
              text={message.parts
                .filter((p) => p.kind === "text")
                .map((p) => p.text)
                .join("\n\n")}
            />
          </MessageFooter>
        )}
        {(message.status === "interrupted" || retry) && (
          <MessageFooter className="gap-2 px-0 text-2xs font-normal">
            {message.status === "interrupted" && <span>Stopped</span>}
            {retry && (
              <Button
                variant="outline"
                size="xs"
                tooltip="Send the message again, with its slide and attachments"
                onClick={() => void useApp.getState().retryLast()}
              >
                <RotateCw data-icon="inline-start" />
                Retry
              </Button>
            )}
          </MessageFooter>
        )}
        {message.status === "done" && message.durationMs !== null && (
          <MessageFooter className="px-0 text-2xs font-normal text-muted-foreground/70">
            {(message.durationMs / 1000).toFixed(1)}s{message.costUsd ? ` · $${message.costUsd.toFixed(3)}` : ""}
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
});

/**
 * The last line of a reply coming in, as the line of its trace that is running: what the agent
 * is doing, read out as it changes, and for how long.
 */
function ReplyStatus({ message }: { message: AssistantMessage }) {
  const elapsed = useElapsed(message.createdAt, true);
  return (
    <Trace>
      <TraceLine status="running" data-testid="reply-status" className="text-xs text-foreground">
        <TraceTitle aria-live="polite">{replyActivity(message)}</TraceTitle>
        {/* Counting is for the eye only: read out, it would never stop. */}
        <TraceDescription aria-hidden>{formatElapsed(elapsed)}</TraceDescription>
      </TraceLine>
    </Trace>
  );
}
