import { EditorState, Prec, type StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { AlertTriangle, FileCode2, RotateCcw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, errorMessage } from "../lib/api";
import { onDiskRead } from "../lib/codeSync";
import { formatKeys } from "../lib/keys";
import { basename, cn } from "../lib/utils";
import { showError, useApp } from "../store";
import { Button } from "./Button";
import { replaceText, type SlideMarks, setActiveSlide, slideMarks, sourceExtensions } from "./code/sourceEditor";
import { useDeckFile } from "./code/useDeckFile";

/** The sidebar's HTML tab: the open deck's source, or a line saying there is no deck to show. */
export function CodePanel({ active }: { active: boolean }) {
  const hasDeck = useApp((s) => s.deck !== null);
  if (!hasDeck) return <p className="p-4 text-sm text-muted-foreground">Open a deck to see its HTML.</p>;
  return <CodeView active={active} />;
}

/**
 * The deck file's source with the selected slide highlighted and kept in view. Edits are saved
 * with ⌘S; if the file changes on disk meanwhile (the agent), the user picks which wins.
 */
export function CodeView({ active }: { active: boolean }) {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const revealRev = useApp((s) => s.revealRev);
  const dirty = useApp((s) => s.codeDirty);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [marks, setMarks] = useState<SlideMarks>({ spans: [], active: null });
  /** The deck file changed on disk while the editor held unsaved edits. */
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
  const fileName = basename(deckId ?? "") || "deck.html";
  /** The deck file as last read from disk, and why it could not be. */
  const { source, error } = useDeckFile(deck);

  // Create the editor once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          sourceExtensions,
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

  // Follow the deck file on disk, unless that would throw away unsaved edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new disk read should reload the editor
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
      else showError(message);
    } finally {
      setSaving(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: any of these changes asks for a fresh reveal
  useEffect(() => {
    pendingReveal.current = true;
  }, [selected, revealRev, active]);

  // Highlight the selected slide, and scroll to it when the selection came from elsewhere.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revealRev forces a reveal of the same slide
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

  return (
    <div className={cn("@container h-full flex-col bg-background", active ? "flex" : "hidden")}>
      {/* The sidebar can be narrow: the details go first, the file's name and the buttons stay. */}
      <div className="flex h-9 shrink-0 items-center gap-2 whitespace-nowrap border-b px-3 text-xs text-muted-foreground">
        <FileCode2 className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium text-foreground">{fileName}</span>
        {dirty && <span title="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-primary" />}
        {span && (
          <>
            <span className="hidden text-muted-foreground/40 @md:inline">·</span>
            <span className="hidden min-w-0 truncate @md:inline">
              Slide {index + 1} <span className="font-mono text-2xs">#{span.id.replace(/^#/, "")}</span>
            </span>
            {lines && (
              <span className="hidden tabular-nums @xl:inline">
                lines {lines[0]}–{lines[1]}
              </span>
            )}
          </>
        )}
        <span className="ml-auto hidden text-2xs @2xl:inline">
          {formatKeys("mod+f")} search · {formatKeys("mod+s")} save
        </span>
        <span className="ml-auto @2xl:hidden" />
        <Button
          variant="ghost"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => source !== null && loadText(source)}
          title="Discard unsaved changes"
        >
          <RotateCcw className="size-3.5" />
          Revert
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={!dirty || saving}
          onClick={() => saveRef.current()}
          title={`Save ${fileName} (${formatKeys("mod+s")})`}
          className="shadow-sm"
        >
          <Save className="size-3.5" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {conflict && (
        <div className="flex shrink-0 items-center gap-2 border-b bg-warning/10 px-3 py-1.5 text-xs">
          <AlertTriangle className="size-3.5 shrink-0 text-warning " />
          <span className="flex-1">{fileName} changed on disk while you were editing.</span>
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
