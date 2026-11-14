import { ArrowDown, ShieldAlert } from "lucide-react";
import { Fragment, memo, useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { type ChatMessage, useApp } from "../../store";
import { retryTarget } from "../../store/messages";
import { AssistantBlock } from "./AssistantBlock";
import { dayLabel, dayOf } from "./activity";
import { UserBubble } from "./UserBubble";
import { usePinnedScroll } from "./usePinnedScroll";

/** Whether the reply coming in waits for the user to allow or deny something. */
const awaitsApproval = (message: ChatMessage | undefined) =>
  message?.role === "assistant" &&
  message.status === "streaming" &&
  message.parts.some((p) => p.kind === "approval" && p.status === "pending");

/** What is read out when the agent's turn ends, by how its last reply ended. */
export function finishedAnnouncement(message: ChatMessage | undefined): string {
  if (message?.role !== "assistant") return "";
  if (message.status === "error") return "The agent stopped with an error.";
  if (message.status === "interrupted") return "The agent stopped.";
  return "The agent finished.";
}

/**
 * The conversation, kept scrolled to the latest message unless the user scrolled up (then a
 * button jumps back down, which also says when the agent waits for an approval down there). A
 * message the user sends always shows. `children` come before the messages. A chat that spans
 * days marks where each day starts; the end of a turn is read out.
 *
 * It takes the messages from the chat itself and renders with each of the agent's events, which
 * is little: a message the event left as it was, in the same place, is handed on as the very
 * element it was the last time (see `MessageElements`), which React passes over without a look;
 * each message renders again only when it is another (see `AssistantBlock`), or when it stops or
 * starts being the newest, and staying at the end is the browser's to tell (see `usePinnedScroll`).
 */
export const MessageList = memo(function MessageList(props: { children?: React.ReactNode }) {
  const messages = useApp((s) => s.messages);
  const running = useApp((s) => s.running);
  const lastSent = messages.findLast((m) => m.role === "user")?.id;
  const { scroller, content, away, toEnd, onScroll } = usePinnedScroll(lastSent);
  const [elements] = useState(() => new MessageElements());

  const last = messages.at(-1);
  const approval = running && awaitsApproval(last);
  const retry = !running && retryTarget(messages) !== null;
  // The newest reply answers the newest message: its turn is the one that can be undone.
  const asked = last?.role === "assistant" ? messages.at(-2) : undefined;
  const spansDays = messages.length > 1 && dayOf(messages[0]!.createdAt) !== dayOf(last!.createdAt);

  // Read out as a turn ends, and only then: not for a chat that is opened finished.
  const [announcement, setAnnouncement] = useState("");
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setAnnouncement(finishedAnnouncement(useApp.getState().messages.at(-1)));
    if (running) setAnnouncement("");
    wasRunning.current = running;
  }, [running]);

  return (
    <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-4 pt-4">
      <div
        ref={content}
        role="log"
        aria-label="Conversation"
        // A reply coming in word by word is not read out as it grows: its end is (see `announcement`).
        aria-live="off"
        className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6"
      >
        {props.children}
        {messages.map((message, index) => {
          const before = messages[index - 1];
          const newDay = spansDays && (!before || dayOf(before.createdAt) !== dayOf(message.createdAt));
          const placed: Placed =
            message.role === "user"
              ? { newDay, latest: message.id === lastSent }
              : {
                  newDay,
                  retry: retry && message === last,
                  asked: message === last && asked?.role === "user" ? asked.id : undefined,
                };
          return elements.place(message, placed);
        })}
      </div>
      <p role="status" className="sr-only">
        {announcement}
      </p>
      {away && (
        <div className="sticky bottom-3 flex justify-center">
          <button
            type="button"
            aria-label={approval ? "Approval needed: jump to the request" : "Jump to latest message"}
            onClick={toEnd}
            className={cn(
              "flex items-center gap-1 rounded-full border bg-card px-3 py-1.5 text-xs shadow-sm",
              approval && "border-warning/60 font-medium text-warning",
            )}
          >
            {approval ? (
              <>
                <ShieldAlert className="size-3" /> Approval needed <ArrowDown className="size-3" />
              </>
            ) : (
              <>
                <ArrowDown className="size-3" /> Jump to latest
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
});

/** What a message shows besides itself: the day it starts, and whether it is the newest of its kind. */
type Placed = { newDay: boolean; latest: boolean } | { newDay: boolean; retry: boolean; asked: string | undefined };

/** Whether a message is placed the same way twice. */
const samePlace = (a: Placed, b: Placed) =>
  a.newDay === b.newDay &&
  ("latest" in a && "latest" in b
    ? a.latest === b.latest
    : "retry" in a && "retry" in b && a.retry === b.retry && a.asked === b.asked);

/**
 * The element each message of the conversation was rendered as last, kept for as long as the
 * message is the same object. While a reply comes in, every other message stays as it was, and
 * handing React the same element again tells it there is nothing to do there: a word of the
 * reply then costs no more in a long chat than in a short one.
 */
export class MessageElements {
  private made = new WeakMap<ChatMessage, { placed: Placed; element: React.ReactElement }>();

  place(message: ChatMessage, placed: Placed): React.ReactElement {
    const known = this.made.get(message);
    if (known && samePlace(known.placed, placed)) return known.element;
    const element = (
      <Fragment key={message.id}>
        {placed.newDay && <DaySeparator at={message.createdAt} />}
        {message.role === "user" ? (
          <UserBubble message={message} latest={"latest" in placed && placed.latest} />
        ) : (
          <AssistantBlock
            message={message}
            retry={"retry" in placed && placed.retry}
            asked={"asked" in placed ? placed.asked : undefined}
          />
        )}
      </Fragment>
    );
    this.made.set(message, { placed, element });
    return element;
  }
}

/** Where a day of the conversation starts. */
function DaySeparator({ at }: { at: number }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot hold the day's name
    <div role="separator" className="flex items-center gap-3 text-2xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {dayLabel(at)}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
