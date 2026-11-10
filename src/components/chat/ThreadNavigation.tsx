import { Check, History, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, errorMessage } from "../../lib/api";
import { useApp } from "../../store";
import { useDismiss } from "../Popover";

/**
 * The chat's header: past conversations of the workspace, to search and switch to, and a new
 * conversation. `switching` is on while it switches, which holds the chat still meanwhile.
 */
export function ThreadNavigation({
  switching,
  setSwitching,
}: {
  switching: boolean;
  setSwitching: (value: boolean) => void;
}) {
  const workspace = useApp((s) => s.workspace);
  const running = useApp((s) => s.running);
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<Awaited<ReturnType<typeof api.listChatThreads>>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false), { escape: true, capture: true });
  useEffect(() => {
    if (!open || !workspace) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .listChatThreads(workspace.path)
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
  }, [open, workspace]);
  const matches = (thread: (typeof threads)[number]) =>
    `${thread.title} ${thread.association ?? ""}`.toLowerCase().includes(query.toLowerCase());
  const navigate = async (thread?: string) => {
    setSwitching(true);
    setError(null);
    try {
      if (thread) await useApp.getState().selectChatThread(thread);
      else await useApp.getState().resetChat();
      setOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSwitching(false);
    }
  };
  return (
    <div ref={ref} className="relative z-20 shrink-0 border-b px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={!workspace || switching}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <History className="size-3.5" /> Past chats
        </button>
        <button
          type="button"
          title="New conversation (files are kept)"
          disabled={!workspace || running || switching}
          onClick={() => void navigate()}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" /> New chat
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
          aria-label="Past conversations"
        >
          <p className="px-2 pb-2 text-xs text-muted-foreground">Chats in {workspace?.name}</p>
          <input
            aria-label="Search conversations"
            placeholder="Search chats, decks, or folders…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-2 w-full rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus:border-ring"
          />
          {running && <p className="px-2 py-1 text-xs text-muted-foreground">Stop the current turn to switch chats.</p>}
          {loading ? (
            <p role="status" className="p-2 text-xs text-muted-foreground">
              Loading conversations…
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {threads.filter(matches).map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  disabled={running || switching || thread.current}
                  onClick={() => void navigate(thread.id)}
                  className="flex w-full items-center gap-2 rounded-lg p-2 text-left hover:bg-accent disabled:opacity-60"
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
                    <p className="text-2xs text-muted-foreground">
                      {thread.createdAt ? new Date(thread.createdAt).toLocaleDateString() : "Empty chat"} ·{" "}
                      {thread.messageCount} messages
                    </p>
                  </div>
                  {thread.current && <Check className="size-3.5 shrink-0" />}
                </button>
              ))}
              {!threads.some(matches) && <p className="p-2 text-xs text-muted-foreground">No conversations found.</p>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
