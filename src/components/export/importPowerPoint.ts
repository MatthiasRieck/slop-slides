// Importing a PowerPoint file as a new deck, from wherever it starts (the start screen's button or
// a drop on it, the Files menu, the file viewer): how far it has got while it runs ("Reading
// slide 4 of 20"), then a report of what came along otherwise, by slide, that stays on hand
// while the deck it made is open.
import { listen } from "@tauri-apps/api/event";

import type { ImportedPptx, ImportProgress } from "../../lib/api";
import { missingFonts } from "../../lib/fonts";
import { basename, plural } from "../../lib/utils";
import { showInfo, showSuccess, useApp } from "../../store";
import { type ImportReport, useExports } from "../../store/exports";

/** The report of `imported`, made from the PowerPoint file `file`: the fonts it names that this computer lacks among its changes. */
export function importReport(imported: ImportedPptx, file: string, lacking = missingFonts): ImportReport {
  const absent = new Set(lacking(imported.fonts.map((font) => font.name)));
  return {
    deckId: imported.deck.id,
    title: imported.deck.title,
    file: basename(file),
    slides: imported.deck.slides.length,
    changes: imported.changes,
    missingFonts: imported.fonts.filter((font) => absent.has(font.name)),
  };
}

/** How many things the report has to tell. */
export const reportCount = (report: ImportReport) => report.changes.length + (report.missingFonts.length > 0 ? 1 : 0);

/**
 * Imports the PowerPoint file at `path` and opens the deck it makes, showing which slide it is
 * reading meanwhile. When something did not come along as it was, the report opens; otherwise
 * a toast says it is done. One import runs at a time; false when it did not import.
 */
export async function importPowerPoint(path: string): Promise<boolean> {
  if (useExports.getState().importing) return false;
  const file = basename(path);
  // Shown from the first slide read: the unsaved-changes question before it stays in view.
  const stop = await listen<ImportProgress>("pptx-import-progress", ({ payload }) =>
    useExports.setState({ importing: { file, slide: payload.slide, slides: payload.slides } }),
  );
  let imported: ImportedPptx | null = null;
  try {
    imported = await useApp.getState().importPptx(path);
  } finally {
    stop();
    useExports.setState({ importing: null });
  }
  if (!imported) return false;
  const report = importReport(imported, path);
  if (reportCount(report) > 0) {
    useExports.setState({ report, reportOpen: true });
  } else {
    useExports.setState({ report: null, reportOpen: false });
    showSuccess(`Imported ${file}: ${plural(report.slides, "slide")}, everything as it was.`);
  }
  return true;
}

/** Shows the last import's report again, while the deck it made is open. */
export function openImportReport(): void {
  const { report } = useExports.getState();
  if (!report) return;
  if (useApp.getState().deck?.id === report.deckId) useExports.setState({ reportOpen: true });
  else showInfo(`The import report went with ${report.title}: it is there while that deck is open.`);
}

/** Closes the report, with a toast that brings it back while its deck stays open. */
export function closeImportReport(): void {
  const { report } = useExports.getState();
  useExports.setState({ reportOpen: false });
  if (!report) return;
  showInfo(`${report.title}: ${plural(reportCount(report), "thing")} to check against ${report.file}.`, {
    label: "View import report",
    run: openImportReport,
  });
}
