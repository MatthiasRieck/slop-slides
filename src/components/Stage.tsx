import { Lock, LockOpen, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useContentSize } from "../hooks/useContentSize";
import { api } from "../lib/api";
import { defaultsFrom, type EditStyle, familyOf, familyOfKind } from "../lib/editTools";
import type { Stroke } from "../lib/ink";
import { pixelsOf } from "../lib/slideSize";
import { deckMode, editingSlide, reportingErrors, SKETCH_TARGET_ATTR, searchHighlight, useApp } from "../store";
import { Button } from "./Button";
import { AreaDrawer, CommentEditor, CommentPins, useSlideComments } from "./Comments";
import { EditContextMenu } from "./EditContextMenu";
import { EditToolbar } from "./EditToolbar";
import { AnnotationLayer, useAnnotations } from "./PresenterTools";
import { ShortcutHelp } from "./ShortcutHelp";
import { CurrentSlide } from "./stage/CurrentSlide";
import { DiscardButton } from "./stage/DiscardButton";
import { toolMessage } from "./stage/editKeys";
import { StageFooter } from "./stage/StageFooter";
import { inkBox, usePasteboard } from "./stage/usePasteboard";
import { useSlideEditing } from "./stage/useSlideEditing";
import { useSketchKeyboard, useSlideKeyboard } from "./stage/useSlideKeyboard";
import { TimelineTools } from "./TimelineTools";
import { ViewToolbar } from "./ViewToolbar";

/** The stage area's padding (Tailwind p-8), which the pasteboard covers too. */
const AREA_PADDING = 32;

/** The current slide, fit to the available space with letterboxing. */
export function Stage() {
  const deck = useApp((s) => s.deck);
  const selected = useApp((s) => s.selected);
  const sketches = useApp((s) => s.sketches);
  const reviewVisible = useApp((s) => s.reviewVisible);
  // The editor is at work on the slide: Edit mode, and the slide is not locked.
  const editing = useApp(editingSlide);
  const mode = useApp(deckMode);
  const running = useApp((s) => s.running);
  const editTool = useApp((s) => s.editTool);
  const editStyles = useApp((s) => s.editStyles);
  const annotations = useAnnotations(selected ?? "", {
    ink: reviewVisible ? sketches : NO_INK,
    setInk: useApp.getState().setSketches,
  });
  const areaRef = useRef<HTMLDivElement>(null);
  const pasteboard = usePasteboard(areaRef);
  const editFrames = useSlideEditing(areaRef, pasteboard.resetView);
  const postToEditor = editFrames.post;
  // Comments are written in View, and stay on show while the slide is edited.
  const reviewShown = (mode === "view" || mode === "edit") && reviewVisible;
  const inkRef = useRef<HTMLDivElement>(null);
  const commentPins = useSlideComments(areaRef, postToEditor, reviewShown, inkRef);
  const pinAnchor = useRef<HTMLButtonElement>(null);
  const setCommenting = commentPins.setCommenting;
  const setDrawingArea = commentPins.setDrawingArea;
  const drawingArea = commentPins.drawingArea;
  const canvas = pixelsOf(deck);
  // The preview fills the whole area around the slide: an endless pasteboard to pan and zoom on.
  const inside = useContentSize(areaRef);
  const arena = inside
    ? { width: inside.width + 2 * AREA_PADDING, height: inside.height + 2 * AREA_PADDING }
    : undefined;
  // The slide as large as fits the area, in its own shape.
  const width = arena
    ? Math.max(
        0,
        Math.min(arena.width - 2 * AREA_PADDING, ((arena.height - 2 * AREA_PADDING) * canvas.width) / canvas.height),
      )
    : 0;

  useSlideKeyboard();
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
  const restyle = (changes: EditStyle) => {
    const selection = editFrames.selection;
    // Restyling also sets how the next one of its kind looks; styling a few words does not.
    const family = selection ? familyOfKind(selection.kind) : familyOf(editTool);
    if (family && !selection?.editing) useApp.getState().setEditStyle(family, defaultsFrom(changes));
    if (selection) postToEditor({ type: "slop:edit-style", style: changes });
  };

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
            selection={editFrames.selection}
            styles={editStyles}
            sizeMode={editFrames.sizeMode}
            onSizeMode={editFrames.setSizeMode}
            keepRatio={editFrames.keepRatio}
            onKeepRatio={editFrames.setKeepRatio}
            fonts={editFrames.fonts}
            colors={editFrames.colors}
            background={editFrames.background}
            slides={deck?.slides.map((s, i) => ({ id: s.id, label: `${i + 1}. ${s.id}` })) ?? []}
            onTool={(tool) => useApp.getState().setEditTool(tool)}
            onStyle={restyle}
            onList={(list) => postToEditor({ type: "slop:edit-list", list })}
            onLink={(href) => postToEditor({ type: "slop:edit-link", href })}
            onBackground={(color) => postToEditor({ type: "slop:edit-background", color })}
            onPickImage={editFrames.pickImage}
            onReturnFocus={editFrames.focus}
            onOrder={(to) => postToEditor({ type: "slop:edit-order", to })}
            onDelete={editFrames.deleteSelection}
            geometry={editFrames.geometry}
            layers={editFrames.layers}
            onArrange={postToEditor}
          />
        </ModeBar>
      )}
      {slide && mode === "edit" && locked && (
        <ModeBar>
          <LockedNote deck={deck.id} slide={slide.id} />
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
      {/* Clips the ink, which zooms past the slide along with the pasteboard, so it stays off the bar below. */}
      <div
        ref={areaRef}
        data-testid="stage-area"
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-8"
      >
        {slide ? (
          // The slide's frame (outline, shadow, the edit-mode ring) is drawn in the preview, so it
          // pans and zooms with the slide.
          <div
            style={{ width }}
            {...{ [SKETCH_TARGET_ATTR]: "" }}
            data-editing={editing || undefined}
            className="relative"
          >
            <CurrentSlide
              deckId={deck.id}
              slide={slide}
              size={canvas}
              editing={editing}
              arena={arena}
              canvas={areaRef}
              onFrameReady={(frame) => {
                pasteboard.onFrameReady(frame);
                editFrames.onFrameReady(frame);
                commentPins.onFrameReady();
                const search = searchHighlight(useApp.getState());
                if (search.query) postToEditor({ type: "slop:search", ...search });
              }}
            />
            {/* Ink sits on the slide, wherever the pasteboard has moved it. */}
            <div
              ref={inkRef}
              data-testid="annotation-view"
              className="pointer-events-none absolute"
              style={inkBox(pasteboard.current, width / canvas.width)}
            >
              <AnnotationLayer annotations={annotations} zoom={pasteboard.current?.k} />
              <CommentPins
                pins={commentPins}
                inking={annotations.tool !== "pointer" || drawingArea}
                anchor={pinAnchor}
              />
              {drawingArea && (
                <AreaDrawer shape={commentPins.areaShape} onArea={(area) => void commentPins.commentOnArea(area)} />
              )}
            </div>
          </div>
        ) : (
          <EmptyStage />
        )}
        {slide && editing && <DiscardButton />}
        {commentPins.open && (
          <CommentEditor
            key={commentPins.open.key}
            comment={commentPins.open}
            anchor={pinAnchor}
            keepOpen={commentPins.keepOpen}
            onClose={commentPins.close}
          />
        )}
      </div>
      {editFrames.menu && (
        <EditContextMenu
          {...editFrames.menu}
          running={running}
          flippable={!!editFrames.selection?.flippable}
          several={(editFrames.geometry?.count ?? 0) > 1}
          group={!!editFrames.selection?.group}
          locked={!!editFrames.selection?.locked}
          onAction={editFrames.runMenuAction}
          onClose={editFrames.closeMenu}
        />
      )}
      {editing && <ShortcutHelp />}
      {deck.slides.length > 0 && (
        <StageFooter
          index={index}
          count={deck.slides.length}
          slide={slide}
          view={pasteboard.view}
          onResetView={pasteboard.resetView}
          overflow={editFrames.overflow}
          running={running}
          onClearSelection={editFrames.clearSelection}
        />
      )}
    </div>
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
function LockedNote({ deck, slide }: { deck: string; slide: string }) {
  const unlock = async () => {
    const next = await reportingErrors(() => api.setSlideLocked(deck, slide, false));
    if (next) useApp.getState().setDeck(next);
  };
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
