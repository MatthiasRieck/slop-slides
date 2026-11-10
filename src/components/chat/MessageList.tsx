import { AlertTriangle, ArrowDown, Check, Copy, FoldVertical, Loader2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../../lib/utils";
import { type AssistantMessage, type ChatMessage, type UserMessage, useApp } from "../../store";
import { ApprovalCard, ApprovalReview } from "../Permissions";
import { describeTool, editedSlide, type ToolPart } from "./toolCalls";

/**
 * The conversation, kept scrolled to the latest message unless the user scrolled up (then a
 * button jumps back down). `children` come before the messages.
 */
export function MessageList(props: { messages: ChatMessage[]; running: boolean; children?: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        setShowLatest(!pinned.current);
      }}
      className="relative min-h-0 flex-1 overflow-y-auto px-4 pt-4"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6">
        {props.children}
        {props.messages.map((message) =>
          message.role === "user" ? (
            <UserBubble key={message.id} message={message} />
          ) : (
            <AssistantBlock key={message.id} message={message} />
          ),
        )}
      </div>
      {showLatest && (
        <div className="sticky bottom-3 flex justify-center">
          <button
            type="button"
            aria-label="Jump to latest message"
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
              pinned.current = true;
              setShowLatest(false);
            }}
            className="flex items-center gap-1 rounded-full border bg-card px-3 py-1.5 text-xs shadow-sm"
          >
            <ArrowDown className="size-3" /> Latest
          </button>
        </div>
      )}
    </div>
  );
}

/** A message of the user's, long ones folded, with what went along with it. */
function UserBubble({ message }: { message: UserMessage }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = message.text.length > 900 || message.text.split("\n").length > 12;
  const deck = useApp((s) => s.deck);
  const slideNumber = message.slide && deck ? deck.slides.findIndex((s) => s.id === message.slide) + 1 : 0;
  return (
    <div className="group flex min-w-0 flex-col items-end gap-1">
      <div className="selectable min-w-0 max-w-[85%] rounded-2xl bg-accent p-3 text-sm leading-relaxed">
        <div
          className={cn(
            "markdown whitespace-pre-wrap break-words",
            collapsible &&
              !expanded &&
              "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
          )}
        >
          <Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown>
        </div>
        {collapsible && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="mt-2 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? "Show less" : "Show full message"}
          </button>
        )}
      </div>
      <CopyMessage text={message.text} />
      {(slideNumber > 0 ||
        message.attachments.length > 0 ||
        message.screenshot ||
        message.element ||
        message.reverted) && (
        <div className="flex flex-wrap justify-end gap-1 text-2xs text-muted-foreground">
          {message.reverted && <span title="You undid what this turn changed in the deck">changes undone ·</span>}
          {slideNumber > 0 && <span>on slide {slideNumber}</span>}
          {message.sketch && <span>· with sketch</span>}
          {!!message.comments?.length && (
            <span>
              · with {message.comments.length} comment{message.comments.length === 1 ? "" : "s"}
            </span>
          )}
          {message.element && <span>· about {message.element.name}</span>}
          {message.screenshot && <span>· with screenshot</span>}
          {message.attachments.map((a) => (
            <span key={a}>· {a.replace(/^assets\//, "")}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** A reply of the agent's: its text, tool calls and approvals, and how the turn went. */
function AssistantBlock({ message }: { message: AssistantMessage }) {
  const streaming = message.status === "streaming";
  return (
    <div className="group min-w-0 flex flex-col gap-2">
      {message.parts.map((part, i) =>
        part.kind === "text" ? (
          part.text.trim() && (
            // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts only grow at the end
            <div key={i} className="markdown selectable">
              <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>
            </div>
          )
        ) : part.kind === "approval" ? (
          <ApprovalCard key={part.approval.id} part={part} />
        ) : part.kind === "approvalReview" ? (
          <ApprovalReview key={part.id} part={part} />
        ) : (
          <ToolRow key={part.id} part={part} />
        ),
      )}
      {streaming && message.compacting && <span className="shimmer-text text-xs">Compacting the conversation…</span>}
      {message.compacted && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FoldVertical className="size-3.5 shrink-0" />
          Conversation compacted
        </span>
      )}
      {streaming && !message.compacting && (message.thinking || (message.parts.length === 0 && !message.compacted)) && (
        <span className="shimmer-text text-xs">Thinking…</span>
      )}
      {streaming && !message.thinking && message.parts.at(-1)?.kind === "tool" && (
        <span className="shimmer-text text-xs">Working…</span>
      )}
      {message.error && (
        <div className="selectable flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="whitespace-pre-wrap break-words">{message.error}</span>
        </div>
      )}
      {!streaming && message.parts.some((p) => p.kind === "text" && p.text.trim()) && (
        <div>
          <CopyMessage
            text={message.parts
              .filter((p) => p.kind === "text")
              .map((p) => p.text)
              .join("\n\n")}
          />
        </div>
      )}
      {message.status === "interrupted" && <span className="text-2xs text-muted-foreground">Stopped</span>}
      {message.status === "done" && message.durationMs !== null && (
        <span className="text-2xs text-muted-foreground/70">
          {(message.durationMs / 1000).toFixed(1)}s{message.costUsd ? ` · $${message.costUsd.toFixed(3)}` : ""}
        </span>
      )}
    </div>
  );
}

/** A tool call of the agent's; an edit of the deck's slide selects that slide when pressed. */
function ToolRow({ part }: { part: ToolPart }) {
  const deck = useApp((s) => s.deck);
  const { icon: Icon, label, target } = describeTool(part, deck?.id ?? "");
  const slide = deck
    ? editedSlide(
        part,
        target,
        deck.id,
        deck.slides.map((s) => s.id),
      )
    : null;
  return (
    <button
      type="button"
      disabled={!slide}
      onClick={() => slide && useApp.getState().select(slide)}
      className="flex min-w-0 items-center gap-2 rounded-md text-left text-xs text-muted-foreground enabled:hover:text-foreground"
    >
      {part.status === "running" ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : part.status === "error" ? (
        <X className="size-3.5 shrink-0 text-destructive" />
      ) : (
        <Icon className="size-3.5 shrink-0" />
      )}
      <span className="truncate">
        {label}
        {target && <span className="font-mono text-[0.95em] text-foreground/80"> {target}</span>}
        {slide && <span className="font-mono text-[0.95em] text-foreground/80"> · #{slide}</span>}
      </span>
      {part.status === "done" && slide && <Check className="size-3 shrink-0 text-success" />}
    </button>
  );
}

/** Copies a message's text, showing for a moment that it did. */
function CopyMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      title={failed ? "Could not copy. Try again." : copied ? "Copied" : "Copy message"}
      aria-label={copied ? "Copied" : "Copy message"}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            setFailed(false);
          })
          .catch(() => setFailed(true));
      }}
      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 focus-visible:opacity-100"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}
