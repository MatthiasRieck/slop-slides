import { Lock, LockOpen, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ArrangeMessage } from "../lib/arrange";
import {
  defaultsFrom,
  type EditStyle,
  type EditTool,
  familyOf,
  familyOfKind,
  type ListKind,
  type StackOrder,
} from "../lib/editTools";
import type { Stroke } from "../lib/ink";
import { pixelsOf } from "../lib/slideSize";
import { deckMode, editingSlide, searchHighlight, useApp } from "../store";
import { Button } from "./Button";
import { AreaDrawer, CommentEditor, CommentPins, useSlideComments } from "./Comments";
import { EditContextMenu, type EditMenuAction } from "./EditContextMenu";
import { EditToolbar } from "./EditToolbar";
import { FindBar, useDeckSearch, useFindShortcut } from "./FindReplace";
import { useAnnotations } from "./PresenterTools";
import { DiscardButton } from "./stage/DiscardButton";
import { toolMessage } from "./stage/editKeys";
import { slideReport, useEditorMenu, useSlideReport } from "./stage/editorState";
import { useFrameMessages } from "./stage/messages";
import { StageArea, StageInk } from "./stage/StageArea";
import { StageFooter } from "./stage/StageFooter";
import { usePasteboard } from "./stage/usePasteboard";
import { useSlideEditing } from "./stage/useSlideEditing";
import { useSketchKeyboard, useSlideKeyboard } from "./stage/useSlideKeyboard";
import { TimelineTools } from "./TimelineTools";
import { ViewToolbar } from "./ViewToolbar";

/**
 * The current slide, fit to the available space with letterboxing, between the tools of the
 * deck's mode and the row under the slide.
 *
 * It renders when the deck, the slide shown, the mode or a tool changes. What changes many times
 * a second is not its state, and is read by just what shows it: the slide editor's reports (see
 * stage/editorState.ts), the pasteboard's view (stage/stageView.ts) and the size of the area
 * (stage/StageArea.tsx). The callbacks it hands its toolbars stay the same, so those render
 * only for what they show.
 */
export function Stage() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const sketches = useApp((s) => s.sketches);
  const reviewVisible = useApp((s) => s.reviewVisible);
  // The editor is at work on the slide: Edit mode, and the slide is not locked.
  const editing = useApp(editingSlide);
  const mode = useApp(deckMode);
  const editTool = useApp((s) => s.editTool);
  const editStyles = useApp((s) => s.editStyles);
  const annotations = useAnnotations(selected ?? "", {
    ink: reviewVisible ? sketches : NO_INK,
    setInk: useApp.getState().setSketches,
  });
  const areaRef = useRef<HTMLDivElement>(null);
  const messages = useFrameMessages(areaRef);
  const pasteboard = usePasteboard(messages);
  const editor = useSlideEditing(areaRef, messages, pasteboard.resetView);
  const postToEditor = editor.post;
  // Comments are written in View, and stay on show while the slide is edited.
  const reviewShown = (mode === "view" || mode === "edit") && reviewVisible;
  const inkRef = useRef<HTMLDivElement>(null);
  const commentPins = useSlideComments(areaRef, messages, postToEditor, reviewShown, inkRef);
  const pinAnchor = useRef<HTMLButtonElement>(null);
  const setCommenting = commentPins.setCommenting;
  const setDrawingArea = commentPins.setDrawingArea;
  const drawingArea = commentPins.drawingArea;
  const canvas = pixelsOf(deck);

  useSlideKeyboard();
  // The search is the stage's in View and in Edit; View's ribbon and Edit's bar are where it shows.
  useFindShortcut();
  useDeckSearch();
  useSketchKeyboard(annotations.tool !== "pointer" || commentPins.commenting || drawingArea, () => {
    annotations.setTool("pointer");
    setCommenting(false);
    setDrawingArea(false);
  });

  // Picking a pen shows the review marks, so the new ones are not drawn blind.
  useEffect(() => {
    if (annotations.tool !== "pointer") useApp.getState().setReviewVisible(true);
  }, [annotations.tool]);
  // The sketch and comment tools are View mode's: leaving it puts them away.
  const putToolAway = annotations.setTool;
  useEffect(() => {
    if (mode === "view") return;
    putToolAway("pointer");
    setCommenting(false);
    setDrawingArea(false);
  }, [mode, putToolAway, setCommenting, setDrawingArea]);
  // The editor in the preview adds what the toolbar's tool says, styled like its defaults.
  useEffect(() => {
    if (editing) postToEditor(toolMessage(editTool, editStyles));
  }, [editing, editTool, editStyles, postToEditor]);
  // The preview marks what the toolbar's search finds on this slide.
  const highlight = useApp(useShallow(searchHighlight));
  useEffect(() => {
    postToEditor({ type: "slop:search", ...highlight });
  }, [highlight, postToEditor]);

  // What the edit tools do, the same functions for as long as the stage is there.
  const editTools = useMemo(
    () => ({
      onTool: (tool: EditTool) => useApp.getState().setEditTool(tool),
      onStyle: (changes: EditStyle) => {
        const { selection } = slideReport();
        // Restyling also sets how the next one of its kind looks; styling a few words does not.
        const family = selection ? familyOfKind(selection.kind) : familyOf(useApp.getState().editTool);
        if (family && !selection?.editing) useApp.getState().setEditStyle(family, defaultsFrom(changes));
        if (selection) postToEditor({ type: "slop:edit-style", style: changes });
      },
      onList: (list: ListKind) => postToEditor({ type: "slop:edit-list", list }),
      onLink: (href: string | null) => postToEditor({ type: "slop:edit-link", href }),
      onBackground: (color: string | null) => postToEditor({ type: "slop:edit-background", color }),
      onOrder: (to: StackOrder) => postToEditor({ type: "slop:edit-order", to }),
      onArrange: (message: ArrangeMessage) => postToEditor(message),
    }),
    [postToEditor],
  );

  const index = deck?.slides.findIndex((s) => s.id === selected) ?? -1;
  const slide = deck?.slides[index];
  const locked = !!slide?.locked;

  if (!deck) return null;

  return (
    <div className="flex h-full flex-col bg-canvas">
      {slide && editing && (
        <ModeBar>
          <EditToolbar
            tool={editTool}
            styles={editStyles}
            {...editTools}
            onSizeMode={editor.setSizeMode}
            onKeepRatio={editor.setKeepRatio}
            onPickImage={editor.pickImage}
            onInsertAsk={editor.askForInsert}
            onReturnFocus={editor.focus}
            onDelete={editor.deleteSelection}
          />
        </ModeBar>
      )}
      {slide && mode === "edit" && locked && (
        <ModeBar>
          <LockedNote slide={slide.id} />
          {/* The timeline is Edit mode's on a locked slide too, to play the deck and time the others. */}
          <TimelineTools collapsed={false} />
        </ModeBar>
      )}
      {slide && mode === "view" && (
        <ModeBar>
          <ViewToolbar
            annotations={annotations}
            commenting={commentPins.commenting}
            onCommenting={commentPins.setCommenting}
            drawingArea={drawingArea}
            onDrawingArea={setDrawingArea}
            areaShape={commentPins.areaShape}
            onAreaShape={commentPins.setAreaShape}
          />
        </ModeBar>
      )}
      <StageArea
        areaRef={areaRef}
        deckId={deck.id}
        slide={slide}
        size={canvas}
        editing={editing}
        inkRef={inkRef}
        onFrameReady={(frame) => {
          pasteboard.onFrameReady(frame);
          editor.onFrameReady(frame);
          commentPins.onFrameReady();
          const search = searchHighlight(useApp.getState());
          if (search.query) postToEditor({ type: "slop:search", ...search });
        }}
        ink={
          <>
            <StageInk annotations={annotations} />
            <CommentPins pins={commentPins} inking={annotations.tool !== "pointer" || drawingArea} anchor={pinAnchor} />
            {drawingArea && (
              <AreaDrawer shape={commentPins.areaShape} onArea={(area) => void commentPins.commentOnArea(area)} />
            )}
          </>
        }
      >
        {!slide && <EmptyStage />}
        {slide && editing && <DiscardButton />}
        {mode === "edit" && <FindBar />}
        {commentPins.open && (
          <CommentEditor
            key={commentPins.open.key}
            comment={commentPins.open}
            anchor={pinAnchor}
            keepOpen={commentPins.keepOpen}
            onClose={commentPins.close}
          />
        )}
      </StageArea>
      <EditorMenu onAction={editor.runMenuAction} onClose={editor.closeMenu} />
      {deck.slides.length > 0 && (
        <StageFooter
          index={index}
          count={deck.slides.length}
          slide={slide}
          onResetView={pasteboard.resetView}
          onZoomBy={pasteboard.zoomBy}
          onZoomTo={pasteboard.zoomTo}
          onClearSelection={editor.clearSelection}
        />
      )}
    </div>
  );
}

/**
 * The menu a right-click in the slide editor opened, while it is open. It reads what the editor
 * reported of the selection for itself, so the stage does not render as the editor reports.
 */
function EditorMenu(props: { onAction: (action: EditMenuAction) => void; onClose: () => void }) {
  const menu = useEditorMenu();
  const running = useApp((s) => s.running);
  const canPasteStyle = useApp((s) => s.copiedStyle !== null);
  const flippable = useSlideReport((report) => !!report.selection?.flippable);
  const several = useSlideReport((report) => (report.geometry?.count ?? 0) > 1);
  const group = useSlideReport((report) => !!report.selection?.group);
  const locked = useSlideReport((report) => !!report.selection?.locked);
  if (!menu) return null;
  return (
    <EditContextMenu
      {...menu}
      canPasteStyle={canPasteStyle}
      running={running}
      flippable={flippable}
      several={several}
      group={group}
      locked={locked}
      onAction={props.onAction}
      onClose={props.onClose}
    />
  );
}

/** The stage's own tools row, for the modes that work on the slide it shows. */
function ModeBar({ children }: { children: ReactNode }) {
  return (
    <div className="relative z-20 flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b bg-background px-3 py-1 text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** Edit mode on a locked slide: why nothing on it can be changed, and the way to change that. */
function LockedNote({ slide }: { slide: string }) {
  const unlock = () => useApp.getState().setSlidesLocked([slide], false);
  return (
    <div role="status" className="flex flex-1 items-center gap-2 [&_svg]:size-3.5">
      <Lock />
      <span>This slide is locked: neither you nor the agent can change it.</span>
      <Button variant="ghost" size="sm" onClick={() => void unlock()}>
        <LockOpen />
        Unlock
      </Button>
    </div>
  );
}

/** What the stage shows before the deck has slides. */
function EmptyStage() {
  return (
    <div className="flex max-w-sm flex-col items-center gap-3 text-center">
      <div className="rounded-full bg-accent p-3 text-muted-foreground">
        <Sparkles className="size-5" />
      </div>
      <h2 className="text-base font-medium">Start with a conversation</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        Tell the agent what the presentation is about, who it is for, and how long it should be. Slides appear here as
        they are written.
      </p>
    </div>
  );
}

const NO_INK: Record<string, Stroke[]> = {};
