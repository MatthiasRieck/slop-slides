import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, FileCode2, FileText, Film, Images, Loader2, Play, Share, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, type Deck, errorMessage, type Slide } from "../lib/api";
import { VIDEO_CANCELLED, type VideoOptions, type VideoProgress } from "../lib/video";
import { useApp } from "../store";
import { Popover } from "./Templates";
import { VideoExportPanel } from "./VideoExport";

/** Export and present, in the top bar next to the mode tabs. */
export function DeckActions() {
  const deck = useApp((s) => s.deck);
  if (!deck) return null;
  return <Actions deck={deck} />;
}

function Actions({ deck }: { deck: Deck }) {
  // An export the backend is still writing (printing a PDF takes a moment).
  const [exporting, setExporting] = useState(false);
  // How far a video export has got; null when none is running.
  const [videoProgress, setVideoProgress] = useState<VideoProgress | null>(null);

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
    setVideoProgress({ phase: "video", frame: 0, frames: 0 });
    const unlisten = await listen<VideoProgress>("video-export-progress", ({ payload }) => setVideoProgress(payload));
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
    <div className="flex items-center gap-2">
      <ExportMenu
        disabled={deck.slides.length === 0 || exporting}
        busy={exporting}
        progress={videoProgress}
        shownSlides={deck.slides.filter((s) => !s.hidden)}
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

/** What the Export button says while a video export runs. */
function progressLabel(progress: VideoProgress): string {
  if (progress.phase === "narration")
    return `Speaking ${Math.min(progress.frame + 1, progress.frames)}/${progress.frames}`;
  return `Exporting ${progress.frames > 0 ? Math.floor((progress.frame / progress.frames) * 100) : 0}%`;
}

/**
 * The Export button and its choices: one shareable HTML file, a PDF, a PNG per slide, or a
 * video (which first asks how to make it).
 */
function ExportMenu(props: {
  disabled: boolean;
  busy: boolean;
  /** How far a video export has got, while one runs. */
  progress: VideoProgress | null;
  shownSlides: Slide[];
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
        {props.progress !== null ? progressLabel(props.progress) : props.busy ? "Exporting…" : "Export"}
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
