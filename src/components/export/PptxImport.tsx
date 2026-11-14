import { Loader2 } from "lucide-react";

import type { ConversionChange } from "../../lib/api";
import { plural } from "../../lib/utils";
import { useApp } from "../../store";
import { type ImportReport, useExports } from "../../store/exports";
import { Button } from "../Button";
import { Dialog, DialogActions } from "../Dialog";
import { closeImportReport, reportCount } from "./importPowerPoint";

/**
 * A PowerPoint import, wherever it was started: while it runs, which slide it is reading, over the
 * window; once done, the report of what did not come along as it was (see importPowerPoint.ts).
 */
export function PptxImport() {
  const importing = useExports((s) => s.importing);
  const report = useExports((s) => s.report);
  const reportOpen = useExports((s) => s.reportOpen);
  const deckId = useApp((s) => s.deck?.id);
  return (
    <>
      {importing && (
        // Nothing to close: the deck opens as soon as the last slide is read.
        <Dialog label={`Importing ${importing.file}`} size="sm" onClose={() => {}} closeKeys={[]}>
          <div className="flex items-center gap-3 text-sm">
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium">Importing {importing.file}</span>
              <span role="status" className="text-xs text-muted-foreground tabular-nums">
                Reading slide {importing.slide} of {importing.slides}
              </span>
            </div>
          </div>
          <div
            role="progressbar"
            aria-label="PowerPoint import"
            aria-valuemin={0}
            aria-valuemax={importing.slides}
            aria-valuenow={importing.slide}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${(100 * importing.slide) / Math.max(1, importing.slides)}%` }}
            />
          </div>
        </Dialog>
      )}
      {report && reportOpen && report.deckId === deckId && <ReportDialog report={report} />}
    </>
  );
}

/** Buttons that go to the slides a change is about, by their number; "Whole presentation" for none. */
function SlideLinks({ slides }: { slides: number[] }) {
  if (slides.length === 0) return <span className="text-muted-foreground">Whole presentation</span>;
  const go = (number: number) => {
    const { deck, select } = useApp.getState();
    const slide = deck?.slides[number - 1];
    if (!slide) return;
    select(slide.id);
    closeImportReport();
  };
  return (
    <span className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
      <span className="text-muted-foreground">{slides.length === 1 ? "Slide" : "Slides"}</span>
      {slides.map((number) => (
        <Button
          key={number}
          variant="ghost"
          size="xs"
          title={`Go to slide ${number}`}
          onClick={() => go(number)}
          className="font-medium text-primary tabular-nums"
        >
          {number}
        </Button>
      ))}
    </span>
  );
}

/** One thing to check: what changed, and where. */
function Change({ change }: { change: ConversionChange }) {
  const what = change.what.charAt(0).toUpperCase() + change.what.slice(1);
  return (
    <li className="flex flex-col gap-0.5 border-b py-2 last:border-b-0">
      <span>{what}</span>
      <span className="text-2xs">
        <SlideLinks slides={change.slides} />
      </span>
    </li>
  );
}

/**
 * What an import changed or left out, slide by slide, to check the deck against the PowerPoint
 * file: each entry with the slides it is about, a press on one going to that slide. Fonts the
 * file is set in that this computer lacks are among them: the deck shows another font there.
 */
function ReportDialog({ report }: { report: ImportReport }) {
  const fonts = report.missingFonts;
  const fontSlides = [...new Set(fonts.flatMap((f) => f.slides))].sort((a, b) => a - b);
  return (
    <Dialog
      label="Import report"
      size="md"
      title={`Imported ${report.file}`}
      description={`${plural(report.slides, "slide")} came in as “${report.title}”. ${plural(reportCount(report), "thing")} could not come along as ${reportCount(report) === 1 ? "it was" : "they were"}: check these slides against the original.`}
      onClose={closeImportReport}
      closeButton
    >
      <ul className="-mr-2 flex min-h-0 flex-col overflow-y-auto pr-2 text-xs">
        {report.changes.map((change) => (
          <Change key={change.what} change={change} />
        ))}
        {fonts.length > 0 && (
          <Change
            change={{
              what: `${fonts.length === 1 ? "A font is" : "Fonts are"} not on this computer, so another shows in ${fonts.length === 1 ? "its" : "their"} place: ${fonts.map((f) => f.name).join(", ")}`,
              slides: fontSlides,
            }}
          />
        )}
      </ul>
      <DialogActions>
        <Button variant="primary" size="lg" data-autofocus onClick={closeImportReport}>
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
