import { defaultKeymap } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { foldGutter, foldKeymap, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  drawSelection,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { FileCode2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { errorMessage } from "../lib/api";
import { findSlideSpans, type SlideSpan } from "../lib/slideSpans";
import { deckFileUrl, isMac } from "../lib/utils";
import { useApp } from "../store";

interface SlideMarks {
  spans: SlideSpan[];
  active: string | null;
}

const setSlideMarks = StateEffect.define<SlideMarks>();

/** Where the slides are in the document, and which one is selected. */
const slideMarks = StateField.define<SlideMarks>({
  create: () => ({ spans: [], active: null }),
  update: (value, tr) => {
    for (const effect of tr.effects) if (effect.is(setSlideMarks)) return effect.value;
    if (!tr.docChanged) return value;
    return {
      ...value,
      spans: value.spans.map((s) => ({
        ...s,
        from: tr.changes.mapPos(s.from),
        to: tr.changes.mapPos(s.to, -1),
      })),
    };
  },
});

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
  lineMarkerChange: (update) =>
    update.transactions.some((tr) => tr.effects.some((e) => e.is(setSlideMarks))),
  initialSpacer: () => new SlideNumberMarker("99", false),
});

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px", backgroundColor: "var(--background)", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--foreground)", paddingBottom: "40vh" },
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
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, #facc15 35%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, #f97316 45%, transparent)" },
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

const extensions: Extension[] = [
  lineNumbers(),
  slideGutter,
  foldGutter(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  drawSelection(),
  html(),
  syntaxHighlighting(classHighlighter),
  highlightSelectionMatches(),
  search({ top: true }),
  keymap.of([...searchKeymap, ...foldKeymap, ...defaultKeymap]),
  EditorState.readOnly.of(true),
  slideMarks,
  slideHighlight,
  theme,
];

/** deck.html's source, read-only, with the selected slide highlighted and kept in view. */
export function CodeView() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const revealRev = useApp((s) => s.revealRev);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The editor itself picked this slide (caret moved into it), so don't scroll to it. */
  const pickedInEditor = useRef<string | null>(null);
  /** Scroll the selected slide into view once its position is known. */
  const pendingReveal = useRef(true);

  const deckId = deck?.id;
  // Any change to the document's markup changes one of these hashes.
  const version = deck ? `${deck.shellHash}.${deck.slides.map((s) => s.hash).join(".")}` : "";

  useEffect(() => {
    if (!deckId) return;
    let cancelled = false;
    fetch(deckFileUrl(deckId, "deck.html", `v=${encodeURIComponent(version)}`), { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`Could not read deck.html (${res.status})`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setSource(text);
        setError(null);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [deckId, version]);

  const spans = useMemo(() => (source === null ? [] : findSlideSpans(source)), [source]);

  // Create the editor once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          extensions,
          EditorView.updateListener.of((update) => {
            if (!update.selectionSet || !update.transactions.some((tr) => tr.isUserEvent("select"))) return;
            const head = update.state.selection.main.head;
            const { spans: current, active } = update.state.field(slideMarks);
            const hit = current.find((s) => head >= s.from && head <= s.to);
            if (!hit || hit.id === active) return;
            pickedInEditor.current = hit.id;
            useApp.setState({ selected: hit.id });
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Swap in new source, replacing only the changed middle so scroll and caret stay put.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || source === null) return;
    const current = view.state.doc.toString();
    if (current === source) return;
    let start = 0;
    const max = Math.min(current.length, source.length);
    while (start < max && current.charCodeAt(start) === source.charCodeAt(start)) start++;
    let end = 0;
    while (
      end < max - start &&
      current.charCodeAt(current.length - 1 - end) === source.charCodeAt(source.length - 1 - end)
    )
      end++;
    view.dispatch({
      changes: { from: start, to: current.length - end, insert: source.slice(start, source.length - end) },
    });
  }, [source]);

  useEffect(() => {
    pendingReveal.current = true;
  }, [selected, revealRev]);

  // Highlight the selected slide, and scroll to it when the selection came from elsewhere.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || source === null) return;
    const span = spans.find((s) => s.id === selected);
    const effects: StateEffect<unknown>[] = [setSlideMarks.of({ spans, active: selected })];
    const fromEditor = pickedInEditor.current === selected;
    pickedInEditor.current = null;
    if (span && pendingReveal.current) {
      pendingReveal.current = false;
      if (!fromEditor) {
        effects.push(EditorView.scrollIntoView(span.from, { y: "start", yMargin: 48 }));
        view.dispatch({ effects, selection: { anchor: span.from } });
        return;
      }
    }
    view.dispatch({ effects });
  }, [spans, selected, revealRev, source]);

  if (!deck) return null;
  const index = spans.findIndex((s) => s.id === selected);
  const span = spans[index];
  const lines =
    span && source !== null
      ? [lineOf(source, span.from), lineOf(source, span.to)]
      : null;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <FileCode2 className="size-3.5" />
        <span className="font-medium text-foreground">deck.html</span>
        {span && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <span>
              Slide {index + 1} <span className="font-mono text-2xs">#{span.id.replace(/^#/, "")}</span>
            </span>
            {lines && (
              <span className="tabular-nums">
                lines {lines[0]}–{lines[1]}
              </span>
            )}
          </>
        )}
        <span className="ml-auto text-2xs">Read-only · {isMac ? "⌘F" : "Ctrl+F"} to search</span>
      </div>
      {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
      <div ref={hostRef} className="selectable min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < offset; i = text.indexOf("\n", i + 1)) line++;
  return line;
}
