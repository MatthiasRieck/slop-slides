import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Code2,
  FileCode2,
  FileText,
  Film,
  Images,
  Loader2,
  Play,
  Presentation,
  Share,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type Deck, errorMessage } from "../lib/api";
import { basename, cn } from "../lib/utils";
import { VIDEO_CANCELLED, type VideoOptions } from "../lib/video";
import { lintFixPrompt, type StageView, useApp } from "../store";
import { FindButton } from "./FindReplace";
import { SlideSizeButton } from "./SlideSize";
import { Popover } from "./Templates";
import { VideoExportPanel } from "./VideoExport";

/**
 * The open deck's toolbar, above the slides (or its HTML): the title, find and replace, the
 * slide size, lint, the Slides / HTML switch, export and present.
 */
export function DeckToolbar() {
  const deck = useApp((s) => s.deck);
  if (!deck) return null;
  return <DeckTools deck={deck} />;
}

function DeckTools({ deck }: { deck: Deck }) {
  const [title, setTitle] = useState(deck.title);
  // Escape blurs the field, and blur commits; this keeps that blur from saving the edit.
  const cancelled = useRef(false);

  useEffect(() => setTitle(deck.title), [deck.title]);

  const commitTitle = async () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    const next = title.trim();
    if (!next || next === deck.title) return setTitle(deck.title);
    try {
      useApp.getState().setDeck(await api.renameDeck(deck.id, next));
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  // An export the backend is still writing (printing a PDF takes a moment).
  const [exporting, setExporting] = useState(false);
  // How much of a video export is done, 0–1; null when none is running.
  const [videoProgress, setVideoProgress] = useState<number | null>(null);

  const fileName = deck.title.replace(/[\\/:*?"<>|]+/g, "").trim() || "presentation";

  const exportDeck = async () => {
    const dest = await save({
      title: "Export presentation",
      defaultPath: `${fileName}.html`,
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

  const exportPdf = async () => {
    const dest = await save({
      title: "Export as PDF",
      defaultPath: `${fileName}.pdf`,
      filters: [{ name: "PDF document", extensions: ["pdf"] }],
    });
    if (!dest) return;
    setExporting(true);
    try {
      await api.exportPdf(deck.id, dest);
      await revealItemInDir(dest);
    } catch (error) {
      useApp.getState().setError(`Could not save the PDF: ${errorMessage(error)}`);
    } finally {
      setExporting(false);
    }
  };

  const exportVideo = async (options: VideoOptions) => {
    const dest = await save({
      title: "Export as video",
      defaultPath: `${fileName}.mp4`,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (!dest) return;
    setExporting(true);
    setVideoProgress(0);
    const unlisten = await listen<{ frame: number; frames: number }>("video-export-progress", ({ payload }) =>
      setVideoProgress(payload.frames > 0 ? payload.frame / payload.frames : 0),
    );
    try {
      await api.exportVideo(deck.id, dest, options);
      await revealItemInDir(dest);
    } catch (error) {
      const message = errorMessage(error);
      if (message !== VIDEO_CANCELLED) useApp.getState().setError(`Could not save the video: ${message}`);
    } finally {
      unlisten();
      setVideoProgress(null);
      setExporting(false);
    }
  };

  const exportImages = async () => {
    const parent = await open({ directory: true, title: "Choose where to save the slide images" });
    if (!parent || Array.isArray(parent)) return;
    try {
      useApp.getState().startImageExport(await api.createImageExportDir(deck.id, parent));
    } catch (error) {
      useApp.getState().setError(errorMessage(error));
    }
  };

  return (
    <div role="toolbar" aria-label="Deck" className="flex h-10 shrink-0 items-center gap-2 border-b bg-background px-3">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            cancelled.current = true;
            setTitle(deck.title);
            e.currentTarget.blur();
          }
        }}
        title={deck.path}
        aria-label="Deck title"
        className="min-w-0 max-w-md flex-1 truncate rounded-md bg-transparent px-1.5 py-1 text-sm font-medium outline-none hover:bg-accent focus:bg-accent"
      />
      <div className="flex-1" />
      <FindButton />
      <SlideSizeButton />
      <LintStatus />
      <ViewToggle file={basename(deck.id)} />
      <ExportMenu
        disabled={deck.slides.length === 0 || exporting}
        busy={exporting}
        progress={videoProgress}
        shownSlides={deck.slides.filter((s) => !s.hidden).length}
        onHtml={() => void exportDeck()}
        onPdf={() => void exportPdf()}
        onImages={() => void exportImages()}
        onVideo={(options) => void exportVideo(options)}
      />
      {videoProgress !== null && (
        <button
          type="button"
          aria-label="Cancel video export"
          title="Cancel video export"
          onClick={() => void api.cancelVideoExport()}
          className="-ml-1 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      <button
        type="button"
        disabled={deck.slides.length === 0}
        onClick={() => useApp.getState().setPresenting(true)}
        className="flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-40"
      >
        <Play className="size-3.5 fill-current" />
        Present
      </button>
    </div>
  );
}

/**
 * The Export button and its choices: one shareable HTML file, a PDF, a PNG per slide, or a
 * video (which first asks how to make it).
 */
function ExportMenu(props: {
  disabled: boolean;
  busy: boolean;
  /** How much of a video export is done, 0–1, while one runs. */
  progress: number | null;
  shownSlides: number;
  onHtml: () => void;
  onPdf: () => void;
  onImages: () => void;
  onVideo: (options: VideoOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-40"
      >
        {props.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Share className="size-3.5" />}
        {props.progress !== null
          ? `Exporting ${Math.floor(props.progress * 100)}%`
          : props.busy
            ? "Exporting…"
            : "Export"}
        <ChevronDown className="size-3 text-muted-foreground" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border bg-card p-1 shadow-lg">
          <ExportItem
            icon={FileCode2}
            label="HTML file"
            hint="One self-contained file to share"
            onClick={choose(props.onHtml)}
          />
          <ExportItem
            icon={FileText}
            label="PDF"
            hint="One page per slide, for printing or sharing"
            onClick={choose(props.onPdf)}
          />
          <ExportItem
            icon={Images}
            label="PNG images"
            hint="One image per slide, in a new folder"
            onClick={choose(props.onImages)}
          />
          <ExportItem
            icon={Film}
            label="Video"
            hint="An MP4 with each slide shown for a set time"
            onClick={choose(() => setVideoOpen(true))}
          />
        </div>
      )}
      {videoOpen && (
        <Popover
          anchor={buttonRef}
          placement="below"
          width={300}
          label="Export video"
          onClose={() => setVideoOpen(false)}
        >
          <VideoExportPanel
            slides={props.shownSlides}
            onCancel={() => setVideoOpen(false)}
            onExport={(options) => {
              setVideoOpen(false);
              props.onVideo(options);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

function ExportItem(props: { icon: typeof Share; label: string; hint: string; onClick: () => void }) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex flex-col">
        <span className="text-xs font-medium">{props.label}</span>
        <span className="text-2xs text-muted-foreground">{props.hint}</span>
      </span>
    </button>
  );
}

const VIEWS: { id: StageView; label: string; title: (file: string) => string; icon: typeof Code2 }[] = [
  { id: "slides", label: "Slides", title: () => "Show the rendered slide", icon: Presentation },
  { id: "code", label: "HTML", title: (file) => `Show ${file}, scrolled to the selected slide`, icon: Code2 },
];

function ViewToggle({ file }: { file: string }) {
  const view = useApp((s) => s.view);
  const codeDirty = useApp((s) => s.codeDirty);
  return (
    <div className="flex items-center rounded-md border bg-muted p-0.5">
      {VIEWS.map(({ id, label, title, icon: Icon }) => (
        <button
          key={id}
          type="button"
          title={title(file)}
          aria-pressed={view === id}
          onClick={() => useApp.getState().setView(id)}
          className={cn(
            "flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground",
            view === id && "bg-background text-foreground shadow-sm ring-1 ring-border",
          )}
        >
          <Icon className="size-3.5" />
          {label}
          {id === "code" && codeDirty && <span title="Unsaved changes" className="size-1.5 rounded-full bg-primary" />}
        </button>
      ))}
    </div>
  );
}

/** Lint result for the deck file. When it has issues, clicking puts fix instructions in the chat. */
export function LintStatus() {
  const lint = useApp((s) => s.lint);
  const running = useApp((s) => s.running);
  const file = useApp((s) => basename(s.deck?.id ?? "") || "deck.html");

  if (lint === null) {
    return (
      <span
        title={`Checking ${file}…`}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" />
        Lint
      </span>
    );
  }

  const errors = lint.filter((i) => i.severity === "error").length;
  const warnings = lint.length - errors;
  if (lint.length === 0) {
    return (
      <button
        type="button"
        title={`${file} passes lint. Click to check again.`}
        onClick={() => void useApp.getState().refreshLint()}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-accent"
      >
        <CheckCircle2 className="size-3.5" />
        Lint OK
      </button>
    );
  }

  const Icon = errors > 0 ? XCircle : AlertTriangle;
  const summary = [
    errors > 0 && `${errors} ${errors === 1 ? "error" : "errors"}`,
    warnings > 0 && `${warnings} ${warnings === 1 ? "warning" : "warnings"}`,
  ]
    .filter(Boolean)
    .join(", ");
  const details = lint
    .slice(0, 8)
    .map((i) => `Line ${i.line}: ${i.message}`)
    .concat(lint.length > 8 ? [`…and ${lint.length - 8} more`] : [])
    .join("\n");
  return (
    <button
      type="button"
      disabled={running}
      title={`${details}\n\nClick to ask the agent to fix ${lint.length === 1 ? "it" : "them"}.`}
      onClick={() => useApp.getState().fillComposer(lintFixPrompt(lint, file))}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50",
        errors > 0 ? "text-destructive" : "text-amber-600",
      )}
    >
      <Icon className="size-3.5" />
      Lint: {summary}
    </button>
  );
}
