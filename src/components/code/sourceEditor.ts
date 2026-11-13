import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Annotation, type Extension, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  GutterMarker,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";

import { changedRange } from "../../lib/codeSync";
import { findSlideSpans, type SlideSpan } from "../../lib/slideSpans";

export interface SlideMarks {
  /**
   * Slides of the document as currently edited. While the user types they move along with the
   * text, and are found again once the typing pauses (see `REFIND_DELAY`).
   */
  spans: SlideSpan[];
  active: string | null;
}

/** Tells the editor which slide is selected. */
export const setActiveSlide = StateEffect.define<string | null>();

/** Marks a change as the deck file's text from disk, not the user's typing. */
export const fromDisk = Annotation.define<boolean>();

/** How long typing pauses before the slides are found again in the whole document. */
export const REFIND_DELAY = 150;

/** Has the slides found again in the document as it is now. */
const refindSlides = StateEffect.define<null>();

/** Where the slides are in the document, and which one is selected. */
export const slideMarks = StateField.define<SlideMarks>({
  create: (state) => ({ spans: findSlideSpans(state.doc.toString()), active: null }),
  update: (value, tr) => {
    let next = value;
    const refind = tr.effects.some((effect) => effect.is(refindSlides));
    // Finding the slides reads the whole document: done for text from disk and once typing
    // pauses, not for every key, which only moves the slides found before.
    if (refind || (tr.docChanged && tr.annotation(fromDisk))) {
      next = { ...next, spans: findSlideSpans(tr.newDoc.toString()) };
    } else if (tr.docChanged) {
      const moved = (span: SlideSpan) => {
        const from = tr.changes.mapPos(span.from, 1);
        return { ...span, from, to: Math.max(from, tr.changes.mapPos(span.to, -1)) };
      };
      next = { ...next, spans: next.spans.map(moved) };
    }
    for (const effect of tr.effects) if (effect.is(setActiveSlide)) next = { ...next, active: effect.value };
    return next;
  },
});

/** Finds the slides again once the user's typing has paused for `REFIND_DELAY`. */
const refindAfterTyping = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (!update.transactions.some((tr) => tr.docChanged && !tr.annotation(fromDisk))) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.view.dispatch({ effects: refindSlides.of(null) }), REFIND_DELAY);
    }

    destroy() {
      clearTimeout(this.timer);
    }
  },
);

const activeLine = Decoration.line({ class: "cm-slide-line" });
const activeFirstLine = Decoration.line({ class: "cm-slide-line cm-slide-first" });
const activeLastLine = Decoration.line({ class: "cm-slide-line cm-slide-last" });

/** Tints every line of the selected slide's `<section>`. */
const slideHighlight = EditorView.decorations.compute([slideMarks], (state): DecorationSet => {
  const { spans, active } = state.field(slideMarks);
  const span = spans.find((s) => s.id === active);
  if (!span) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const first = state.doc.lineAt(span.from).number;
  const last = state.doc.lineAt(Math.max(span.from, span.to)).number;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    builder.add(line.from, line.from, n === first ? activeFirstLine : n === last ? activeLastLine : activeLine);
  }
  return builder.finish();
});

class SlideNumberMarker extends GutterMarker {
  constructor(
    readonly label: string,
    readonly active: boolean,
  ) {
    super();
  }
  eq(other: SlideNumberMarker) {
    return other.label === this.label && other.active === this.active;
  }
  toDOM() {
    const el = document.createElement("span");
    el.textContent = this.label;
    el.className = this.active ? "cm-slide-number cm-slide-number-active" : "cm-slide-number";
    return el;
  }
}

/** Slide numbers next to each slide's opening tag. */
const slideGutter = gutter({
  class: "cm-slide-gutter",
  markers: (view) => {
    const { spans, active } = view.state.field(slideMarks);
    const builder = new RangeSetBuilder<GutterMarker>();
    spans.forEach((s, index) => {
      const line = view.state.doc.lineAt(s.from);
      builder.add(line.from, line.from, new SlideNumberMarker(String(index + 1), s.id === active));
    });
    return builder.finish();
  },
  lineMarkerChange: (update) => update.startState.field(slideMarks) !== update.state.field(slideMarks),
  initialSpacer: () => new SlideNumberMarker("99", false),
});

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--foreground)", paddingBottom: "40vh" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--primary) 18%, transparent)",
    outline: "1px solid color-mix(in srgb, var(--primary) 40%, transparent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    overflow: "hidden",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--primary)",
    color: "var(--primary-foreground)",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { paddingLeft: "12px", minWidth: "36px", opacity: "0.6" },
  ".cm-activeLine": { backgroundColor: "var(--accent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--primary) 22%, transparent) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--primary) 14%, transparent)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--search) 35%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--search-active) 45%, transparent)" },
  ".cm-slide-line": {
    backgroundColor: "color-mix(in srgb, var(--primary) 7%, transparent)",
    boxShadow: "inset 2px 0 0 var(--primary)",
  },
  ".cm-slide-line.cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--primary) 12%, transparent)" },
  ".cm-slide-gutter .cm-gutterElement": { padding: "0 6px 0 8px", display: "flex", alignItems: "center" },
  ".cm-slide-number": {
    fontSize: "10px",
    fontWeight: "600",
    lineHeight: "16px",
    minWidth: "18px",
    padding: "0 4px",
    textAlign: "center",
    borderRadius: "4px",
    backgroundColor: "var(--accent)",
    color: "var(--muted-foreground)",
  },
  ".cm-slide-number-active": { backgroundColor: "var(--primary)", color: "var(--primary-foreground)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--muted-foreground)", padding: "0 4px" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--accent)", border: "none", color: "var(--muted-foreground)" },
  ".cm-panels": { backgroundColor: "var(--sidebar)", color: "var(--foreground)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": { fontFamily: "var(--font-sans)", fontSize: "12px", padding: "6px 8px" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontSize: "12px" },
  ".cm-textfield": {
    backgroundColor: "var(--background)",
    border: "1px solid var(--input)",
    borderRadius: "6px",
    padding: "2px 6px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--background)",
    border: "1px solid var(--input)",
    borderRadius: "6px",
  },
});

/** The deck file's editor: HTML with the slides numbered in the gutter and the selected one tinted. */
export const sourceExtensions: Extension[] = [
  lineNumbers(),
  slideGutter,
  foldGutter(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  drawSelection(),
  history(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  html(),
  syntaxHighlighting(classHighlighter),
  highlightSelectionMatches(),
  search({ top: true }),
  keymap.of([
    ...closeBracketsKeymap,
    ...completionKeymap,
    ...searchKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...defaultKeymap,
    indentWithTab,
  ]),
  slideMarks,
  refindAfterTyping,
  slideHighlight,
  theme,
];

/** Replaces only the changed middle of the document so scroll and caret stay put. */
export function replaceText(view: EditorView, next: string) {
  const changes = changedRange(view.state.doc.toString(), next);
  if (!changes) return;
  view.dispatch({
    changes,
    // Disk updates are not the user's edits; undo should not step back through them.
    annotations: [Transaction.addToHistory.of(false), fromDisk.of(true)],
  });
}
