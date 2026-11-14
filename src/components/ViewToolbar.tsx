import {
  Check,
  ChevronDown,
  CircleDashed,
  Delete,
  Eraser,
  Eye,
  Highlighter,
  Lasso,
  type LucideIcon,
  MessageSquarePlus,
  MessageSquareText,
  MessagesSquare,
  PenLine,
  Play,
  RotateCw,
  Search,
  SkipForward,
  SquareDashed,
  Trash2,
} from "lucide-react";
import { memo, useRef, useState } from "react";

import { useMenuKeys } from "../hooks/useMenuKeys";

import type { AreaShape } from "../lib/comments";
import { INK_COLORS } from "../lib/ink";
import { cn } from "../lib/utils";
import { deckComments, hasReview, useApp } from "../store";
import { ToolButton, toolButtonClass } from "./Button";
import { CommentsOverview } from "./Comments";
import { SlideSearch } from "./FindReplace";
import { Popover } from "./Popover";
import type { Annotations } from "./PresenterTools";
import { RibbonRow, RibbonSection, RibbonToggle, useRibbonFit } from "./Ribbon";
import { TimelineTools } from "./TimelineTools";

const AREA_SHAPES: { shape: AreaShape; label: string; icon: LucideIcon }[] = [
  { shape: "rect", label: "Rectangle", icon: SquareDashed },
  { shape: "ellipse", label: "Ellipse", icon: CircleDashed },
  { shape: "lasso", label: "Lasso", icon: Lasso },
];

/**
 * View mode's tools, in a ribbon like the edit tools': pen, highlighter and eraser for marking up
 * the slide, comments on its elements or on an area outlined with a rectangle, an ellipse or a
 * lasso, the list of the deck's comments, whether the slide plays its animations or shows its
 * final state (and playing them again), the deck's timeline, and the search. Marks
 * and comments are saved in the deck file as a review, which can be shown and hidden, and go to
 * the agent with the next chat message: the marks as a screenshot, the comments as the composer
 * says, and each new area comment's screenshot of its area as an image in the composer.
 *
 * Every tool is always there, off when it has nothing to work on, so the sections keep their
 * widths and the ribbon knows what fits.
 *
 * It renders when a tool or the review changes, not with the stage around it: `annotations` and
 * the callbacks stay the same until then.
 */
export const ViewToolbar = memo(function ViewToolbar(props: {
  annotations: Annotations;
  commenting: boolean;
  onCommenting: (on: boolean) => void;
  drawingArea: boolean;
  onDrawingArea: (on: boolean) => void;
  areaShape: AreaShape;
  onAreaShape: (shape: AreaShape) => void;
}) {
  const { annotations, commenting, onCommenting, drawingArea, onDrawingArea } = props;
  const { tool, setTool, colors, setColor, strokes, undo, clear } = annotations;
  const reviewVisible = useApp((s) => s.reviewVisible);
  const commentTexts = useApp((s) => s.commentTexts);
  const finalState = useApp((s) => s.finalState);
  const reviewed = useApp(hasReview);
  const ribbon = useRibbonFit();
  const { collapsedFrom } = ribbon;
  const toggleReview = () => {
    // Hidden marks can't be drawn on, so the tools go away with them.
    if (reviewVisible) {
      setTool("pointer");
      onCommenting(false);
      onDrawingArea(false);
    }
    useApp.getState().setReviewVisible(!reviewVisible);
  };
  // The swatches show the color of the tool in hand; with neither, the pen's, which they pick up.
  const inkColor = colors[tool === "highlighter" ? "highlighter" : "pen"];
  // Clicking the active tool puts it away, so the slide is clickable again.
  const toggle = (next: typeof tool) => {
    onCommenting(false);
    onDrawingArea(false);
    setTool(tool === next ? "pointer" : next);
  };
  const toggleCommenting = () => {
    setTool("pointer");
    // New comments should not vanish as soon as they are written.
    useApp.getState().setReviewVisible(true);
    onCommenting(!commenting);
  };
  const outline = (on: boolean) => {
    setTool("pointer");
    useApp.getState().setReviewVisible(true);
    onDrawingArea(on);
  };
  const noMarks = strokes.length === 0;

  return (
    <div ref={ribbon.ref} role="toolbar" aria-label="View tools" className="flex min-w-0 flex-[1_1_200px]">
      <RibbonSection title="Mark up" icon={<PenLine />} collapsed={collapsedFrom <= 0} closeOn={tool}>
        <RibbonRow>
          <ToolButton label="Draw on the slide" active={tool === "pen"} onClick={() => toggle("pen")}>
            <PenLine />
          </ToolButton>
          <ToolButton
            label="Highlight on the slide"
            active={tool === "highlighter"}
            onClick={() => toggle("highlighter")}
          >
            <Highlighter />
          </ToolButton>
          <ToolButton label="Erase marks" active={tool === "eraser"} onClick={() => toggle("eraser")}>
            <Eraser />
          </ToolButton>
          <div className="mx-0.5 h-4 w-px bg-border" />
          {/* Not the deck's undo: it only takes the newest mark off this slide. */}
          <ToolButton label="Remove last mark" disabled={noMarks} onClick={undo}>
            <Delete />
          </ToolButton>
          <ToolButton label="Clear marks on this slide" disabled={noMarks} onClick={clear}>
            <Trash2 />
          </ToolButton>
        </RibbonRow>
        <RibbonRow>
          <div className="flex flex-1 items-center justify-around">
            {INK_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Color ${color}`}
                aria-pressed={inkColor === color}
                onClick={() => {
                  onCommenting(false);
                  onDrawingArea(false);
                  setColor(color);
                }}
                className={cn(
                  "size-3.5 rounded-full border border-foreground/20",
                  inkColor === color && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-background",
                )}
                style={{ background: color }}
              />
            ))}
          </div>
        </RibbonRow>
      </RibbonSection>
      <RibbonSection
        title="Review"
        icon={<MessageSquarePlus />}
        collapsed={collapsedFrom <= 1}
        closeOn={`${commenting} ${drawingArea} ${props.areaShape}`}
      >
        <RibbonRow>
          <ToolButton label="Comment on an element" active={commenting} onClick={toggleCommenting}>
            <MessageSquarePlus />
          </ToolButton>
          <AreaTool
            active={drawingArea}
            shape={props.areaShape}
            onToggle={() => outline(!drawingArea)}
            onShape={(shape) => {
              props.onAreaShape(shape);
              outline(true);
            }}
          />
          <CommentsButton />
        </RibbonRow>
        <RibbonRow>
          <RibbonToggle
            label="Show review marks and comments on the slides"
            active={reviewVisible}
            disabled={!reviewed}
            onClick={toggleReview}
          >
            <Eye />
            Review marks
          </RibbonToggle>
          <ToolButton
            label={
              commentTexts
                ? "Show a comment's text only when its pin is pointed at"
                : "Show every comment's text next to its pin"
            }
            active={commentTexts}
            disabled={!reviewVisible}
            onClick={() => useApp.getState().setCommentTexts(!commentTexts)}
          >
            <MessageSquareText />
          </ToolButton>
        </RibbonRow>
      </RibbonSection>
      <RibbonSection title="Animations" icon={<Play />} collapsed={collapsedFrom <= 2} closeOn={finalState}>
        <RibbonRow>
          {/* One choice of two: a slide either plays its animations as it shows, or shows how it ends. */}
          {/* biome-ignore lint/a11y/useSemanticElements: two pressed buttons read better here than a fieldset. */}
          <div
            role="group"
            aria-label="When a slide is shown"
            className="flex flex-1 items-center rounded-md border p-px"
          >
            <Segment
              label="Play the slide's animations when it is shown"
              active={!finalState}
              onClick={() => useApp.getState().setFinalState(false)}
            >
              <Play />
              Play
            </Segment>
            <Segment
              label="Show the slide's final state, with no animations, as the slide list does"
              active={finalState}
              onClick={() => useApp.getState().setFinalState(true)}
            >
              <SkipForward />
              Final
            </Segment>
          </div>
        </RibbonRow>
        <RibbonRow>
          <RibbonToggle
            label="Play this slide's animations again, from their start"
            onClick={() => useApp.getState().replaySlide()}
          >
            <RotateCw />
            Replay
          </RibbonToggle>
        </RibbonRow>
      </RibbonSection>
      <TimelineTools collapsed={collapsedFrom <= 3} />
      <RibbonSection title="Find" icon={<Search />} collapsed={collapsedFrom <= 4}>
        <SlideSearch />
      </RibbonSection>
    </div>
  );
});

/** One half of a two-way choice in the ribbon; `active` is the half chosen. */
function Segment(props: { label: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        toolButtonClass("toolbar", "xs", props.active),
        "flex flex-1 items-center justify-center gap-1 px-1.5 text-xs [&_svg]:!size-3.5",
      )}
    >
      {props.children}
    </button>
  );
}

/** How many comments the deck has, opening the list of them (see `CommentsOverview`). */
function CommentsButton() {
  const count = useApp((s) => deckComments(s).length);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label={`Comments (${count})`}
        title="All comments of the deck, by slide"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn(toolButtonClass("toolbar", "sm", open), "flex items-center gap-1 px-1.5 text-xs tabular-nums")}
      >
        <MessagesSquare />
        {count}
      </button>
      {open && <CommentsOverview anchor={anchor} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Turns on outlining an area to comment on, with a menu of the shapes to outline it with. */
function AreaTool(props: {
  active: boolean;
  shape: AreaShape;
  onToggle: () => void;
  onShape: (shape: AreaShape) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useMenuKeys();
  const anchor = useRef<HTMLDivElement>(null);
  const current = AREA_SHAPES.find((s) => s.shape === props.shape) ?? AREA_SHAPES[0]!;
  const Icon = current.icon;
  return (
    <div ref={anchor} className="flex items-center">
      <ToolButton
        label={`Comment on an area (${current.label.toLowerCase()})`}
        active={props.active}
        onClick={props.onToggle}
      >
        <Icon />
      </ToolButton>
      <ToolButton
        size="xs"
        label="Area shape"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        className="-ml-0.5"
      >
        <ChevronDown className="size-3" />
      </ToolButton>
      {menuOpen && (
        <Popover anchor={anchor} onClose={() => setMenuOpen(false)} width={180} variant="menu" portal className="p-1">
          <div role="menu" aria-label="Area shape" {...menu} className="outline-none">
            {AREA_SHAPES.map(({ shape, label, icon: ShapeIcon }) => (
              <button
                key={shape}
                type="button"
                role="menuitemradio"
                aria-checked={props.shape === shape}
                onClick={() => {
                  setMenuOpen(false);
                  props.onShape(shape);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none [&_svg]:size-3.5"
              >
                <ShapeIcon />
                <span className="flex-1 text-left">{label}</span>
                {props.shape === shape && <Check className="text-muted-foreground" />}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
