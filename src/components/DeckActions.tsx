import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, FileCode2, FileText, Film, Images, Loader2, Play, Presentation, Share, X } from "lucide-react";
import { useRef, useState } from "react";

import { api, type Deck, errorMessage, type Screen, type Slide } from "../lib/api";
import { rememberChoice } from "../lib/screens";
import { VIDEO_CANCELLED, type VideoOptions, type VideoProgress } from "../lib/video";
import { useApp } from "../store";
import { Button, ToolButton } from "./Button";
import { Popover, useDismiss } from "./Popover";
import { ScreenPicker } from "./ScreenPicker";
import { VideoExportPanel } from "./VideoExport";

/** Export (an icon until an export runs) and present, in the top bar next to the lint status. */
/** The longest the screen picker waits for the screens to be captured before opening anyway. */
const PICKER_MAX_WAIT_MS = 150;

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
  // The attached screens while the picker is open (presenting with several of them).
  const [screens, setScreens] = useState<Screen[] | null>(null);
  // Their screenshots; null while they are being taken.
  const [previews, setPreviews] = useState<(string | null)[] | null>(null);

  const present = async () => {
    const attached = await api.listScreens().catch(() => []);
    if (attached.length <= 1) {
      useApp.getState().setPresenting(true);
      return;
    }
    // The picker opens as soon as the screens are captured, so that it isn't in the screenshots,
    // and they come in while it is open. It doesn't wait long for that: capturing can get stuck
    // on the system asking for permission. Only once, or it would come back after a cancel.
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      clearTimeout(timer);
      setScreens(attached);
    };
    const timer = setTimeout(open, PICKER_MAX_WAIT_MS);
    setPreviews(null);
    const taken = await api.screenPreviews(open).catch(() => []);
    open();
    setPreviews(taken);
  };

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

  const exportPptx = async () => {
    const dest = await save({
      title: "Export as PowerPoint",
      defaultPath: `${fileName}.pptx`,
      filters: [{ name: "PowerPoint presentation", extensions: ["pptx"] }],
    });
    if (!dest) return;
    setExporting(true);
    try {
      await api.exportPptx(deck.id, dest);
      await revealItemInDir(dest);
    } catch (error) {
      useApp.getState().setError(`Could not save the PowerPoint file: ${errorMessage(error)}`);
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
        onPptx={() => void exportPptx()}
        onImages={() => void exportImages()}
        onVideo={(options) => void exportVideo(options)}
      />
      {videoProgress !== null && (
        <ToolButton
          variant="panel"
          className="-ml-1"
          aria-label="Cancel video export"
          title="Cancel video export"
          onClick={() => void api.cancelVideoExport()}
        >
          <X className="size-3.5" />
        </ToolButton>
      )}
      <Button
        variant="primary"
        size="xl"
        disabled={deck.slides.length === 0}
        onClick={() => void present()}
        className="shadow-sm"
      >
        <Play className="size-3.5 fill-current" />
        Present
      </Button>
      {screens && (
        <ScreenPicker
          screens={screens}
          previews={previews}
          onCancel={() => setScreens(null)}
          onStart={(choice) => {
            rememberChoice(screens, choice);
            setScreens(null);
            useApp.getState().setPresenting(true, choice);
          }}
        />
      )}
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
 * The Export button and its choices: one shareable HTML file, a PDF, a PowerPoint file, a PNG
 * per slide, or a video (which first asks how to make it).
 */
function ExportMenu(props: {
  disabled: boolean;
  busy: boolean;
  /** How far a video export has got, while one runs. */
  progress: VideoProgress | null;
  shownSlides: Slide[];
  onHtml: () => void;
  onPdf: () => void;
  onPptx: () => void;
  onImages: () => void;
  onVideo: (options: VideoOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useDismiss(open, menuRef, () => setOpen(false), { escape: true });
  const label = props.progress !== null ? progressLabel(props.progress) : props.busy ? "Exporting…" : null;

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={menuRef} className="relative">
      <Button
        ref={buttonRef}
        size="xl"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        // Idle, it is only an icon; while exporting it says how far it has got.
        aria-label={label ? undefined : "Export"}
        title={label ? undefined : "Export"}
        onClick={() => setOpen((v) => !v)}
      >
        {props.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Share className="size-3.5" />}
        {label}
        <ChevronDown className="size-3 text-muted-foreground" />
      </Button>
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
            icon={Presentation}
            label="PowerPoint"
            hint="Editable slides; some effects are simplified"
            onClick={choose(props.onPptx)}
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
