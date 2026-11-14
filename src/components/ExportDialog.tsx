import { useApp } from "../store";
import { closeExportDialog, useExports } from "../store/exports";
import { ImagesExportDialog, PdfExportDialog, PptxExportDialog, WebPageExportDialog } from "./export/FormatDialogs";
import { VideoExportDialog } from "./VideoExport";

/**
 * The export dialog of the format the Export menu picked (see `openExportDialog`): one shell for
 * every format, with which slides go in and the format's own options, then Save. Nothing while
 * none is open, or without a deck.
 */
export function ExportDialog() {
  const format = useExports((s) => s.dialog);
  const deck = useApp((s) => s.deck);
  if (!format || !deck) return null;
  const props = { deck, onClose: closeExportDialog };
  switch (format) {
    case "pdf":
      return <PdfExportDialog {...props} />;
    case "pptx":
      return <PptxExportDialog {...props} />;
    case "html":
      return <WebPageExportDialog {...props} />;
    case "images":
      return <ImagesExportDialog {...props} />;
    case "video":
      return <VideoExportDialog {...props} />;
  }
}
