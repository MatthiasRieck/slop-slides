import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronLeft, FolderOpen, Play, Share } from "lucide-react";
import { useEffect, useState } from "react";

import { api, errorMessage } from "../lib/api";
import { cn, isMac } from "../lib/utils";
import { useApp } from "../store";

export function TopBar() {
  const deck = useApp((s) => s.deck);
  const [title, setTitle] = useState(deck?.title ?? "");

  useEffect(() => setTitle(deck?.title ?? ""), [deck?.title]);
  if (!deck) return null;

  const commitTitle = async () => {
    const next = title.trim();
    if (!next || next === deck.title) return setTitle(deck.title);
    try {
      useApp.getState().setDeck(await api.renameDeck(deck.id, next));
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  const exportDeck = async () => {
    const name = deck.title.replace(/[\\/:*?"<>|]+/g, "").trim() || "presentation";
    const dest = await save({
      title: "Export presentation",
      defaultPath: `${name}.html`,
      filters: [{ name: "HTML presentation", extensions: ["html"] }],
    });
    if (!dest) return;
    try {
      await api.exportDeck(deck.id, dest);
      await revealItemInDir(dest);
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b bg-background pr-3",
        isMac ? "pl-[84px]" : "pl-3",
      )}
    >
      <button
        type="button"
        onClick={() => void useApp.getState().closeDeck()}
        title="All decks"
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Decks
      </button>
      <span className="text-muted-foreground/40">/</span>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setTitle(deck.title);
            e.currentTarget.blur();
          }
        }}
        className="min-w-0 max-w-md flex-1 truncate rounded-md bg-transparent px-1.5 py-1 text-sm font-medium outline-none hover:bg-accent focus:bg-accent"
      />
      <div data-tauri-drag-region className="flex-1 self-stretch" />
      <button
        type="button"
        onClick={() => void revealItemInDir(`${deck.path}/deck.html`)}
        title="Show deck folder"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <FolderOpen className="size-4" />
      </button>
      <button
        type="button"
        disabled={deck.slides.length === 0}
        onClick={() => void exportDeck()}
        title="Save as one self-contained HTML file to share"
        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-40"
      >
        <Share className="size-3.5" />
        Export
      </button>
      <button
        type="button"
        disabled={deck.slides.length === 0}
        onClick={() => useApp.getState().setPresenting(true)}
        className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-40"
      >
        <Play className="size-3.5 fill-current" />
        Present
      </button>
    </header>
  );
}
