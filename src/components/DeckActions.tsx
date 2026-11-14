import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
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
  SkipBack,
  X,
} from "lucide-react";
import { useRef, useState } from "react";

import { useDropdown } from "../hooks/useDropdown";
import { useMenuKeys } from "../hooks/useMenuKeys";
import { api, type Deck, errorMessage, type Slide } from "../lib/api";
import { formatKeys } from "../lib/keys";
import { basename } from "../lib/utils";
import {
  VIDEO_CANCELLED,
  type VideoOptions,
  type VideoProgress,
  videoPercent,
  videoPhase,
  videoPhaseShort,
} from "../lib/video";
import { reportingErrors, showError, useApp } from "../store";
import { Button, withShortcut } from "./Button";
import { showSaved } from "./exportSaved";
import { VideoExportPanel } from "./lazy";
import { Popover } from "./Popover";
import { PRESENT_KEYS, usePresent } from "./presenter/present";
import { ScreenPicker } from "./ScreenPicker";

/** Why the deck can be neither exported nor presented while it has no slide. */
const EMPTY_DECK = "Add a slide first";

/** The files Export saves: what the save dialog offers, and what a failure says first. */
const EXPORT_FILES = {
  html: {
    title: "Export presentation",
    extension: "html",
    filter: "HTML presentation",
    failure: "Could not save the HTML file: ",
  },
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

/** A video export under way: the file it writes, and how far it has got. */
interface VideoRun {
  dest: string;
  progress: VideoProgress;
}

/** Export and present, in the top bar next to the lint status. */
export function DeckActions() {
  const deck = useApp((s) => s.deck);
  if (!deck) return null;
  return <Actions deck={deck} />;
}

function Actions({ deck }: { deck: Deck }) {
  // An export the backend is still writing (printing a PDF takes a moment).
  const [exporting, setExporting] = useState(false);
  // The video export running; null when none is.
  const [video, setVideo] = useState<VideoRun | null>(null);
  const picker = usePresent();

  const fileName = deck.title.replace(/[\\/:*?"<>|]+/g, "").trim() || "presentation";

  /**
   * Saves the deck as `kind` where the user picks, and says so once it is saved, with a way to
   * the file. Only a failure to write is reported as one.
   */
  const exportFile = async (kind: ExportKind, write: (dest: string) => Promise<unknown>) => {
    const dest = await askWhereToSave(kind, fileName);
    if (!dest) return;
    setExporting(true);
    const saved = await reportingErrors(async () => {
      await write(dest);
      return true;
    }, EXPORT_FILES[kind].failure);
    setExporting(false);
    if (saved) showSaved(dest);
  };

  const exportVideo = async (options: VideoOptions) => {
    const dest = await askWhereToSave("video", fileName);
    if (!dest) return;
    setExporting(true);
    setVideo({ dest, progress: { phase: "video", frame: 0, frames: 0 } });
    const unlisten = await listen<VideoProgress>("video-export-progress", ({ payload }) =>
      setVideo((run) => run && { ...run, progress: payload }),
    );
    try {
      await api.exportVideo(deck.id, dest, options);
      showSaved(dest);
    } catch (error) {
      const message = errorMessage(error);
      if (message !== VIDEO_CANCELLED) showError(message, EXPORT_FILES.video.failure);
    } finally {
      unlisten();
      setVideo(null);
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

  const empty = deck.slides.length === 0;
  return (
    <div className="flex items-center gap-2">
      <ExportMenu
        empty={empty}
        busy={exporting}
        video={video}
        shownSlides={deck.slides.filter((s) => !s.hidden)}
        onHtml={() => void exportFile("html", (dest) => api.exportDeck(deck.id, dest))}
        onPdf={() => void exportFile("pdf", (dest) => api.exportPdf(deck.id, dest))}
        onPptx={() => void exportFile("pptx", (dest) => api.exportPptx(deck.id, dest))}
        onImages={() => void exportImages()}
        onVideo={(options) => void exportVideo(options)}
      />
      <PresentButton empty={empty} />
      {picker.screens && (
        <ScreenPicker
          screens={picker.screens}
          previews={picker.previews}
          onCancel={picker.close}
          onWindows={() => picker.presentInWindows(picker.from)}
          onStart={picker.start}
        />
      )}
    </div>
  );
}

/**
 * Present, from the slide selected, with a menu beside it for the other ways to start: from the
 * first slide, and in windows (the slides in this window, to share it in a call, and the
 * presenter view in a window of its own, which works on a single screen). ⌘↵ and ⇧⌘↵ do the
 * first two from anywhere (see `usePresentKeys`).
 */
function PresentButton({ empty }: { empty: boolean }) {
  const { open, setOpen, ref: menuRef } = useDropdown();
  const menu = useMenuKeys();
  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const present = usePresent.getState();

  return (
    <div ref={menuRef} className="relative flex">
      <Button
        variant="primary"
        size="xl"
        disabled={empty}
        title={empty ? EMPTY_DECK : withShortcut("Present from the current slide", PRESENT_KEYS.current)}
        onClick={() => void present.present("current")}
        className="rounded-r-none shadow-sm"
      >
        <Play className="size-3.5 fill-current" />
        Present
      </Button>
      <Button
        variant="primary"
        size="xl"
        disabled={empty}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More ways to present"
        title={empty ? EMPTY_DECK : "More ways to present"}
        onClick={() => setOpen((v) => !v)}
        className="rounded-l-none border-l border-primary-foreground/20 px-1.5 shadow-sm"
      >
        <ChevronDown className="size-3" />
      </Button>
      {open && (
        <div
          role="menu"
          {...menu}
          className="enter-below absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border bg-card p-1 shadow-lg outline-none"
        >
          <MenuItem
            icon={SkipBack}
            label="From the beginning"
            shortcut={PRESENT_KEYS.start}
            onClick={choose(() => void present.present("start"))}
          />
          <MenuItem
            icon={Play}
            label="From current slide"
            shortcut={PRESENT_KEYS.current}
            onClick={choose(() => void present.present("current"))}
          />
          <MenuItem
            icon={AppWindow}
            label="Present in windows"
            hint="Slides in this window to share in a call; your notes in another"
            onClick={choose(() => present.presentInWindows("current"))}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The Export button and its choices: one shareable HTML file, a PDF, a PowerPoint file, a PNG
 * per slide, or a video (which first asks how to make it). Each choice goes on to ask where to
 * save, hence its ellipsis, and says what becomes of hidden slides. While a file is written the
 * button says so; while a video is, it shows how far that has got, and pressing it opens the
 * details with a way to cancel (see `VideoProgressPanel`).
 */
function ExportMenu(props: {
  /** The deck has no slide to export. */
  empty: boolean;
  busy: boolean;
  /** The video export running, if one is. */
  video: VideoRun | null;
  shownSlides: Slide[];
  onHtml: () => void;
  onPdf: () => void;
  onPptx: () => void;
  onImages: () => void;
  onVideo: (options: VideoOptions) => void;
}) {
  const { open, setOpen, ref: menuRef } = useDropdown();
  const menu = useMenuKeys();
  const [videoOpen, setVideoOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { video } = props;
  const status = video ? videoPhaseShort(video.progress) : props.busy ? "Exporting…" : null;
  if (!video && progressOpen) setProgressOpen(false);

  const choose = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div ref={menuRef} className="relative">
      <Button
        ref={buttonRef}
        size="xl"
        // Writing a file, it only waits; recording a video, it opens how far that has got.
        disabled={props.empty || (props.busy && !video)}
        aria-haspopup={video ? "dialog" : "menu"}
        aria-expanded={video ? progressOpen : open}
        aria-label={video ? `Exporting video: ${videoPhase(video.progress)}` : status ? undefined : "Export"}
        title={props.empty ? EMPTY_DECK : video ? "Show the video export's progress" : status ? undefined : "Export"}
        onClick={() => (video ? setProgressOpen((v) => !v) : setOpen((v) => !v))}
      >
        {props.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Share className="size-3.5" />}
        {/* Idle, its name shows where the window is wide enough for it. */}
        {status ? <span className="tabular-nums">{status}</span> : <span className="hidden xl:inline">Export</span>}
        <ChevronDown className="size-3 text-muted-foreground" />
      </Button>
      {open && !video && (
        <div
          role="menu"
          {...menu}
          className="enter-below absolute right-0 top-full z-20 mt-1 w-72 rounded-lg border bg-card p-1 shadow-lg outline-none"
        >
          <MenuItem
            icon={FileCode2}
            label="HTML file…"
            hint="One self-contained file to share. Hidden slides stay in it; the show skips them"
            onClick={choose(props.onHtml)}
          />
          <MenuItem
            icon={FileText}
            label="PDF…"
            hint="One page per slide, for printing or sharing. Hidden slides are left out"
            onClick={choose(props.onPdf)}
          />
          <MenuItem
            icon={Presentation}
            label="PowerPoint…"
            hint="Editable slides; some effects are simplified. Hidden slides are left out"
            onClick={choose(props.onPptx)}
          />
          <MenuItem
            icon={Images}
            label="PNG images…"
            hint="One image per slide, in a new folder. Hidden slides are included"
            onClick={choose(props.onImages)}
          />
          <MenuItem
            icon={Film}
            label="Video…"
            hint="An MP4 that plays the animations and speaks the narration. Hidden slides are left out"
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
      {video && progressOpen && (
        <Popover
          anchor={buttonRef}
          placement="below"
          align="end"
          width={280}
          portal
          label="Video export"
          onClose={() => setProgressOpen(false)}
        >
          <VideoProgressPanel run={video} />
        </Popover>
      )}
    </div>
  );
}

/** A video export under way: the file it writes, what it is doing, how far along, and a way to cancel it. */
function VideoProgressPanel({ run }: { run: VideoRun }) {
  const percent = videoPercent(run.progress);
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <div className="truncate text-sm font-medium" title={run.dest}>
        {basename(run.dest)}
      </div>
      <div role="status" className="text-muted-foreground tabular-nums">
        {videoPhase(run.progress)}
      </div>
      <div
        role="progressbar"
        aria-label="Video export"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={videoPhase(run.progress)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <div className="flex justify-end">
        <Button size="lg" data-autofocus onClick={() => void api.cancelVideoExport()}>
          <X />
          Cancel export
        </Button>
      </div>
    </div>
  );
}

/**
 * One choice of a top bar menu: an icon, a label and, optionally, a hint under it and the keys
 * that do the same (`shortcut`, a `formatKeys` spec) at its end.
 */
export function MenuItem(props: {
  icon: typeof Share;
  label: string;
  hint?: string;
  shortcut?: string;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium">{props.label}</span>
        {props.hint && <span className="text-2xs text-muted-foreground">{props.hint}</span>}
      </span>
      {props.shortcut && (
        <kbd className="shrink-0 font-sans text-2xs text-muted-foreground tabular-nums">
          {formatKeys(props.shortcut)}
        </kbd>
      )}
    </button>
  );
}
