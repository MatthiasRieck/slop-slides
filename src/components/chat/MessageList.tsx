import { ArrowDown, ShieldAlert } from "lucide-react";
import { memo, type RefObject, useCallback, useLayoutEffect, useRef } from "react";

import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { scrollBehavior } from "../../lib/motion";
import { cn } from "../../lib/utils";
import { type ChatMessage, useApp } from "../../store";
import { retryTarget } from "../../store/messages";
import { AssistantBlock } from "./AssistantBlock";
import { MESSAGE_ITEM } from "./messageStyles";
import { UserBubble } from "./UserBubble";

/** How close to its end, in pixels, a conversation still counts as scrolled to its end. */
const AT_END_WITHIN = 48;

/** Whether the reply coming in waits for the user to allow or deny something. */
const awaitsApproval = (message: ChatMessage | undefined) =>
  message?.role === "assistant" &&
  message.status === "streaming" &&
  message.parts.some((p) => p.kind === "approval" && p.status === "pending");

/** Whether the scroller says there is more of the conversation below what shows. */
const awayFromEnd = (viewport: HTMLElement) =>
  (viewport.getAttribute("data-scrollable") ?? "").split(" ").includes("end");

/**
 * Keeps a reader who scrolled up where they were while the chat is out of view (see `ChatPanel`:
 * hidden, it keeps its state but not its effects). Shown again, the scroller starts over and
 * would follow the end; this puts the reader back and tells the scroller that they scrolled
 * there themselves, which is what makes it leave the end alone. A reader who was at the end
 * stays with it.
 *
 * It belongs above the scroller's provider: its effect then runs after the scroller's own.
 */
function useKeptPlace() {
  const viewport = useRef<HTMLDivElement>(null);
  /** Where the reader has scrolled to, away from the end; null while they are at it. */
  const place = useRef<number | null>(null);
  /** The same as the chat went out of view: what coming back starts from. */
  const left = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    const el = viewport.current;
    // Out of view it has no size, and where it is scrolled to says nothing.
    if (!el || el.clientHeight === 0) return;
    place.current = awayFromEnd(el) ? el.scrollTop : null;
  }, []);
  useLayoutEffect(() => {
    const el = viewport.current;
    const top = left.current;
    left.current = null;
    if (el && top !== null) {
      el.scrollTop = top;
      place.current = top;
      // A turn of the wheel is the reader's own scrolling to the scroller: it stops following the end.
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    }
    return () => {
      left.current = place.current;
    };
  }, []);
  return { viewport, onScroll };
}

/**
 * The conversation, kept scrolled to the latest message unless the user scrolled up (then a
 * button jumps back down, which also says when the agent waits for an approval down there). A
 * message the user sends is brought into view, wherever they had scrolled to. `children` show
 * in the place of a conversation that has no message yet: over the scroller, not in it, whose
 * content holds messages and nothing else. (The scroller counts every child of its content as a
 * message, and would take the saved messages of a chat that loads for ones that came in after
 * the placeholder: it would then open at the last turn's start and not at the end.)
 *
 * Staying at the end, and what counts as there, is the `MessageScroller`'s to tell, which
 * measures when the browser says a size changed and not when the conversation renders. The
 * conversation takes the messages from the chat itself and renders with each of the agent's
 * events, which is little: each message renders again only when it is another (see `Row`).
 */
export const MessageList = memo(function MessageList(props: { children?: React.ReactNode }) {
  const { viewport, onScroll } = useKeptPlace();
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end" scrollEdgeThreshold={AT_END_WITHIN}>
      <Conversation viewport={viewport} onScroll={onScroll}>
        {props.children}
      </Conversation>
    </MessageScrollerProvider>
  );
});

function Conversation(props: {
  viewport: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  children?: React.ReactNode;
}) {
  const messages = useApp((s) => s.messages);
  const running = useApp((s) => s.running);
  const last = messages.at(-1);
  const approval = running && awaitsApproval(last);
  const retry = !running && retryTarget(messages) !== null;

  return (
    <MessageScroller className="min-h-0 flex-1">
      <MessageScrollerViewport
        ref={props.viewport}
        aria-label="Conversation"
        onScroll={props.onScroll}
        // The fade at the bottom is as tall as the room under the last message, and so never over it.
        className="px-4 pt-4 [--scroll-fade-size:--spacing(6)]"
      >
        <MessageScrollerContent aria-busy={running || undefined} className="mx-auto w-full max-w-3xl gap-6 pb-6">
          {messages.map((message) => (
            <Row key={message.id} message={message} retry={retry && message === last} />
          ))}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      {props.children && (
        <div data-slot="message-list-placeholder" className="absolute inset-0 overflow-y-auto px-4 pt-4">
          <div className="mx-auto w-full max-w-3xl pb-6">{props.children}</div>
        </div>
      )}
      <MessageScrollerButton
        variant="outline"
        size="xs"
        // Those who asked their system for less motion get there at once.
        behavior={scrollBehavior()}
        aria-label={approval ? "Approval needed: jump to the request" : "Jump to latest message"}
        className={cn(
          // It floats over the conversation, so it is opaque: the outline button's own dark fill is not.
          "rounded-full px-3 shadow-sm data-[direction=end]:bottom-3 dark:bg-popover dark:hover:bg-[color-mix(in_oklch,var(--popover),var(--foreground)_8%)]",
          approval && "border-warning/60 text-warning hover:text-warning",
        )}
      >
        {approval ? (
          <>
            <ShieldAlert /> Approval needed <ArrowDown />
          </>
        ) : (
          <>
            <ArrowDown /> Jump to latest
          </>
        )}
      </MessageScrollerButton>
    </MessageScroller>
  );
}

/**
 * A message in its place in the scroller: one of the user's starts a turn, which the scroller
 * brings into view as it is sent. It renders again only when its message is another, so an event
 * of the agent's costs the reply it changes and nothing of the conversation before it.
 */
const Row = memo(function Row({ message, retry }: { message: ChatMessage; retry: boolean }) {
  const user = message.role === "user";
  return (
    <MessageScrollerItem messageId={message.id} scrollAnchor={user} className={MESSAGE_ITEM}>
      {user ? <UserBubble message={message} /> : <AssistantBlock message={message} retry={retry} />}
    </MessageScrollerItem>
  );
});
