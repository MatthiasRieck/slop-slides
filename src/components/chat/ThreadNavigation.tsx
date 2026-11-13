import { Check, History, Loader2, SquarePen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useDropdown } from "../../hooks/useDropdown";
import { api, errorMessage } from "../../lib/api";
import { cn, plural, relativeTime } from "../../lib/utils";
import { useApp } from "../../store";

type Thread = Awaited<ReturnType<typeof api.listChatThreads>>[number];

const HEADER_BUTTON =
  "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-default disabled:opacity-40";

/**
 * The chat's header: the workspace's past chats, to search and go on with, and a new chat. A
 * deck's chat opens its deck; any other moves to the chat on show. The list opens with the
 * keyboard in its search field: the arrows go through the chats, Enter goes on with the marked
 * one. `switching` is on while it switches, which holds the chat still meanwhile.
 */
export function ThreadNavigation({
  switching,
  setSwitching,
}: {
  switching: boolean;
  setSwitching: (value: boolean) => void;
}) {
  const workspace = useApp((s) => s.workspace);
  const chatKey = useApp((s) => s.chatKey);
  const running = useApp((s) => s.running);
  const { open, setOpen, ref } = useDropdown();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !chatKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .listChatThreads(chatKey)
      .then((items) => {
        if (!cancelled) setThreads(items);
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, chatKey]);
  // Each look at the list starts from all of it.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const shown = threads.filter((thread) =>
    `${thread.title} ${thread.association ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const canOpen = (thread: Thread) => !running && !switching && !thread.current;
  const marked = Math.min(active, shown.length - 1);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${marked}"]`)?.scrollIntoView({ block: "nearest" });
  }, [marked]);

  const navigate = async (thread?: Thread) => {
    setSwitching(true);
    setError(null);
    try {
      if (thread) await useApp.getState().selectChatThread(thread.id, thread.deck);
      else await useApp.getState().resetChat();
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSwitching(false);
    }
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, Math.min(shown.length - 1, marked + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const thread = shown[marked];
      if (thread && canOpen(thread)) void navigate(thread);
    }
  };

  const newChatBlocked = !workspace
    ? "Open a folder to chat"
    : running
      ? "Stop the current turn to start a new chat"
      : switching
        ? "Switching chats…"
        : null;

  return (
    <div ref={ref} className="relative z-20 shrink-0 border-b px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={!workspace || switching}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={HEADER_BUTTON}
        >
          {switching ? <Loader2 className="size-3.5 animate-spin" /> : <History className="size-3.5" />}
          {switching ? "Switching…" : "Past chats"}
        </button>
        <button
          type="button"
          title={newChatBlocked ?? "New chat (files are kept)"}
          disabled={newChatBlocked !== null}
          onClick={() => void navigate()}
          className={HEADER_BUTTON}
        >
          <SquarePen className="size-3.5" /> New chat
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {open && (
        <section
          className="absolute inset-x-3 top-full mt-1 rounded-xl border bg-card p-2 shadow-lg"
          aria-label="Past chats"
        >
          <p className="px-2 pb-2 text-xs text-muted-foreground">Chats in {workspace?.name}</p>
          <input
            autoFocus
            aria-label="Search chats"
            placeholder="Search chats, decks, or folders…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onSearchKey}
            className="mb-2 w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
          />
          {running && <p className="px-2 py-1 text-xs text-muted-foreground">Stop the current turn to switch chats.</p>}
          {loading ? (
            <p role="status" className="p-2 text-xs text-muted-foreground">
              Loading chats…
            </p>
          ) : (
            <div ref={listRef} className="max-h-72 overflow-y-auto">
              {shown.map((thread, index) => (
                <button
                  key={thread.id}
                  type="button"
                  data-index={index}
                  disabled={!canOpen(thread)}
                  onClick={() => void navigate(thread)}
                  onMouseMove={() => setActive(index)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg p-2 text-left enabled:hover:bg-accent disabled:opacity-40",
                    index === marked && "bg-accent",
                  )}
                  aria-current={thread.current ? "page" : undefined}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{thread.title}</p>
                    <p
                      className="truncate text-2xs text-muted-foreground"
                      title={thread.association ?? workspace?.path}
                    >
                      {thread.association && thread.association !== "." ? thread.association : workspace?.name}
                    </p>
                    <p
                      className="text-2xs text-muted-foreground"
                      title={thread.createdAt ? new Date(thread.createdAt).toLocaleString() : undefined}
                    >
                      {thread.createdAt ? `Started ${relativeTime(thread.createdAt)}` : "Empty chat"} ·{" "}
                      {plural(thread.messageCount, "message")}
                    </p>
                  </div>
                  {thread.current && <Check className="size-3.5 shrink-0" />}
                </button>
              ))}
              {shown.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">
                  {threads.length === 0 ? "No past chats yet." : "No chats match."}
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
