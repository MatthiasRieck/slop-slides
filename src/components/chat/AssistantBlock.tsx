import { AlertTriangle, ChevronRight, FoldVertical, Redo2, RotateCw, Undo2 } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { slideNumbers } from "../../lib/slideNumbers";
import { cn } from "../../lib/utils";
import { type AssistantMessage, useApp } from "../../store";
import type { TurnChanges } from "../../store/messages";
import { Button } from "../Button";
import { ApprovalCard, ApprovalReview } from "../Permissions";
import { formatElapsed, replyActivity, timeLabel } from "./activity";
import { ChatMarkdown } from "./ChatMarkdown";
import { CopyButton } from "./CopyButton";
import { InstallHint } from "./InstallHint";
import { slideLabel } from "./mentions";
import { actionsShown, MESSAGE } from "./messageStyles";
import { explainError } from "./replyErrors";
import { ToolRow, ToolSteps } from "./ToolRow";
import { groupParts, partKey } from "./toolCalls";
import { useElapsed } from "./useElapsed";

/**
 * A reply of the agent's: its text, tool calls and approvals, and how the turn went. Steps in a
 * row fold into one line, also while the reply comes in, when its last line says what the agent
 * is doing and for how long. Finished, it says which slides its turn changed, each a way to that
 * slide. `retry` offers to send the message it answered again.
 *
 * `asked` is the user's message it answered, given to the chat's newest reply only: there the
 * turn's deck changes can be taken back, and its actions always show.
 *
 * It renders again only when its message is another: the chat keeps the messages (and the parts
 * of a reply) that an event does not touch as they are, so a reply coming in renders itself and
 * the one part that grew, and nothing of the conversation before it.
 */
export const AssistantBlock = memo(function AssistantBlock(props: {
  message: AssistantMessage;
  retry: boolean;
  asked?: string;
}) {
  const { message, retry, asked } = props;
  const streaming = message.status === "streaming";
  const latest = asked !== undefined;
  const groups = useMemo(() => groupParts(message.parts, streaming), [message.parts, streaming]);
  const turn = message.changes?.message ?? asked;
  return (
    <div className={cn(MESSAGE, "gap-2")}>
      {groups.map((group) => {
        if (group.kind === "steps") return <ToolSteps key={partKey(group.steps[0]!)} steps={group.steps} />;
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
      {message.error && <ReplyError message={message} retry={retry} />}
      {!streaming && message.changes && <TurnSummary changes={message.changes} />}
      {!streaming && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
          {message.parts.some((p) => p.kind === "text" && p.text.trim()) && (
            <CopyButton
              label="Copy message"
              className={cn("-ml-1", actionsShown(latest))}
              text={message.parts
                .filter((p) => p.kind === "text")
                .map((p) => p.text)
                .join("\n\n")}
            />
          )}
          {message.status === "interrupted" && <span>Stopped</span>}
          {retry && !message.error && <RetryButton />}
          {latest && turn && <TurnUndo turn={turn} />}
          {message.status === "done" && message.durationMs !== null && (
            <span className="text-muted-foreground/70" title={`Answered ${timeLabel(message.createdAt)}`}>
              {formatElapsed(message.durationMs)}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

/** Sends the message of the turn that failed or was stopped again. */
function RetryButton() {
  return (
    <Button
      size="xs"
      title="Send the message again, with its slide and attachments"
      onClick={() => void useApp.getState().retryLast()}
    >
      <RotateCw />
      Retry
    </Button>
  );
}

/** The last line of a reply coming in: what the agent is doing, read out as it changes, and for how long. */
function ReplyStatus({ message }: { message: AssistantMessage }) {
  const elapsed = useElapsed(message.createdAt, true);
  const deckId = useApp((s) => s.deck?.id ?? "");
  const stopping = useApp((s) => s.stopping);
  return (
    <div data-testid="reply-status" className="flex items-center gap-2 text-xs">
      <span aria-live="polite" className="shimmer-text min-w-0 truncate">
        {replyActivity(message, deckId, stopping)}
      </span>
      {/* Counting is for the eye only: read out, it would never stop. */}
      <span aria-hidden className="shrink-0 tabular-nums text-muted-foreground/70">
        {formatElapsed(elapsed)}
      </span>
    </div>
  );
}

/**
 * What went wrong in the turn: a sentence a slide-maker can act on, the action that goes with
 * it, and the agent's own words behind "Details". An error the chat does not recognize shows as
 * it came.
 */
function ReplyError({ message, retry }: { message: AssistantMessage; retry: boolean }) {
  const selected = useApp((s) => s.selection.provider);
  const running = useApp((s) => s.running);
  const [details, setDetails] = useState(false);
  const raw = message.error ?? "";
  const explained = useMemo(() => explainError(raw, message.provider ?? selected), [raw, message.provider, selected]);
  return (
    <div
      role="alert"
      className="selectable flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs leading-relaxed text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {explained ? (
          <p className="text-foreground">
            {explained.text}
            {explained.command && (
              <>
                {" "}
                <InstallHint text={`\`${explained.command}\``} />
              </>
            )}
          </p>
        ) : (
          <span className="whitespace-pre-wrap break-words">{raw}</span>
        )}
        {(retry || explained) && (
          <div className="flex flex-wrap items-center gap-1.5 text-foreground">
            {explained?.action === "compact" && (
              <Button
                size="xs"
                disabled={running}
                className="bg-background"
                onClick={() => void useApp.getState().compact()}
              >
                <FoldVertical />
                Compact the chat
              </Button>
            )}
            {explained?.action === "model" && (
              <Button size="xs" className="bg-background" onClick={() => useApp.getState().openModelPicker()}>
                Choose another model…
              </Button>
            )}
            {retry && (
              <Button
                size="xs"
                className="bg-background"
                title="Send the message again, with its slide and attachments"
                onClick={() => void useApp.getState().retryLast()}
              >
                <RotateCw />
                {explained?.action === "retry" || !explained ? "Retry" : "Try again"}
              </Button>
            )}
            {explained && (
              <button
                type="button"
                aria-expanded={details}
                onClick={() => setDetails(!details)}
                className="ml-auto flex items-center gap-1 rounded text-muted-foreground hover:text-foreground"
              >
                <ChevronRight className={cn("size-3 transition-transform", details && "rotate-90")} />
                Details
              </button>
            )}
          </div>
        )}
        {explained && details && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/60 p-2 font-mono text-2xs text-muted-foreground">
            {raw}
          </pre>
        )}
      </div>
    </div>
  );
}

/** One kind of change of a turn: the slides it names, each by its number as the deck has it now. */
function ChangedSlides({ label, ids, numbers }: { label: string; ids: string[]; numbers: string }) {
  const shown = numbers.split(",").flatMap((number, at) => (number === "0" ? [] : [{ id: ids[at]!, number }]));
  if (shown.length === 0) return null;
  return (
    <span className="flex flex-wrap items-baseline gap-x-1">
      <span>
        {label} {shown.length === 1 ? "slide" : "slides"}
      </span>
      {shown.map(({ id, number }, at) => (
        <span key={id}>
          <button
            type="button"
            title={`Go to ${slideLabel(Number(number), id)}`}
            onClick={() => useApp.getState().select(id)}
            className="rounded font-medium tabular-nums text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          >
            {number}
          </button>
          {at < shown.length - 1 && ","}
        </span>
      ))}
    </span>
  );
}

/**
 * What the turn changed in the deck: "Changed slides 3, 5 · Added slide 7 · Removed 1 slide",
 * each number a way to its slide. Of the deck, which changes with every save, it takes the
 * numbers of its slides as one text that stays the same from save to save; a slide gone since
 * is not named.
 */
const TurnSummary = memo(function TurnSummary({ changes }: { changes: TurnChanges }) {
  const numbersOf = (ids: string[]) => (s: ReturnType<typeof useApp.getState>) => {
    const numbers = s.deck ? slideNumbers(s.deck.slides) : null;
    return ids.map((id) => numbers?.get(id) ?? 0).join(",");
  };
  const changed = useApp(numbersOf(changes.changed));
  const added = useApp(numbersOf(changes.added));
  const parts = [
    changes.changed.length > 0 && /[1-9]/.test(changed) && (
      <ChangedSlides key="changed" label="Changed" ids={changes.changed} numbers={changed} />
    ),
    changes.added.length > 0 && /[1-9]/.test(added) && (
      <ChangedSlides key="added" label="Added" ids={changes.added} numbers={added} />
    ),
    changes.removed > 0 && (
      <span key="removed">
        Removed {changes.removed} {changes.removed === 1 ? "slide" : "slides"}
      </span>
    ),
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div data-testid="turn-changes" className="flex flex-wrap items-baseline gap-x-1.5 text-xs text-muted-foreground">
      {parts.map((part, at) => (
        <span key={(part as React.ReactElement).key} className="flex items-baseline gap-x-1.5">
          {at > 0 && <span aria-hidden>·</span>}
          {part}
        </span>
      ))}
    </div>
  );
});

/**
 * Takes back what the turn that started with message `turn` changed in the deck, while that is
 * the deck's newest change (see the deck's history), and makes it again once it was taken back.
 * Nothing while neither is so: the deck moved on, or the turn changed nothing.
 */
function TurnUndo({ turn }: { turn: string }) {
  const step = useApp((s) => {
    if (s.running) return null;
    if (s.history?.undo?.source === "chat" && s.history.undo.message === turn) return "undo";
    if (s.history?.redo?.source === "chat" && s.history.redo.message === turn) return "redo";
    return null;
  });
  if (!step) return null;
  return step === "undo" ? (
    <Button
      size="xs"
      title="Put the deck back as it was before this reply"
      onClick={() => void useApp.getState().undo()}
    >
      <Undo2 />
      Undo changes
    </Button>
  ) : (
    <Button size="xs" title="Make this reply's changes to the deck again" onClick={() => void useApp.getState().redo()}>
      <Redo2 />
      Redo changes
    </Button>
  );
}
