import { ArrowDown, ShieldAlert } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { type ChatMessage, useApp } from "../../store";
import { retryTarget } from "../../store/messages";
import { AssistantBlock } from "./AssistantBlock";
import { UserBubble } from "./UserBubble";
import { usePinnedScroll } from "./usePinnedScroll";

/** Whether the reply coming in waits for the user to allow or deny something. */
const awaitsApproval = (message: ChatMessage | undefined) =>
  message?.role === "assistant" &&
  message.status === "streaming" &&
  message.parts.some((p) => p.kind === "approval" && p.status === "pending");

/**
 * The conversation, kept scrolled to the latest message unless the user scrolled up (then a
 * button jumps back down, which also says when the agent waits for an approval down there). A
 * message the user sends always shows. `children` come before the messages.
 *
 * It takes the messages from the chat itself and renders with each of the agent's events, which
 * is little: each message renders again only when it is another (see `AssistantBlock`), and
 * staying at the end is the browser's to tell (see `usePinnedScroll`).
 */
export const MessageList = memo(function MessageList(props: { children?: React.ReactNode }) {
  const messages = useApp((s) => s.messages);
  const running = useApp((s) => s.running);
  const lastSent = messages.findLast((m) => m.role === "user")?.id;
  const { scroller, content, away, toEnd, onScroll } = usePinnedScroll(lastSent);

  const last = messages.at(-1);
  const approval = running && awaitsApproval(last);
  const retry = !running && retryTarget(messages) !== null;

  return (
    <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto px-4 pt-4">
      <div ref={content} className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6">
        {props.children}
        {messages.map((message) =>
          message.role === "user" ? (
            <UserBubble key={message.id} message={message} />
          ) : (
            <AssistantBlock key={message.id} message={message} retry={retry && message === last} />
          ),
        )}
      </div>
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
