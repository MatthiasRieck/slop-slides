import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AppWindow,
  ChevronDown,
  FileCode2,
  FileText,
  Film,
  Images,
  Loader2,
  Play,
  Presentation,
  Share,
  X,
} from "lucide-react";
import { useRef, useState } from "react";

import { api, type Deck, errorMessage, type Screen, type Slide } from "../lib/api";
import { VIDEO_CANCELLED, type VideoOptions, type VideoProgress } from "../lib/video";
import { reportingErrors, showError, useApp } from "../store";
import { Button, ToolButton } from "./Button";
import { Popover, useDismiss } from "./Popover";
import { ScreenPicker } from "./ScreenPicker";
import { VideoExportPanel } from "./VideoExport";

/** The longest the screen picker waits for the screens to be captured before opening anyway. */
const PICKER_MAX_WAIT_MS = 150;

/** The files Export saves: what the save dialog offers, and what a failure says first. */
const EXPORT_FILES = {
  html: { title: "Export presentation", extension: "html", filter: "HTML presentation", failure: "" },
  pdf: { title: "Export as PDF", extension: "pdf", filter: "PDF document", failure: "Could not save the PDF: " },
  pptx: {
    title: "Export as PowerPoint",
    extension: "pptx",
    filter: "PowerPoint presentation",
    failure: "Could not save the PowerPoint file: ",
  },
  video: { title: "Export as video", extension: "mp4", filter: "MP4 video", failure: "Could not save the video: " },
};

type ExportKind = keyof typeof EXPORT_FILES;

/** Asks where to save the deck as `kind`, offering `name`; null when the user cancels. */
function askWhereToSave(kind: ExportKind, name: string) {
  const { title, extension, filter } = EXPORT_FILES[kind];
  return save({ title, defaultPath: `${name}.${extension}`, filters: [{ name: filter, extensions: [extension] }] });
}

/** Export (an icon until an export runs) and present, in the top bar next to the lint status. */
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
  const picker = useScreenPicker();

  const fileName = deck.title.replace(/[\\/:*?"<>|]+/g, "").trim() || "presentation";

  /** Saves the deck as `kind` where the user picks and shows the file; `busy` shows it running. */
  const exportFile = async (kind: ExportKind, write: (dest: string) => Promise<unknown>, busy: boolean) => {
    const dest = await askWhereToSave(kind, fileName);
    if (!dest) return;
    if (busy) setExporting(true);
    await reportingErrors(async () => {
      await write(dest);
      await revealItemInDir(dest);
    }, EXPORT_FILES[kind].failure);
    if (busy) setExporting(false);
  };

  const exportVideo = async (options: VideoOptions) => {
    const dest = await askWhereToSave("video", fileName);
    if (!dest) return;
    setExporting(true);
    setVideoProgress({ phase: "video", frame: 0, frames: 0 });
    const unlisten = await listen<VideoProgress>("video-export-progress", ({ payload }) => setVideoProgress(payload));
    try {
      await api.exportVideo(deck.id, dest, options);
      await revealItemInDir(dest);
    } catch (error) {
      const message = errorMessage(error);
      if (message !== VIDEO_CANCELLED) showError(message, EXPORT_FILES.video.failure);
    } finally {
      unlisten();
      setVideoProgress(null);
      setExporting(false);
    }
  };

  const exportImages = async () => {
    const parent = await open({ directory: true, title: "Choose where to save the slide images" });
    if (!parent || Array.isArray(parent)) return;
    await reportingErrors(async () =>
      useApp.getState().startImageExport(await api.createImageExportDir(deck.id, parent)),
    );
  };

  return (
    <div className="flex items-center gap-2">
      <ExportMenu
        disabled={deck.slides.length === 0 || exporting}
        busy={exporting}
        progress={videoProgress}
        shownSlides={deck.slides.filter((s) => !s.hidden)}
        onHtml={() => void exportFile("html", (dest) => api.exportDeck(deck.id, dest), false)}
        onPdf={() => void exportFile("pdf", (dest) => api.exportPdf(deck.id, dest), true)}
        onPptx={() => void exportFile("pptx", (dest) => api.exportPptx(deck.id, dest), true)}
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
      <PresentButton
        disabled={deck.slides.length === 0}
        onPresent={() => void picker.present()}
        onWindows={() => useApp.getState().setPresenting(true, "windows")}
      />
      {picker.screens && (
        <ScreenPicker
          screens={picker.screens}
          previews={picker.previews}
          onCancel={picker.close}
          onWindows={() => {
            picker.close();
            useApp.getState().setPresenting(true, "windows");
          }}
          onStart={(choice) => {
            picker.close();
            useApp.getState().setPresenting(true, choice);
          }}
        />
      )}
    </div>
  );
}

/** Presents, asking which screen to present on when there are several. */
function useScreenPicker() {
  // The attached screens while the picker is open.
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
  return { screens, previews, present, close: () => setScreens(null) };
}

/**
 * Present, with a menu beside it for presenting in windows: the slides in this window, to share
 * it in a call, and the presenter view in a window of its own. That works on a single screen.
 */
function PresentButton(props: { disabled: boolean; onPresent: () => void; onWindows: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(open, menuRef, () => setOpen(false), { escape: true });

  return (
    <div ref={menuRef} className="relative flex">
      <Button
        variant="primary"
        size="xl"
        disabled={props.disabled}
        onClick={props.onPresent}
        className="rounded-r-none shadow-sm"
      >
        <Play className="size-3.5 fill-current" />
        Present
      </Button>
      <Button
        variant="primary"
        size="xl"
        disabled={props.disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More ways to present"
        title="More ways to present"
        onClick={() => setOpen((v) => !v)}
        className="rounded-l-none border-l border-primary-foreground/20 px-1.5 shadow-sm"
      >
        <ChevronDown className="size-3" />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border bg-card p-1 shadow-lg">
          <MenuItem
            icon={AppWindow}
            label="Present in windows"
            hint="Slides in this window to share in a call; your notes in another"
            onClick={() => {
              setOpen(false);
              props.onWindows();
            }}
          />
        </div>
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
          <MenuItem
            icon={FileCode2}
            label="HTML file"
            hint="One self-contained file to share"
            onClick={choose(props.onHtml)}
          />
          <MenuItem
            icon={FileText}
            label="PDF"
            hint="One page per slide, for printing or sharing"
            onClick={choose(props.onPdf)}
          />
          <MenuItem
            icon={Presentation}
            label="PowerPoint"
            hint="Editable slides; some effects are simplified"
            onClick={choose(props.onPptx)}
          />
          <MenuItem
            icon={Images}
            label="PNG images"
            hint="One image per slide, in a new folder"
            onClick={choose(props.onImages)}
          />
          <MenuItem
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
          align="end"
          width={300}
          portal
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

/** One choice of a top bar menu: an icon, a label and, optionally, a hint under it. */
export function MenuItem(props: { icon: typeof Share; label: string; hint?: string; onClick: () => void }) {
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
        {props.hint && <span className="text-2xs text-muted-foreground">{props.hint}</span>}
      </span>
    </button>
  );
}
