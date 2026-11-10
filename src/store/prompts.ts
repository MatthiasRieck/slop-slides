// What the app tells the agent: the context sent along with a message, and the requests it
// prepares in the composer.
import type { Deck, LintIssue, OpenedFile, TemplateSummary, WorkspaceInfo } from "../lib/api";
import { commentLine } from "../lib/comments";
import { pixelsOf } from "../lib/slideSize";
import { layoutLabel } from "../lib/utils";
import type { UserMessage } from "./messages";
import { workspaceName } from "./paths";

/** How much of an element's markup goes in the prompt; the agent can read the rest in the deck. */
const ELEMENT_MARKUP_KEPT = 4000;

export const TIDY_PROMPT =
  "Tidy up the layout of this slide. I edited it by hand: keep my text, the styles I picked and what I added, and keep things where I moved them, at the size and angle I gave them, but rebuild the layout cleanly and fix any overflow or clipping.";

export const tidyPrompt = (overflow: string[] = []) =>
  overflow.length
    ? `${TIDY_PROMPT}\n\nThe editor found overflow:\n${overflow.map((o) => `- ${o}`).join("\n")}`
    : TIDY_PROMPT;

export const TIDY_ELEMENT_PROMPT =
  "Give this element a proper place in the slide's layout. I added it by hand: keep its content and the styles I picked, keep it about where I put it, and replace the hand-edit markers and offsets with clean markup. Leave the rest of the slide as it is, moving other elements only as far as needed to make room.";

/** How a prompt names a template's layout: its readable name, the slide and file to read. */
const layoutRef = (template: TemplateSummary, slide: string, path: string) =>
  `the "${layoutLabel(slide)}" layout of the "${template.title}" template (slide \`${slide}\` in \`${path}\`)`;

export const stylePrompt = (template: TemplateSummary, path: string) =>
  `Restyle the whole deck in the "${template.title}" style. The template is at \`${path}\`: take over its design system (fonts, colors, styles, decorative elements) and rebuild every slide on its closest layout. Keep all content, slide ids, and sections, and set <meta name="slopslide-template" content="${template.id}">.`;

export const addLayoutPrompt = (template: TemplateSummary, slide: string, path: string, after: string | null) =>
  `Add a new slide ${after ? "after this one" : "at the end of the deck"} based on ${layoutRef(template, slide, path)}. Recreate the layout with this deck's design system and fill it with content that fits the deck.`;

export const changeLayoutPrompt = (template: TemplateSummary, slide: string, path: string) =>
  `Change the layout of this slide to ${layoutRef(template, slide, path)}. Only change the arrangement: keep this slide's id, its content, and its style (this deck's fonts, colors, and decorative elements), and do not take over the template's style.`;

/** Chat instructions asking the agent to fix `issues` in the deck file `file` and verify with its lint tool. */
export function lintFixPrompt(issues: LintIssue[], file = "deck.html"): string {
  const lines = issues.map(
    (i) => `- line ${i.line} ${i.severity} [${i.rule}]${i.slide ? ` (slide \`${i.slide}\`)` : ""}: ${i.message}`,
  );
  return [
    `${file} does not pass the HTML lint. Fix these issues without changing how the slides look:`,
    "",
    ...lines,
    "",
    "Then run the lint_deck tool to verify, and repeat until it reports no issues.",
  ].join("\n");
}

/** A chat message, shortened and quoted, for telling the agent about it. */
export function quoteLabel(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return `"${line.length > 80 ? `${line.slice(0, 80).trimEnd()}…` : line}"`;
}

/** `prompt`, telling the agent first about the turns whose deck changes the user undid. */
export function withRevertNotes(notes: { label: string }[], prompt: string): string {
  if (notes.length === 0) return prompt;
  const which = notes.map((n) => n.label).join(", ");
  const turns = notes.length === 1 ? "your turn for the message" : "your turns for the messages";
  return `[note]The user undid the changes ${turns} ${which} made to the deck; the files are back to how they were before. Read them again before changing them.[/note]\n\n${prompt}`;
}

/** What the agent is told when the user takes the chat back to before their message `label` (see `quoteLabel`). */
export const rewindNote = (label: string) =>
  `[note]The user took the conversation back to before their message ${label}: your replies from there on are gone, and the changes you made to the files in those turns were undone. Disregard them, and read the files again before changing them.[/note]`;

/** Where a message is sent from: the open file (and deck), and a copy of the deck's template. */
export interface PromptContext {
  workspace: WorkspaceInfo | null;
  deck: Deck | null;
  openedFile: OpenedFile | null;
  /** Path of a copy of the deck's template; null when the deck has none. */
  template: string | null;
}

/** The prompt for `message`: its text, after what the agent needs to know about it. */
export function buildPrompt(message: UserMessage, { workspace, deck, openedFile, template }: PromptContext): string {
  const file = openedFile?.path ?? (deck ? workspaceName(workspace, deck.id) : null);
  const kind = deck ? "deck" : openedFile?.kind === "webpage" ? "web page" : openedFile?.kind;
  const context: string[] = [file ? `Open file: ${file} (${kind})` : "No file open"];
  if (deck && message.slide) {
    const index = deck.slides.findIndex((s) => s.id === message.slide);
    context.push(
      `Current slide: <section id="${message.slide}"> in ${file} (slide ${index + 1} of ${deck.slides.length})`,
    );
    if (deck.slides[index]?.locked) {
      context.push("The current slide is locked (data-locked): do not change it.");
    }
  } else if (deck && deck.slides.length === 0) {
    context.push("The deck has no slides yet.");
  }
  if (message.attachments.length > 0) {
    context.push(`Attached files: ${message.attachments.join(", ")}`);
  }
  if (deck && message.comments?.length) {
    const size = pixelsOf(deck);
    const lines = message.comments.map((c) => commentLine(c, size, deck.slides.length));
    context.push(`Comments from the user on elements of the deck:\n${lines.join("\n")}`);
  }
  if (deck && message.sketch) {
    const { image, bounds } = message.sketch;
    if (image) {
      context.push(`Sketch: ${image} (screenshot of the current slide with the user's marks drawn on top)`);
    }
    const size = pixelsOf(deck);
    context.push(
      `Marked area: x ${bounds.left}–${bounds.right}, y ${bounds.top}–${bounds.bottom} of the ${size.width}×${size.height} slide`,
    );
  }
  if (message.screenshot) {
    const shown = message.element ? "with the selected element outlined" : "with the user's hand edits";
    context.push(`Screenshot: ${message.screenshot} (screenshot of the slide ${shown})`);
  }
  if (message.element) {
    const { path, markup } = message.element;
    const shortened = markup.length > ELEMENT_MARKUP_KEPT ? `${markup.slice(0, ELEMENT_MARKUP_KEPT)}…` : markup;
    context.push(`Selected element: ${path} (CSS selector)`, `Its markup: ${shortened}`);
  }
  if (template) {
    context.push(`Deck template: ${template} (copy of the deck's template, for its layouts)`);
  }
  return `[context]\n${context.join("\n")}\n[/context]\n\n${message.text}`;
}
