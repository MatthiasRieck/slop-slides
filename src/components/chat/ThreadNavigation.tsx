import { History, SquarePen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandLoading } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { api, errorMessage } from "../../lib/api";
import { plural, relativeTime } from "../../lib/utils";
import { useApp } from "../../store";

type Thread = Awaited<ReturnType<typeof api.listChatThreads>>[number];

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
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const header = useRef<HTMLDivElement>(null);
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

  const newChatBlocked = !workspace
    ? "Open a folder to chat"
    : running
      ? "Stop the current turn to start a new chat"
      : switching
        ? "Switching chats…"
        : null;

  return (
    <div ref={header} className="shrink-0 border-b px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={<Button variant="tool" size="xs" disabled={!workspace || switching} className="font-normal" />}
          >
            {switching ? <Spinner aria-hidden="true" data-icon="inline-start" /> : <History data-icon="inline-start" />}
            {switching ? "Switching…" : "Past chats"}
          </PopoverTrigger>
          {/* As wide as the header it opens under, whatever the width of the button. */}
          <PopoverContent
            anchor={header}
            aria-label="Past chats"
            className="w-[calc(var(--anchor-width)-1.5rem)] gap-0 p-0"
          >
            {/* The chats are searched here, as written: a chat shows when its name or its deck holds the words. */}
            <Command shouldFilter={false} label="Search chats">
              <p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">Chats in {workspace?.name}</p>
              <CommandInput placeholder="Search chats, decks, or folders…" value={query} onValueChange={setQuery} />
              {running && (
                <p className="px-2 pt-2 text-xs text-muted-foreground">Stop the current turn to switch chats.</p>
              )}
              <CommandList label="Chats" className="mt-1">
                {loading ? (
                  <CommandLoading label="Loading chats">Loading chats…</CommandLoading>
                ) : (
                  <>
                    <CommandEmpty className="p-2 text-left text-xs text-muted-foreground">
                      {threads.length === 0 ? "No past chats yet." : "No chats match."}
                    </CommandEmpty>
                    {shown.map((thread) => (
                      <CommandItem
                        key={thread.id}
                        value={thread.id}
                        disabled={!canOpen(thread)}
                        onSelect={() => void navigate(thread)}
                        aria-current={thread.current ? "page" : undefined}
                        data-checked={thread.current || undefined}
                        className="rounded-lg p-2"
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
                      </CommandItem>
                    ))}
                  </>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <Button
          variant="tool"
          size="xs"
          tooltip={newChatBlocked ?? "New chat (files are kept)"}
          disabled={newChatBlocked !== null}
          onClick={() => void navigate()}
          className="font-normal"
        >
          <SquarePen data-icon="inline-start" /> New chat
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
