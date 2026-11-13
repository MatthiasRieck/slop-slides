import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronRight,
  FileText,
  FoldVertical,
  Loader2,
  Pencil,
  RotateCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { isImage } from "../../lib/drop";
import { basename, cn, workspaceChatFileUrl } from "../../lib/utils";
import { type AssistantMessage, type ChatMessage, type UserMessage, useApp } from "../../store";
import { retryTarget } from "../../store/messages";
import { ApprovalCard, ApprovalReview } from "../Permissions";
import { formatElapsed, replyActivity } from "./activity";
import { ChatMarkdown } from "./ChatMarkdown";
import { CopyButton } from "./CopyButton";
import { describeTool, editedSlide, groupParts, stepsLabel, type ToolPart, toolArguments } from "./toolCalls";
import { useElapsed } from "./useElapsed";

/** Shows on hovering its message, or with the keyboard focus on it. */
const ON_HOVER = "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100";

/** Whether the reply coming in waits for the user to allow or deny something. */
const awaitsApproval = (message: ChatMessage | undefined) =>
  message?.role === "assistant" &&
  message.status === "streaming" &&
  message.parts.some((p) => p.kind === "approval" && p.status === "pending");

/**
 * The conversation, kept scrolled to the latest message unless the user scrolled up (then a
 * button jumps back down, which also says when the agent waits for an approval down there). A
 * message the user sends always shows. `children` come before the messages.
 */
export function MessageList(props: { messages: ChatMessage[]; running: boolean; children?: React.ReactNode }) {
  const { messages, running } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const lastSent = messages.findLast((m) => m.role === "user")?.id;
  const seenSent = useRef(lastSent);

  const jump = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinned.current = true;
    setShowLatest(false);
  };

  useLayoutEffect(() => {
    // The user's own message is what they want to see next, wherever they had scrolled to.
    if (lastSent !== seenSent.current) {
      seenSent.current = lastSent;
      pinned.current = true;
      setShowLatest(false);
    }
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  const last = messages.at(-1);
  const approval = running && awaitsApproval(last);
  const retry = !running && retryTarget(messages) !== null;

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
        {messages.map((message) =>
          message.role === "user" ? (
            <UserBubble key={message.id} message={message} />
          ) : (
            <AssistantBlock key={message.id} message={message} retry={retry && message === last} />
          ),
        )}
      </div>
      {showLatest && (
        <div className="sticky bottom-3 flex justify-center">
          <button
            type="button"
            aria-label={approval ? "Approval needed: jump to the request" : "Jump to latest message"}
            onClick={jump}
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
}

/** What a picture sent along with a message shows, for those who cannot see it. */
type Picture = { path: string; alt: string };

/** The pictures that went along with a message: its screenshot, its sketch and its attached images. */
function picturesOf(message: UserMessage): Picture[] {
  return [
    ...(message.screenshot ? [{ path: message.screenshot, alt: "Slide screenshot" }] : []),
    ...(message.sketch?.image ? [{ path: message.sketch.image, alt: "Slide with your sketch" }] : []),
    ...message.attachments.filter(isImage).map((path) => ({ path, alt: basename(path) })),
  ];
}

/** A picture sent along with a message, small; nothing once its file is gone. */
function Thumbnail({ picture, workspace }: { picture: Picture; workspace: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a failed load is not an interaction
    <img
      src={workspaceChatFileUrl(workspace, picture.path)}
      alt={picture.alt}
      title={picture.alt}
      loading="lazy"
      draggable={false}
      onError={() => setMissing(true)}
      className="size-14 rounded-lg border bg-muted object-cover"
    />
  );
}

/** A message of the user's, long ones folded, with what went along with it. */
function UserBubble({ message }: { message: UserMessage }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = message.text.length > 900 || message.text.split("\n").length > 12;
  const deck = useApp((s) => s.deck);
  const workspace = useApp((s) => s.workspace?.path ?? "");
  const slideNumber = message.slide && deck ? deck.slides.findIndex((s) => s.id === message.slide) + 1 : 0;
  const pictures = picturesOf(message);
  const files = message.attachments.filter((a) => !isImage(a));
  return (
    <div className="group flex min-w-0 flex-col items-end gap-1">
      {pictures.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {pictures.map((picture) => (
            <Thumbnail key={picture.path} picture={picture} workspace={workspace} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul className="flex max-w-[85%] flex-wrap justify-end gap-1">
          {files.map((file) => (
            <li
              key={file}
              title={file}
              className="flex h-6 min-w-0 max-w-full items-center gap-1 rounded-md border px-1.5 text-xs text-muted-foreground"
            >
              <FileText className="size-3 shrink-0" />
              <span className="truncate">{file.replace(/^assets\//, "")}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="selectable min-w-0 max-w-[85%] rounded-2xl bg-accent p-3 text-sm leading-relaxed">
        {/* What the user typed is shown as typed: marks in it are not formatting. */}
        <p
          className={cn(
            "whitespace-pre-wrap break-words",
            collapsible &&
              !expanded &&
              "max-h-44 overflow-hidden [mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
          )}
        >
          {message.text}
        </p>
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
      <div className="flex items-center">
        {!message.command && (
          <button
            type="button"
            aria-label="Edit message"
            title="Edit: put this text back into the message box"
            onClick={() => useApp.getState().fillComposer(message.text)}
            className={cn("rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground", ON_HOVER)}
          >
            <Pencil className="size-3" />
          </button>
        )}
        <CopyButton text={message.text} label="Copy message" className={ON_HOVER} />
      </div>
      {(slideNumber > 0 ||
        message.sketch ||
        !!message.comments?.length ||
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
        </div>
      )}
    </div>
  );
}

/**
 * A reply of the agent's: its text, tool calls and approvals, and how the turn went. While it
 * comes in, its last line says what the agent is doing and for how long. Finished, tool calls in
 * a row fold into one line of steps; `retry` offers to send the message it answered again.
 */
function AssistantBlock({ message, retry }: { message: AssistantMessage; retry: boolean }) {
  const streaming = message.status === "streaming";
  // While the agent works, each step shows as it happens.
  const groups = streaming
    ? message.parts.map((part, index) => ({ kind: "part" as const, part, index }))
    : groupParts(message.parts);
  return (
    <div className="group min-w-0 flex flex-col gap-2">
      {groups.map((group) => {
        if (group.kind === "steps") return <ToolSteps key={group.tools[0]!.id} tools={group.tools} />;
        const { part, index } = group;
        return part.kind === "text" ? (
          part.text.trim() && (
            <div key={index} className="markdown selectable">
              <ChatMarkdown>{part.text}</ChatMarkdown>
            </div>
          )
        ) : part.kind === "approval" ? (
          <ApprovalCard key={part.approval.id} part={part} />
        ) : part.kind === "approvalReview" ? (
          <ApprovalReview key={part.id} part={part} />
        ) : (
          <ToolRow key={part.id} part={part} />
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
}

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

/** Tool calls of a finished reply that followed one another, as one line that unfolds into them. */
function ToolSteps({ tools }: { tools: ToolPart[] }) {
  const [open, setOpen] = useState(false);
  const failed = tools.some((tool) => tool.status === "error");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        title={open ? "Hide the steps" : "Show each step"}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 self-start rounded-md text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        {failed && <X className="size-3.5 shrink-0 text-destructive" />}
        {stepsLabel(tools)}
      </button>
      {open && (
        <div className="flex min-w-0 flex-col gap-2 border-l pl-3">
          {tools.map((tool) => (
            <ToolRow key={tool.id} part={tool} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A tool call of the agent's; an edit of the deck's slide selects that slide when pressed. Its
 * arguments and output unfold beneath it.
 */
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
  const [open, setOpen] = useState(false);
  const args = toolArguments(part);
  const images = part.images ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1">
        <ToolSummary part={part} icon={Icon} label={label} target={target} slide={slide} />
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} arguments and output of ${label}${target ? ` ${target}` : ""}`}
          title={open ? "Hide arguments and output" : "Show arguments and output"}
          onClick={() => setOpen(!open)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && (
        <div className="selectable flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/40 p-2.5 text-xs">
          <ToolDetail title={`Arguments · ${part.name}`}>
            {args.length === 0 ? (
              <span className="text-muted-foreground">None</span>
            ) : (
              <dl className="flex min-w-0 flex-col gap-1.5">
                {args.map((arg) => (
                  <div key={arg.name} className="min-w-0">
                    <dt className="font-mono text-2xs text-muted-foreground">{arg.name}</dt>
                    <dd>
                      <ToolText text={arg.value} />
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </ToolDetail>
          <ToolDetail title={part.status === "error" ? "Error" : "Output"}>
            {part.output ? (
              <ToolText text={part.output} error={part.status === "error"} />
            ) : (
              !images.length && (
                <span className="text-muted-foreground">{part.status === "running" ? "Running…" : "No output"}</span>
              )
            )}
            {images.length > 0 && (
              <div className="flex min-w-0 flex-col gap-2">
                {images.map((path, i) => (
                  <ToolImage key={path} path={path} alt={`Image ${i + 1} of ${images.length} the agent received`} />
                ))}
              </div>
            )}
          </ToolDetail>
        </div>
      )}
    </div>
  );
}

/** A titled part of a tool call's details. */
function ToolDetail(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{props.title}</h4>
      {props.children}
    </section>
  );
}

/** An image a tool gave the agent, as kept in the chat's session; the chat keeps only the newest. */
function ToolImage({ path, alt }: { path: string; alt: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="text-muted-foreground">This image is no longer kept.</span>;
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: a failed load is not an interaction
    <img
      src={workspaceChatFileUrl("", path)}
      alt={alt}
      loading="lazy"
      onError={() => setMissing(true)}
      className="max-h-96 max-w-full self-start rounded-md border bg-muted object-contain"
    />
  );
}

/** Text of a tool call as it was written, scrolling when long. */
function ToolText({ text, error }: { text: string; error?: boolean }) {
  return (
    <pre
      className={cn(
        "max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.95em] leading-relaxed",
        error ? "text-destructive" : "text-foreground/80",
      )}
    >
      {text}
    </pre>
  );
}

/** The line a tool call shows: what it did and to what, linked to the slide it edited. */
function ToolSummary(props: {
  part: ToolPart;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  target: string;
  slide: string | null;
}) {
  const { part, icon: Icon, label, target, slide } = props;
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
