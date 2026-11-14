import { FileText, Presentation } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type WorkspaceEntry } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useApp } from "../../store";
import { type MentionItem, mentionItems } from "./mentions";

/** How long typing pauses before the workspace's files are searched for what was typed. */
const SEARCH_DELAY = 150;

/** The files of the workspace that fit `query`: a search for it, or without one the files at the top of the folder. */
function useWorkspaceFiles(query: string): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const files = (entries: WorkspaceEntry[] | undefined) =>
      (Array.isArray(entries) ? entries : []).filter((e) => e.kind !== "directory").map((e) => e.path);
    const timer = setTimeout(
      () => {
        const listing = query.trim()
          ? api.searchFiles(query.trim()).then((found) => files(found?.found))
          : api.listDir("").then(files);
        void listing
          .then((paths) => !cancelled && setFiles(paths))
          // Without the files, the menu still lists the slides.
          .catch(() => !cancelled && setFiles([]));
      },
      query ? SEARCH_DELAY : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);
  return files;
}

/**
 * The menu that "@" opens in the message box: the deck's slides and the workspace's files that
 * fit what was typed after it, to refer to in the message. The keys stay in the message box
 * (see `Composer`): the arrows mark an item, Enter or Tab picks it, Escape closes the menu.
 * `active` is the marked item's place; `onItems` hears what is listed, for the keys to go through.
 */
export function MentionMenu(props: {
  query: string;
  active: number;
  onItems: (items: MentionItem[]) => void;
  onPick: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  const { query, active, onItems, onPick, onHover } = props;
  const slides = useApp((s) => s.deck?.slides);
  const files = useWorkspaceFiles(query);
  const [items, setItems] = useState<MentionItem[]>([]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const next = mentionItems(query, slides ?? [], files);
    setItems(next);
    onItems(next);
  }, [query, slides, files, onItems]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      ref={list}
      id="composer-mentions"
      role="listbox"
      aria-label="Slides and files to refer to"
      className="absolute bottom-full left-3 right-3 z-dropdown mb-1 max-h-64 overflow-y-auto rounded-xl border bg-card p-1 text-sm shadow-composer"
    >
      {items.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">No slides or files match.</p>
      ) : (
        items.map((item, index) => (
          <div
            key={item.kind === "slide" ? `slide:${item.id}` : `file:${item.path}`}
            id={`composer-mention-${index}`}
            role="option"
            data-index={index}
            aria-selected={index === active}
            tabIndex={-1}
            // The message box keeps the focus: picking happens on press, before it could lose it.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(item);
            }}
            onMouseMove={() => onHover(index)}
            className={cn(
              "flex min-w-0 cursor-default items-center gap-2 rounded-lg px-2 py-1.5",
              index === active && "bg-accent",
            )}
          >
            {item.kind === "slide" ? (
              <Presentation className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate">{item.label}</span>
            {item.kind === "file" && item.folder && (
              <span className="ml-auto truncate text-2xs text-muted-foreground">{item.folder}</span>
            )}
          </div>
        ))
      )}
    </div>
  );
}
