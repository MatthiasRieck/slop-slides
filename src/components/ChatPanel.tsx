import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  FileText,
  Globe,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Pencil,
  PenLine,
  RotateCcw,
  Search,
  Square,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { api, errorMessage } from "../lib/api";
import { cn } from "../lib/utils";
import { MODELS, useApp, type AssistantMessage, type ChatMessage, type ChatPart, type UserMessage } from "../store";

const SUGGESTIONS = [
  "A 6-slide pitch for a neighborhood tool-sharing app, bold and warm",
  "Teach the basics of compound interest to teenagers in 8 slides",
  "Quarterly engineering update: shipped, in progress, risks, asks",
];

export function ChatPanel() {
  const messages = useApp((s) => s.messages);
  const running = useApp((s) => s.running);
  const claudePath = useApp((s) => s.claudePath);
  const deckEmpty = useApp((s) => (s.deck?.slides.length ?? 0) === 0);
  const composerFill = useApp((s) => s.composerFill);
  const [draft, setDraft] = useState("");

  // Other parts of the app (e.g. the lint status) can hand the composer a prepared message.
  useEffect(() => {
    if (composerFill) setDraft(composerFill.text);
  }, [composerFill]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between px-3">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Chat
        </span>
        {messages.length > 0 && (
          <button
            type="button"
            title="New conversation (slides are kept)"
            onClick={() => void useApp.getState().resetChat()}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RotateCcw className="size-3" />
            New chat
          </button>
        )}
      </div>
      {claudePath === null && <MissingClaude />}
      <MessageList messages={messages} running={running}>
        {messages.length === 0 && (
          <EmptyChat deckEmpty={deckEmpty} onPick={(text) => setDraft(text)} />
        )}
      </MessageList>
      <Composer draft={draft} setDraft={setDraft} />
    </div>
  );
}

function MissingClaude() {
  return (
    <div className="mx-3 mb-2 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Claude Code was not found. Install it and sign in (<code>claude</code> in a terminal), or
        set <code>SLOPSLIDE_CLAUDE_PATH</code>, then restart SlopSlide.
      </span>
    </div>
  );
}

function EmptyChat({ deckEmpty, onPick }: { deckEmpty: boolean; onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-3 px-1 pt-6">
      <p className="text-sm text-muted-foreground">
        {deckEmpty
          ? "Describe the presentation you want. The agent writes the theme and slides; you can steer from there."
          : "Ask for changes to the current slide or the whole deck."}
      </p>
      {deckEmpty && (
        <div className="flex flex-col gap-1.5">
          {SUGGESTIONS.map((text) => (
            <button
              key={text}
              type="button"
              onClick={() => onPick(text)}
              className="rounded-lg border px-3 py-2 text-left text-xs leading-relaxed text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MessageList(props: { messages: ChatMessage[]; running: boolean; children?: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

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
      }}
      className="min-h-0 flex-1 overflow-y-auto px-3"
    >
      <div className="flex flex-col gap-4 pb-4">
        {props.children}
        {props.messages.map((message) =>
          message.role === "user" ? (
            <UserBubble key={message.id} message={message} />
          ) : (
            <AssistantBlock key={message.id} message={message} />
          ),
        )}
      </div>
    </div>
  );
}

function UserBubble({ message }: { message: UserMessage }) {
  const deck = useApp((s) => s.deck);
  const slideNumber = message.slide && deck ? deck.slides.findIndex((s) => s.id === message.slide) + 1 : 0;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="selectable max-w-[90%] whitespace-pre-wrap rounded-xl rounded-br-sm bg-accent px-3 py-2 text-sm leading-relaxed">
        {message.text}
      </div>
      {(slideNumber > 0 || message.attachments.length > 0) && (
        <div className="flex flex-wrap justify-end gap-1 text-2xs text-muted-foreground">
          {slideNumber > 0 && <span>on slide {slideNumber}</span>}
          {message.sketch && <span>· with sketch</span>}
          {message.screenshot && <span>· with screenshot</span>}
          {message.attachments.map((a) => (
            <span key={a}>· {a.replace(/^assets\//, "")}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantBlock({ message }: { message: AssistantMessage }) {
  const streaming = message.status === "streaming";
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, i) =>
        part.kind === "text" ? (
          part.text.trim() && (
            <div key={i} className="markdown selectable">
              <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>
            </div>
          )
        ) : (
          <ToolRow key={part.id} part={part} />
        ),
      )}
      {streaming && (message.thinking || message.parts.length === 0) && (
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
      {message.status === "interrupted" && (
        <span className="text-2xs text-muted-foreground">Stopped</span>
      )}
      {message.status === "done" && message.durationMs !== null && (
        <span className="text-2xs text-muted-foreground/70">
          {(message.durationMs / 1000).toFixed(1)}s
          {message.costUsd ? ` · $${message.costUsd.toFixed(3)}` : ""}
        </span>
      )}
    </div>
  );
}

function ToolRow({ part }: { part: Extract<ChatPart, { kind: "tool" }> }) {
  const deck = useApp((s) => s.deck);
  const { icon: Icon, label, target } = describeTool(part, deck?.id ?? "");
  const slide = target === "deck.html" ? editedSlide(part, deck?.slides.map((s) => s.id) ?? []) : null;
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
      {part.status === "done" && slide && <Check className="size-3 shrink-0 text-emerald-500" />}
    </button>
  );
}

/** The slide an Edit of deck.html touched, found via an `id="…"` in the edited text. */
function editedSlide(part: Extract<ChatPart, { kind: "tool" }>, slideIds: string[]): string | null {
  for (const key of ["new_string", "old_string"]) {
    const text = part.input[key];
    if (typeof text !== "string") continue;
    for (const match of text.matchAll(/\bid=["']([^"']+)["']/g)) {
      if (match[1] && slideIds.includes(match[1])) return match[1];
    }
  }
  return null;
}

function describeTool(part: Extract<ChatPart, { kind: "tool" }>, deckId: string) {
  const input = part.input;
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  // Tool paths are absolute inside the deck folder; show them deck-relative.
  const relative = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    const marker = `/${deckId}/`;
    const index = normalized.lastIndexOf(marker);
    return index >= 0 ? normalized.slice(index + marker.length) : normalized;
  };
  switch (part.name) {
    case "Write":
      return { icon: FileText, label: "Wrote", target: relative(str("file_path")) };
    case "Edit":
    case "MultiEdit":
      return { icon: Pencil, label: "Edited", target: relative(str("file_path")) };
    case "Read":
      return { icon: FileText, label: "Read", target: relative(str("file_path")) };
    case "Glob":
    case "Grep":
      return { icon: Search, label: "Searched", target: str("pattern") };
    case "WebSearch":
      return { icon: Globe, label: "Searched the web for", target: str("query") };
    case "WebFetch":
      return { icon: Globe, label: "Fetched", target: str("url") };
    default:
      return { icon: FileText, label: part.name, target: "" };
  }
}

function Composer(props: { draft: string; setDraft: (text: string) => void }) {
  const { draft, setDraft } = props;
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const running = useApp((s) => s.running);
  const model = useApp((s) => s.model);
  const [includeSlide, setIncludeSlide] = useState(true);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const slideNumber = selected && deck ? deck.slides.findIndex((s) => s.id === selected) + 1 : 0;
  const sketched = useApp((s) => (selected ? (s.sketches[selected]?.length ?? 0) > 0 : false));
  const sendsSketch = sketched && includeSlide && slideNumber > 0;

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [draft === ""]); // eslint-disable-line react-hooks/exhaustive-deps

  const composerFill = useApp((s) => s.composerFill);
  useEffect(() => {
    textareaRef.current?.focus();
  }, [composerFill]);

  const importPaths = async (paths: string[]) => {
    if (!deck || paths.length === 0) return;
    try {
      const imported = await api.importAssets(deck.id, paths);
      setAttachments((prev) => [...prev, ...imported.filter((a) => !prev.includes(a))]);
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  // Files dropped anywhere on the window become attachments.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") setDragging(true);
        else if (event.payload.type === "leave") setDragging(false);
        else if (event.payload.type === "drop") {
          setDragging(false);
          void importPaths(event.payload.paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [deck?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickFiles = async () => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Images & media", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "mp4", "webm", "pdf", "csv", "md", "txt"] }],
    });
    if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || running) return;
    void useApp.getState().send(text, { includeSlide: includeSlide && slideNumber > 0, attachments });
    setDraft("");
    setAttachments([]);
  };

  return (
    <div className="shrink-0 px-3 pb-3">
      <div
        className={cn(
          "rounded-xl border bg-card shadow-composer transition-colors focus-within:border-input",
          dragging && "border-primary ring-2 ring-primary/30",
        )}
      >
        {(attachments.length > 0 || slideNumber > 0) && (
          <div className="flex flex-wrap gap-1 px-2.5 pt-2.5">
            {slideNumber > 0 && (
              <button
                type="button"
                onClick={() => setIncludeSlide((v) => !v)}
                title={includeSlide ? "The agent will know which slide you are on" : "Not referencing the current slide"}
                className={cn(
                  "rounded-md border px-1.5 py-0.5 text-2xs",
                  includeSlide ? "border-primary/30 bg-primary/10 text-primary" : "text-muted-foreground line-through",
                )}
              >
                Slide {slideNumber}
              </button>
            )}
            {sendsSketch && (
              <span
                title="A screenshot of the slide with your drawing is sent along"
                className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-2xs text-primary"
              >
                <PenLine className="size-3" />
                Sketch
                <button
                  type="button"
                  aria-label="Discard sketch"
                  onClick={() => selected && useApp.getState().clearSketch(selected)}
                  className="hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            )}
            {attachments.map((a) => (
              <span key={a} className="flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs text-muted-foreground">
                <ImageIcon className="size-3" />
                {a.replace(/^assets\//, "")}
                <button
                  type="button"
                  onClick={() => setAttachments((prev) => prev.filter((p) => p !== a))}
                  className="hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={running ? "The agent is working…" : "Ask for slides or changes…"}
          className="block w-full resize-none bg-transparent px-3 pt-2.5 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <button
            type="button"
            onClick={pickFiles}
            title="Attach images or files"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Paperclip className="size-4" />
          </button>
          <select
            value={model}
            onChange={(e) => useApp.getState().setModel(e.target.value)}
            title="Model"
            className="rounded-md bg-transparent px-1 py-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <div className="flex-1" />
          {running ? (
            <button
              type="button"
              onClick={() => useApp.getState().interrupt()}
              title="Stop"
              className="flex size-7 items-center justify-center rounded-full bg-foreground text-background hover:opacity-80"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!draft.trim()}
              title="Send"
              className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
