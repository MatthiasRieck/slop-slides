import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  AppWindow,
  ChevronDown,
  FileCode2,
  FileText,
  Film,
  Images,
  Play,
  Presentation,
  Share,
  SkipBack,
  X,
} from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { api, type Deck, errorMessage, type PptxSlides, type Slide } from "../lib/api";
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
import { showSaved } from "./exportSaved";
import { VideoExportPanel } from "./lazy";
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
        onPptx={(slides) => void exportFile("pptx", (dest) => api.exportPptx(deck.id, dest, slides))}
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
  const present = usePresent.getState();
  return (
    <ButtonGroup aria-label="Present" className="gap-px">
      <Button
        size="sm"
        disabled={empty}
        tooltip={empty ? EMPTY_DECK : "Present from the current slide"}
        {...(!empty && { shortcut: PRESENT_KEYS.current })}
        tooltipSide="bottom"
        onClick={() => void present.present("current")}
      >
        <Play className="fill-current" data-icon="inline-start" />
        Present
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={empty}
          render={
            <Button
              size="icon-sm"
              disabled={empty}
              aria-label="More ways to present"
              tooltip={empty ? EMPTY_DECK : "More ways to present"}
              tooltipSide="bottom"
              className="w-6"
            />
          }
        >
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <MenuItem
            icon={SkipBack}
            label="From the beginning"
            shortcut={PRESENT_KEYS.start}
            onClick={() => void present.present("start")}
          />
          <MenuItem
            icon={Play}
            label="From current slide"
            shortcut={PRESENT_KEYS.current}
            onClick={() => void present.present("current")}
          />
          <MenuItem
            icon={AppWindow}
            label="Present in windows"
            hint="Slides in this window to share in a call; your notes in another"
            onClick={() => present.presentInWindows("current")}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
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
  /** As editable elements, or with every slide one picture. */
  onPptx: (slides: PptxSlides) => void;
  onImages: () => void;
  onVideo: (options: VideoOptions) => void;
}) {
  const [videoOpen, setVideoOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { video } = props;
  const status = video ? videoPhaseShort(video.progress) : props.busy ? "Exporting…" : null;
  if (!video && progressOpen) setProgressOpen(false);

  // Writing a file, it only waits; recording a video, it opens how far that has got.
  const disabled = props.empty || (props.busy && !video);
  const name = video ? `Exporting video: ${videoPhase(video.progress)}` : status ? null : "Export";
  const tooltip = props.empty
    ? EMPTY_DECK
    : video
      ? "Show the video export's progress"
      : status
        ? undefined
        : "Export the deck";
  const button = (
    <Button
      ref={buttonRef}
      variant="outline"
      size="sm"
      disabled={disabled}
      {...(name && { "aria-label": name })}
      tooltip={tooltip}
      tooltipSide="bottom"
    />
  );
  const face = (
    <>
      {props.busy ? (
        <Spinner aria-hidden="true" data-icon="inline-start" className="size-3.5" />
      ) : (
        <Share data-icon="inline-start" />
      )}
      {/* Idle, its name shows where the window is wide enough for it. */}
      {status ? <span className="tabular-nums">{status}</span> : <span className="hidden xl:inline">Export</span>}
      <ChevronDown data-icon="inline-end" className="size-3 text-muted-foreground" />
    </>
  );

  if (video) {
    return (
      <Popover open={progressOpen} onOpenChange={setProgressOpen}>
        <PopoverTrigger render={button}>{face}</PopoverTrigger>
        <PopoverContent align="end" aria-label="Video export" initialFocus={cancelRef} className="w-[280px] gap-0 p-0">
          <VideoProgressPanel run={video} cancelRef={cancelRef} />
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger disabled={disabled} render={button}>
          {face}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <MenuItem
            icon={FileCode2}
            label="HTML file…"
            hint="One self-contained file to share. Hidden slides stay in it; the show skips them"
            onClick={props.onHtml}
          />
          <MenuItem
            icon={FileText}
            label="PDF…"
            hint="One page per slide, for printing or sharing. Hidden slides are left out"
            onClick={props.onPdf}
          />
          <MenuItem
            icon={Presentation}
            label="PowerPoint…"
            hint="Editable slides; some effects are simplified, and text needs its fonts installed. Hidden slides are left out"
            onClick={() => props.onPptx("elements")}
          />
          <MenuItem
            icon={Presentation}
            label="PowerPoint, as pictures…"
            hint="Every slide one picture: looks the same everywhere, but cannot be edited. Hidden slides are left out"
            onClick={() => props.onPptx("pictures")}
          />
          <MenuItem
            icon={Images}
            label="PNG images…"
            hint="One image per slide, in a new folder. Hidden slides are included"
            onClick={props.onImages}
          />
          <MenuItem
            icon={Film}
            label="Video…"
            hint="An MP4 that plays the animations and speaks the narration. Hidden slides are left out"
            onClick={() => setVideoOpen(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {videoOpen && (
        <Popover open onOpenChange={(open) => !open && setVideoOpen(false)}>
          <PopoverContent anchor={buttonRef} align="end" aria-label="Export video" className="w-[300px] gap-0 p-0">
            <VideoExportPanel
              slides={props.shownSlides}
              onCancel={() => setVideoOpen(false)}
              onExport={(options) => {
                setVideoOpen(false);
                props.onVideo(options);
              }}
            />
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}

/** A video export under way: the file it writes, what it is doing, how far along, and a way to cancel it. */
function VideoProgressPanel({ run, cancelRef }: { run: VideoRun; cancelRef: React.Ref<HTMLButtonElement> }) {
  const percent = videoPercent(run.progress);
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <div className="truncate text-sm font-medium" title={run.dest}>
        {basename(run.dest)}
      </div>
      <div role="status" className="text-muted-foreground tabular-nums">
        {videoPhase(run.progress)}
      </div>
      <Progress
        value={percent}
        aria-label="Video export"
        getAriaValueText={() => videoPhase(run.progress)}
        className="[&_[data-slot=progress-track]]:h-1.5"
      />
      <div className="flex justify-end">
        <Button ref={cancelRef} variant="outline" size="xs" onClick={() => void api.cancelVideoExport()}>
          <X data-icon="inline-start" />
          Cancel export
        </Button>
      </div>
    </div>
  );
}

/**
 * One choice of a menu of the shell (the top bar's, the file tree's): an icon, a label and,
 * optionally, a hint under it and the keys that do the same (`shortcut`, a `formatKeys` spec) at
 * its end. For use inside a `DropdownMenuContent`.
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
    <DropdownMenuItem onClick={props.onClick} className="items-start gap-2.5 px-2 py-1.5">
      <Icon className="mt-0.5 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs font-medium">{props.label}</span>
        {props.hint && <span className="text-2xs text-muted-foreground">{props.hint}</span>}
      </span>
      {props.shortcut && (
        <DropdownMenuShortcut className="text-2xs tracking-normal tabular-nums">
          {formatKeys(props.shortcut)}
        </DropdownMenuShortcut>
      )}
    </DropdownMenuItem>
  );
}
