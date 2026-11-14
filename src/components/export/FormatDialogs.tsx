import type { Deck } from "../../lib/api";
import {
  imageOptions,
  pdfOptions,
  pixelSize,
  privateParts,
  slideCount,
  webPageOptions,
  webPageProblem,
} from "../../lib/exportOptions";
import { pixelsOf } from "../../lib/slideSize";
import { plural } from "../../lib/utils";
import { hasReview, useApp } from "../../store";
import { CheckboxRow } from "../Field";
import { ExportShell, Row, Segmented, useExportForm } from "./ExportShell";
import { type ExportRequest, startExport } from "./run";

/** What each format's dialog is given: the deck, and what to do once it is closed. */
interface DialogProps {
  deck: Deck;
  onClose: () => void;
}

/** Closes the dialog and starts the export `request` asks for. */
function go(props: DialogProps, request: ExportRequest) {
  props.onClose();
  void startExport(props.deck, request);
}

/** A PDF: a page per slide, and, if asked, a page of speaker notes after each slide that has them. */
export function PdfExportDialog(props: DialogProps) {
  const form = useExportForm("pdf", props.deck);
  const { slides, scope } = form.chosen;
  const withNotes = slides.filter((s) => (s.notes ?? "").trim() !== "").length;
  const notes = form.choices.notes && withNotes > 0;
  return (
    <ExportShell
      form={form}
      summary={`${plural(slides.length, "page")} of slides${notes ? `, and ${plural(withNotes, "page")} of notes` : ""}, with text that can be selected and searched.`}
      problem={null}
      saveLabel="Save PDF…"
      onSave={() => go(props, { format: "pdf", options: pdfOptions(scope, form.choices) })}
      onClose={props.onClose}
    >
      <Row label="Layout">
        <CheckboxRow
          title="Speaker notes"
          description={
            withNotes === 0
              ? "None of these slides has speaker notes."
              : `A page with the notes after each slide that has them (${withNotes} of ${slides.length}).`
          }
          checked={form.choices.notes}
          onChange={(value) => form.change({ notes: value })}
        />
      </Row>
    </ExportShell>
  );
}

/** A PowerPoint file of editable slides; what it cannot keep is told once it is saved. */
export function PptxExportDialog(props: DialogProps) {
  const form = useExportForm("pptx", props.deck);
  const { slides, scope } = form.chosen;
  return (
    <ExportShell
      form={form}
      summary={`${slideCount(slides)} as editable PowerPoint slides, with their speaker notes.`}
      note="Effects PowerPoint cannot draw become pictures, and animations and narration audio stay behind. Once it is saved you can see what changed, slide by slide."
      problem={null}
      saveLabel="Save PowerPoint file…"
      onSave={() => go(props, { format: "pptx", scope })}
      onClose={props.onClose}
    />
  );
}

/**
 * One web page that plays in any browser, with its images inside. What the author keeps to
 * themselves (speaker notes, narration scripts, review marks and comments) stays out unless ticked.
 */
export function WebPageExportDialog(props: DialogProps) {
  const form = useExportForm("html", props.deck);
  const { slides, scope } = form.chosen;
  const reviewed = useApp(hasReview);
  const parts = privateParts(slides);
  const { notes, narration, review } = form.choices;
  const left = [
    !notes && parts.notes > 0 && "speaker notes",
    !narration && parts.narration > 0 && "narration scripts",
    !review && reviewed && "review marks and comments",
  ].filter((part): part is string => !!part);
  const leftText =
    left.length === 0
      ? ""
      : ` Without ${left.length === 1 ? left[0] : `${left.slice(0, -1).join(", ")} or ${left.at(-1)}`}.`;
  return (
    <ExportShell
      form={form}
      summary={`${slideCount(slides)} in one file that plays in any browser, its images inside.${leftText}`}
      note="Narration audio is not included: export a video to share the deck with its narration."
      problem={webPageProblem(slides)}
      saveLabel="Save web page…"
      onSave={() => go(props, { format: "html", options: webPageOptions(scope, form.choices) })}
      onClose={props.onClose}
    >
      <Row label="Also include">
        <CheckboxRow
          title="Speaker notes"
          description={
            parts.notes === 0 ? "None of these slides has notes." : "Anyone with the file can read them in its source."
          }
          checked={notes}
          onChange={(value) => form.change({ notes: value })}
        />
        <CheckboxRow
          title="Narration scripts"
          description={
            parts.narration === 0 ? "None of these slides has narration." : "The text only; the page has no audio."
          }
          checked={narration}
          onChange={(value) => form.change({ narration: value })}
        />
        <CheckboxRow
          title="Review marks and comments"
          description={reviewed ? "Shown when R is pressed in the page." : "This deck has none."}
          checked={review}
          onChange={(value) => form.change({ review: value })}
        />
      </Row>
    </ExportShell>
  );
}

/** An image of each slide: PNG or JPEG, at the slides' size or twice it. */
export function ImagesExportDialog(props: DialogProps) {
  const form = useExportForm("images", props.deck);
  const { slides, scope } = form.chosen;
  const { imageFormat, imageScale } = form.choices;
  const canvas = pixelsOf(props.deck);
  const kind = imageFormat === "png" ? "PNG" : "JPEG";
  const size = pixelSize(canvas.width, canvas.height, imageScale);
  const one = slides.length === 1 && scope.slides?.length === 1;
  return (
    <ExportShell
      form={form}
      summary={
        one
          ? `One ${kind} image, ${size}.`
          : `${plural(slides.length, `${kind} image`)}, ${size}, in a new folder named after the deck.`
      }
      problem={null}
      saveLabel={one ? "Save image…" : "Save images…"}
      onSave={() => go(props, { format: "images", options: imageOptions(scope, form.choices) })}
      onClose={props.onClose}
    >
      <Row label="Format">
        <Segmented
          label="Image format"
          name="export-image-format"
          options={["png", "jpeg"] as const}
          labels={(value) => (value === "png" ? "PNG" : "JPEG")}
          value={imageFormat}
          onChange={(value) => form.change({ imageFormat: value })}
        />
        <span className="text-2xs text-muted-foreground">
          {imageFormat === "png" ? "Sharp text, larger files." : "Smaller files, for mail and the web."}
        </span>
      </Row>
      <Row label="Size">
        <Segmented
          label="Image size"
          name="export-image-scale"
          options={[1, 2] as const}
          labels={(value) => `${value}× · ${pixelSize(canvas.width, canvas.height, value).replace(" px", "")}`}
          value={imageScale}
          onChange={(value) => form.change({ imageScale: value })}
        />
      </Row>
    </ExportShell>
  );
}
