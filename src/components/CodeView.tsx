import { EditorState, Prec, type StateEffect, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { AlertTriangle, FileCode2, RotateCcw, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api, errorMessage } from "../lib/api";
import { onDiskRead } from "../lib/codeSync";
import { formatKeys } from "../lib/keys";
import { basename, cn } from "../lib/utils";
import { provideCodeSave, showError, useApp } from "../store";
import { Button } from "./Button";
import {
  fromDisk,
  replaceText,
  type SlideMarks,
  setActiveSlide,
  slideMarks,
  sourceExtensions,
} from "./code/sourceEditor";
import { useDeckFile } from "./code/useDeckFile";
import { Dialog } from "./Dialog";

/** The sidebar's HTML tab: the open deck's source, or a line saying there is no deck to show. */
export function CodePanel({ active }: { active: boolean }) {
  const hasDeck = useApp((s) => s.deck !== null);
  if (!hasDeck) return <p className="p-4 text-sm text-muted-foreground">Open a deck to see its HTML.</p>;
  return <CodeView active={active} />;
}

/** How long typing pauses before text as long as the saved one is compared with it (see `noteEdit`). */
export const DIRTY_CHECK_DELAY = 200;

/**
 * The deck file's source with the selected slide highlighted and kept in view. Edits are saved
 * with ⌘S; if the file changes on disk meanwhile (the agent), the user picks which wins. Revert
 * gives the unsaved edits up, once the user has said so.
 *
 * It stays mounted behind the other sidebar tabs, to keep its unsaved edits, and does nothing
 * the size of the file there: the file is read, and the selected slide followed, only while the
 * tab shows (`active`), catching up as it shows again.
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
  /** Asking whether to give up the unsaved edits, which Revert does. */
  const [reverting, setReverting] = useState(false);
  /** The disk text the editor's unedited state corresponds to. */
  const baseline = useRef("");
  /** The editor itself picked this slide (caret moved into it), so don't scroll to it. */
  const pickedInEditor = useRef<string | null>(null);
  /** Scroll the selected slide into view once its position is known. */
  const pendingReveal = useRef(true);
  const saveRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
  const dirtyCheck = useRef<ReturnType<typeof setTimeout>>(undefined);

  const setDirty = (isDirty: boolean) => {
    if (isDirty !== useApp.getState().codeDirty) useApp.getState().setCodeDirty(isDirty);
  };
  /**
   * The user changed the text to `doc`: it has unsaved edits. Comparing it with the saved text
   * reads the whole file, so no key does that: text of another length differs for sure, and text
   * of the same length (an edit undone, say) is compared once the typing pauses.
   */
  const noteEdit = (doc: Text) => {
    clearTimeout(dirtyCheck.current);
    setDirty(true);
    if (doc.length !== baseline.current.length) return;
    dirtyCheck.current = setTimeout(() => {
      const view = viewRef.current;
      if (view) setDirty(view.state.doc.toString() !== baseline.current);
    }, DIRTY_CHECK_DELAY);
  };
  const noteEditRef = useRef(noteEdit);
  noteEditRef.current = noteEdit;

  const deckId = deck?.id;
  const fileName = basename(deckId ?? "") || "deck.html";
  /** The deck file as last read from disk, and why it could not be. */
  const { source, error } = useDeckFile(deck, active);

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
            // Text from disk is the saved text; whoever loads it says what that makes of the edits.
            if (update.transactions.some((tr) => tr.docChanged && !tr.annotation(fromDisk))) {
              noteEditRef.current(update.state.doc);
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
      clearTimeout(dirtyCheck.current);
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
    clearTimeout(dirtyCheck.current);
    setDirty(false);
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
      clearTimeout(dirtyCheck.current);
      setDirty(view.state.doc.toString() !== text);
      useApp.getState().setDeck(next);
    } catch (err) {
      const message = errorMessage(err);
      if (message.includes("changed on disk")) setConflict(true);
      else showError(message);
    } finally {
      setSaving(false);
    }
  };

  // What leaves the deck (another file, closing the tab or the window) can save the edits first.
  useEffect(() => provideCodeSave(() => saveRef.current()), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: any of these changes asks for a fresh reveal
  useEffect(() => {
    pendingReveal.current = true;
  }, [selected, revealRev, active]);

  // Highlight the selected slide, and scroll to it when the selection came from elsewhere. Hidden,
  // the editor is left alone: it catches up with the selection as the tab shows again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revealRev forces a reveal of the same slide
  useEffect(() => {
    const view = viewRef.current;
    if (!view || source === null || !active) return;
    const effects: StateEffect<unknown>[] = [setActiveSlide.of(selected)];
    const span = view.state.field(slideMarks).spans.find((s) => s.id === selected);
    const fromEditor = pickedInEditor.current === selected;
    if (span && pendingReveal.current) {
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
          onClick={() => setReverting(true)}
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
      {reverting && (
        <Dialog
          label="Discard unsaved changes"
          closeOnBackdrop
          onClose={() => setReverting(false)}
          className="flex w-96 max-w-[90vw] flex-col gap-4 rounded-xl border bg-background p-5 text-foreground shadow-2xl outline-none"
          heading={
            <>
              <h2 className="text-base font-semibold">Discard your unsaved changes?</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                What you typed into {fileName} since it was last saved is lost; the file itself stays as it is.
              </p>
            </>
          }
        >
          <div className="flex justify-end gap-2">
            <Button variant="ghost" data-autofocus onClick={() => setReverting(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setReverting(false);
                if (source !== null) loadText(source);
              }}
            >
              Discard changes
            </Button>
          </div>
        </Dialog>
      )}
      {error && <p className="px-3 py-2 text-xs text-destructive">{error}</p>}
      <div ref={hostRef} className="selectable min-h-0 flex-1 overflow-hidden" />
    </div>
  );
}
