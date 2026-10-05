import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import {
  EditorState,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
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
import { AlertTriangle, FileCode2, RotateCcw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, errorMessage } from "../lib/api";
import { changedRange, normalizeNewlines, onDiskRead } from "../lib/codeSync";
import { findSlideSpans, type SlideSpan } from "../lib/slideSpans";
import { cn, deckFileUrl, isMac } from "../lib/utils";
import { useApp } from "../store";

interface SlideMarks {
  /** Slides of the document as currently edited, re-found on every change. */
  spans: SlideSpan[];
  active: string | null;
}

const setActiveSlide = StateEffect.define<string | null>();

/** Where the slides are in the document, and which one is selected. */
const slideMarks = StateField.define<SlideMarks>({
  create: (state) => ({ spans: findSlideSpans(state.doc.toString()), active: null }),
  update: (value, tr) => {
    let next = value;
    if (tr.docChanged) next = { ...next, spans: findSlideSpans(tr.newDoc.toString()) };
    for (const effect of tr.effects) if (effect.is(setActiveSlide)) next = { ...next, active: effect.value };
    return next;
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
  slideHighlight,
  theme,
];

/**
 * deck.html's source with the selected slide highlighted and kept in view. Edits are saved
 * with ⌘S; if the file changes on disk meanwhile (the agent), the user picks which wins.
 */
export function CodeView({ active }: { active: boolean }) {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const revealRev = useApp((s) => s.revealRev);
  const dirty = useApp((s) => s.codeDirty);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** deck.html as last read from disk. */
  const [source, setSource] = useState<string | null>(null);
  const [marks, setMarks] = useState<SlideMarks>({ spans: [], active: null });
  const [error, setError] = useState<string | null>(null);
  /** deck.html changed on disk while the editor held unsaved edits. */
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  /** The disk text the editor's unedited state corresponds to. */
  const baseline = useRef("");
  /** The editor itself picked this slide (caret moved into it), so don't scroll to it. */
  const pickedInEditor = useRef<string | null>(null);
  /** Scroll the selected slide into view once its position is known. */
  const pendingReveal = useRef(true);
  const saveRef = useRef<(force?: boolean) => void>(() => {});

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
        setSource(normalizeNewlines(text));
        setError(null);
      })
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [deckId, version]);

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
          Prec.highest(
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  saveRef.current();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((update) => {
            const marksNow = update.state.field(slideMarks);
            if (marksNow !== update.startState.field(slideMarks)) setMarks(marksNow);
            if (update.docChanged) {
              const isDirty = update.state.doc.toString() !== baseline.current;
              if (isDirty !== useApp.getState().codeDirty) useApp.getState().setCodeDirty(isDirty);
            }
            if (!update.selectionSet || !update.transactions.some((tr) => tr.isUserEvent("select"))) return;
            const head = update.state.selection.main.head;
            const hit = marksNow.spans.find((s) => head >= s.from && head <= s.to);
            if (!hit || hit.id === marksNow.active) return;
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
      useApp.getState().setCodeDirty(false);
    };
  }, []);

  /** Replaces the editor's text with disk text and marks it clean. */
  const loadText = (text: string) => {
    const view = viewRef.current;
    if (!view) return;
    baseline.current = text;
    setConflict(false);
    replaceText(view, text);
    useApp.getState().setCodeDirty(false);
  };

  // Follow deck.html on disk, unless that would throw away unsaved edits.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || source === null) return;
    const action = onDiskRead({ doc: view.state.doc.toString(), baseline: baseline.current, disk: source });
    if (action === "load") loadText(source);
    else if (action === "conflict") setConflict(true);
  }, [source]);

  saveRef.current = async (force = false) => {
    const view = viewRef.current;
    if (!view || !deckId || saving) return;
    const text = view.state.doc.toString();
    if (text === baseline.current && !force) return;
    setSaving(true);
    try {
      const next = await api.saveDeckSource(deckId, text, force ? null : baseline.current);
      baseline.current = text;
      setConflict(false);
      useApp.getState().setCodeDirty(view.state.doc.toString() !== text);
      useApp.getState().setDeck(next);
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("changed on disk")) setConflict(true);
      else useApp.getState().setError(message);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    pendingReveal.current = true;
  }, [selected, revealRev, active]);

  // Highlight the selected slide, and scroll to it when the selection came from elsewhere.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || source === null) return;
    const effects: StateEffect<unknown>[] = [setActiveSlide.of(selected)];
    const span = view.state.field(slideMarks).spans.find((s) => s.id === selected);
    const fromEditor = pickedInEditor.current === selected;
    if (span && active && pendingReveal.current) {
      pendingReveal.current = false;
      pickedInEditor.current = null;
      if (!fromEditor) {
        effects.push(EditorView.scrollIntoView(span.from, { y: "start", yMargin: 48 }));
        view.dispatch({ effects, selection: { anchor: span.from } });
        return;
      }
    }
    if (view.state.field(slideMarks).active !== selected) view.dispatch({ effects });
  }, [selected, revealRev, source, active]);

  if (!deck) return null;
  const index = marks.spans.findIndex((s) => s.id === marks.active);
  const span = marks.spans[index];
  const doc = viewRef.current?.state.doc;
  const lines = span && doc ? [doc.lineAt(span.from).number, doc.lineAt(span.to).number] : null;
  const mod = isMac ? "⌘" : "Ctrl+";

  return (
    <div className={cn("h-full flex-col bg-background", active ? "flex" : "hidden")}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <FileCode2 className="size-3.5" />
        <span className="font-medium text-foreground">deck.html</span>
        {dirty && <span title="Unsaved changes" className="size-1.5 rounded-full bg-primary" />}
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
        <span className="ml-auto text-2xs">
          {mod}F search · {mod}S save
        </span>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => source !== null && loadText(source)}
          title="Discard unsaved changes"
          className="flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <RotateCcw className="size-3.5" />
          Revert
        </button>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => saveRef.current()}
          title={`Save deck.html (${mod}S)`}
          className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground shadow-sm hover:opacity-90 disabled:opacity-40"
        >
          <Save className="size-3.5" />
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {conflict && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-amber-500/10 px-3 py-1.5 text-xs">
          <AlertTriangle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="flex-1">deck.html changed on disk while you were editing.</span>
          <button
            type="button"
            onClick={() => source !== null && loadText(source)}
            className="rounded-md border px-2 py-0.5 hover:bg-accent"
          >
            Load disk version
          </button>
          <button
            type="button"
            onClick={() => saveRef.current(true)}
            className="rounded-md border px-2 py-0.5 hover:bg-accent"
          >
            Overwrite with mine
          </button>
        </div>
      )}
      {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
      <div ref={hostRef} className="selectable min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}

/** Replaces only the changed middle of the document so scroll and caret stay put. */
function replaceText(view: EditorView, next: string) {
  const changes = changedRange(view.state.doc.toString(), next);
  if (!changes) return;
  view.dispatch({
    changes,
    // Disk updates are not the user's edits; undo should not step back through them.
    annotations: Transaction.addToHistory.of(false),
  });
}
