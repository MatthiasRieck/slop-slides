import { ChevronDown, FileCode2, FileOutput, FileText, Film, Images, Loader2, Presentation, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useDropdown } from "../hooks/useDropdown";
import { useMenuKeys } from "../hooks/useMenuKeys";
import { type ExportFormat, FORMAT_NAMES, slidePercent, slideProgress, slideProgressShort } from "../lib/exportOptions";
import { basename } from "../lib/utils";
import { timeLeftText, videoPercent, videoPhase, videoPhaseShort, videoTimeLeft } from "../lib/video";
import { type ExportRun, openExportDialog, useExports, videoRunning } from "../store/exports";
import { Button, ToolButton } from "./Button";
import { MenuItem } from "./DeckActions";
import { canCancel, cancelExport } from "./export/run";
import { ExportDialog } from "./lazy";

/** The Export menu's choices, in its order, each with what it makes in a line. */
const ITEMS: { format: ExportFormat; icon: typeof FileText; label: string; hint: string }[] = [
  { format: "pdf", icon: FileText, label: "PDF…", hint: "A page per slide, to print or send" },
  { format: "pptx", icon: Presentation, label: "PowerPoint…", hint: "Editable slides; some effects simplified" },
  { format: "html", icon: FileCode2, label: "Web page (HTML)…", hint: "One file that plays in any browser" },
  { format: "images", icon: Images, label: "Images…", hint: "A PNG or JPEG of each slide" },
  { format: "video", icon: Film, label: "Video…", hint: "An MP4 with animations and narration" },
];

/** How far `run` has got, in a few words: "Slide 4 of 20", "Rendering video 42%", "Writing…". */
function runStatus(run: ExportRun, now: number): string {
  if (run.cancelling) return "Stopping…";
  if (run.format === "html") return "Writing…";
  if (run.format === "video") {
    if (!run.video) return "Starting…";
    const left = run.phaseStarted === undefined ? null : videoTimeLeft(run.video, now - run.phaseStarted);
    return left === null ? videoPhase(run.video) : `${videoPhase(run.video)}, ${timeLeftText(left)}`;
  }
  return slideProgress(run.done, run.total);
}

/** The same in the room of the Export button: "PDF 4/20", "Narration 2/4", "Video 42%". */
function runStatusShort(run: ExportRun): string {
  const name = FORMAT_NAMES[run.format];
  if (run.format === "video") {
    if (!run.video) return name;
    return run.video.phase === "narration" ? videoPhaseShort(run.video) : `Video ${videoPhaseShort(run.video)}`;
  }
  if (run.format === "html") return name;
  return `${name} ${slideProgressShort(run.done, run.total)}`;
}

const runPercent = (run: ExportRun) =>
  run.format === "video" ? (run.video ? videoPercent(run.video) : 0) : slidePercent(run.done, run.total);

/** The time now, again every second while `on`: what "about 2 min left" is worked out from. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** An export under way in the menu: what it writes, how far it has got, and Cancel. */
function RunRow({ run, now }: { run: ExportRun; now: number }) {
  const status = runStatus(run, now);
  return (
    <div className="flex flex-col gap-1 rounded-md px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={run.dest}>
          {FORMAT_NAMES[run.format]} · {basename(run.dest)}
        </span>
        {run.format !== "html" && (
          <ToolButton
            variant="panel"
            label={`Cancel the ${FORMAT_NAMES[run.format].toLowerCase()} export`}
            disabled={!canCancel(run)}
            onClick={() => void cancelExport(run)}
          >
            <X />
          </ToolButton>
        )}
      </div>
      <div role="status" className="text-2xs text-muted-foreground tabular-nums">
        {status}
      </div>
      <div
        role="progressbar"
        aria-label={`${FORMAT_NAMES[run.format]} export`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={runPercent(run)}
        aria-valuetext={status}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${runPercent(run)}%` }} />
      </div>
    </div>
  );
}

/**
 * The Export button and its menu: PDF, PowerPoint, web page, images and video, each opening the
 * export dialog for it. While exports run, the button says how far the latest has got (with a
 * spinner, whether the menu is open or not), and the menu lists each with Cancel above its
 * choices, which stay open to start another. One video is made at a time.
 */
export function ExportMenu(props: {
  /** Whether its name shows beside its icon, as long as the top bar has room for it. */
  label: boolean;
  /** Why nothing can be exported (the deck has no slide), if so. */
  disabledReason: string | null;
}) {
  const { open, setOpen, ref } = useDropdown();
  const menu = useMenuKeys();
  const runs = useExports((s) => s.runs);
  const video = useExports(videoRunning);
  const dialog = useExports((s) => s.dialog);
  const now = useNow(open && runs.some((run) => run.format === "video"));
  const latest = runs.at(-1);
  const status = !latest ? null : runs.length === 1 ? runStatusShort(latest) : `${runs.length} exports`;

  const choose = (format: ExportFormat) => () => {
    setOpen(false);
    openExportDialog(format);
  };

  return (
    <div ref={ref} className="relative">
      <Button
        size="xl"
        disabled={props.disabledReason !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={status ? `Export, ${status}` : "Export"}
        title={props.disabledReason ?? (status ? "Export: see how far it has got, or export again" : "Export")}
        onClick={() => setOpen((v) => !v)}
      >
        {latest ? <Loader2 className="size-3.5 animate-spin" /> : <FileOutput className="size-3.5" />}
        {status ? (
          <span data-testid="export-status" className="tabular-nums">
            {status}
          </span>
        ) : (
          props.label && <span>Export</span>
        )}
        <ChevronDown className="size-3 text-muted-foreground" />
      </Button>
      {open && (
        <div className="enter-below absolute right-0 top-full z-20 mt-1 w-72 rounded-lg border bg-card p-1 shadow-lg">
          {runs.length > 0 && (
            <section aria-label="Exports in progress" className="mb-1 border-b pb-1">
              {runs.map((run) => (
                <RunRow key={run.id} run={run} now={now} />
              ))}
            </section>
          )}
          <div role="menu" aria-label="Export as" {...menu} className="outline-none">
            {ITEMS.map((item) => (
              <MenuItem
                key={item.format}
                icon={item.icon}
                label={item.label}
                hint={item.format === "video" && video ? "A video is being exported; one at a time" : item.hint}
                onClick={choose(item.format)}
              />
            ))}
          </div>
        </div>
      )}
      {dialog && <ExportDialog />}
    </div>
  );
}
