import { Check, History, Loader2, Pencil, SquarePen, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useDropdown } from "../../hooks/useDropdown";
import { api, errorMessage } from "../../lib/api";
import { cn, plural, relativeTime } from "../../lib/utils";
import { useApp } from "../../store";
import { confirmAction } from "../../store/confirm";
import { firstMessageTitle } from "../../store/messages";
import { ToolButton } from "../Button";

export type Thread = Awaited<ReturnType<typeof api.listChatThreads>>[number];

const HEADER_BUTTON =
  "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground enabled:hover:bg-accent enabled:hover:text-foreground disabled:cursor-default disabled:opacity-40";

/**
 * The past chats in two groups: those about what the chat is about now (`chatKey`: the open
 * deck, or the folder), then those about the folder's other decks (or the folder itself). Each
 * group keeps the order it came in, newest first.
 */
export function groupThreads(threads: Thread[], chatKey: string | null): { here: Thread[]; elsewhere: Thread[] } {
  const isHere = (thread: Thread) =>
    thread.current || (thread.deck ? thread.deck === chatKey : thread.association === "." && !isDeck(chatKey));
  return { here: threads.filter(isHere), elsewhere: threads.filter((thread) => !isHere(thread)) };
}

/** Whether the chat is about a deck file rather than the folder. */
const isDeck = (chatKey: string | null) => !!chatKey && /\.html?$/i.test(chatKey);

/** What a past chat is about, for its row: the deck or folder by its path in the workspace. */
function aboutLabel(thread: Thread, workspaceName: string | undefined): string {
  return thread.association && thread.association !== "." ? thread.association : (workspaceName ?? "This folder");
}

/**
 * The chat's header: the name of the chat on show, the workspace's past chats to search, go on
 * with, rename and delete, and a new chat. The list puts the chats about what is open first; a
 * chat about another deck opens that deck. It opens with the keyboard in its search field: the
 * arrows go through the chats, Enter goes on with the marked one. `switching` is on while it
 * switches, which holds the chat still meanwhile.
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
  const given = useApp((s) => s.chatTitle);
  const first = useApp((s) => (s.chatTitle ? null : firstMessageTitle(s.messages)));
  const title = given ?? first;
  const { open, setOpen, ref } = useDropdown();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [renaming, setRenaming] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const load = async (cancelled: () => boolean = () => false) => {
    if (!chatKey) return;
    setLoading(true);
    setError(null);
    try {
      const items = await api.listChatThreads(chatKey);
      if (!cancelled()) setThreads(Array.isArray(items) ? items : []);
    } catch (e) {
      if (!cancelled()) setError(errorMessage(e));
    } finally {
      if (!cancelled()) setLoading(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads as the list opens, for the chat on show
  useEffect(() => {
    if (!open || !chatKey) return;
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [open, chatKey]);
  // Each look at the list starts from all of it.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setRenaming(null);
    }
  }, [open]);

  const matching = threads.filter((thread) =>
    `${thread.title} ${thread.association ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const { here, elsewhere } = groupThreads(matching, chatKey);
  const shown = [...here, ...elsewhere];
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

  const rename = async (thread: Thread, name: string) => {
    setRenaming(null);
    const next = name.trim();
    if (next === thread.title) return;
    try {
      await api.renameChatThread(thread.id, next);
      if (thread.current) useApp.getState().setChatTitle(next || null);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
    searchRef.current?.focus();
  };

  const remove = async (thread: Thread) => {
    const confirmed = await confirmAction({
      title: "Delete this chat?",
      message: `"${thread.title}" and its ${plural(thread.messageCount, "message")} are deleted for good. The deck stays as it is.`,
      confirmLabel: "Delete chat",
      destructive: true,
    });
    if (!confirmed || !chatKey) return;
    try {
      await api.deleteChatThread(chatKey, thread.id);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
    searchRef.current?.focus();
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

  const row = (thread: Thread, index: number, other: boolean) => (
    <ThreadRow
      key={thread.id}
      thread={thread}
      index={index}
      marked={index === marked}
      other={other}
      about={aboutLabel(thread, workspace?.name)}
      canOpen={canOpen(thread)}
      renaming={renaming === thread.id}
      onOpen={() => void navigate(thread)}
      onMark={() => setActive(index)}
      onRename={() => setRenaming(thread.id)}
      onRenamed={(name) => void rename(thread, name)}
      onCancelRename={() => setRenaming(null)}
      onDelete={() => void remove(thread)}
    />
  );

  return (
    <div ref={ref} className="relative z-20 shrink-0 border-b px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={!workspace || switching}
          aria-expanded={open}
          title="Past chats: go back to one, rename or delete it"
          onClick={() => setOpen(!open)}
          className={HEADER_BUTTON}
        >
          {switching ? <Loader2 className="size-3.5 animate-spin" /> : <History className="size-3.5" />}
          {switching ? "Switching…" : "Past chats"}
        </button>
        <p
          className="min-w-0 flex-1 truncate text-center text-xs font-medium text-foreground/80"
          title={title ?? undefined}
        >
          {title}
        </p>
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
          <input
            ref={searchRef}
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
          {loading && threads.length === 0 ? (
            <p role="status" className="p-2 text-xs text-muted-foreground">
              Loading chats…
            </p>
          ) : (
            <div ref={listRef} className="max-h-80 overflow-y-auto">
              {here.length > 0 && <GroupLabel>{isDeck(chatKey) ? "This deck" : `This folder`}</GroupLabel>}
              {here.map((thread, index) => row(thread, index, false))}
              {elsewhere.length > 0 && (
                <GroupLabel>
                  {isDeck(chatKey) ? `Other decks in ${workspace?.name ?? "this folder"}` : "Decks in this folder"}
                </GroupLabel>
              )}
              {elsewhere.map((thread, index) => row(thread, here.length + index, true))}
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

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-2 pt-2 pb-1 text-2xs font-medium text-muted-foreground first:pt-0">{children}</p>;
}

/**
 * A past chat in the list: its name, what it is about, when it started and how long it is. On
 * hover (or marked) it offers to rename it in place and to delete it; the chat on show cannot be
 * deleted. One about another deck says that it opens that deck.
 */
function ThreadRow(props: {
  thread: Thread;
  index: number;
  marked: boolean;
  other: boolean;
  about: string;
  canOpen: boolean;
  renaming: boolean;
  onOpen: () => void;
  onMark: () => void;
  onRename: () => void;
  onRenamed: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const { thread, marked, other, about, renaming } = props;
  const [name, setName] = useState(thread.title);
  // Once the name is given or given up, the field going away is no answer of its own.
  const done = useRef(false);
  useEffect(() => {
    if (!renaming) return;
    setName(thread.title);
    done.current = false;
  }, [renaming, thread.title]);
  const finish = (rename: boolean) => {
    if (done.current) return;
    done.current = true;
    if (rename) props.onRenamed(name);
    else props.onCancelRename();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the pointer marks the row as the arrows in the search field do; the row's buttons act
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: as above
    <div
      data-index={props.index}
      onMouseMove={props.onMark}
      className={cn("group/row flex items-center gap-1 rounded-lg pr-1", marked && "bg-accent")}
    >
      {renaming ? (
        <form
          className="min-w-0 flex-1 p-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            finish(true);
          }}
        >
          <input
            autoFocus
            aria-label="Chat name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => finish(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                finish(false);
              }
            }}
            className="w-full rounded-md border bg-background px-2 py-1 text-sm outline-none focus:border-ring"
          />
        </form>
      ) : (
        <button
          type="button"
          disabled={!props.canOpen}
          onClick={props.onOpen}
          title={other && thread.deck ? `Opens ${about}` : undefined}
          aria-current={thread.current ? "page" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg p-2 text-left disabled:cursor-default"
        >
          <div className="min-w-0 flex-1">
            <p className={cn("truncate text-sm", !props.canOpen && !thread.current && "opacity-60")}>{thread.title}</p>
            <p className="truncate text-2xs text-muted-foreground" title={about}>
              {other && thread.deck ? `Opens ${about}` : about}
            </p>
            <p
              className="text-2xs text-muted-foreground"
              title={thread.createdAt ? new Date(thread.createdAt).toLocaleString() : undefined}
            >
              {thread.createdAt ? `Started ${relativeTime(thread.createdAt)}` : "Empty chat"} ·{" "}
              {plural(thread.messageCount, "message")}
            </p>
          </div>
          {thread.current && <Check aria-label="On show" className="size-3.5 shrink-0" />}
        </button>
      )}
      {!renaming && (
        <div
          className={cn(
            "flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100",
            marked && "opacity-100",
          )}
        >
          <ToolButton variant="panel" size="xs" label="Rename chat" onClick={props.onRename}>
            <Pencil className="size-3.5" />
          </ToolButton>
          <ToolButton
            variant="panel"
            size="xs"
            label="Delete chat…"
            destructive
            disabled={thread.current}
            disabledReason="This is the chat on show: start a new chat to delete it"
            onClick={props.onDelete}
          >
            <Trash2 className="size-3.5" />
          </ToolButton>
        </div>
      )}
    </div>
  );
}
