import {
  Check,
  ChevronDown,
  CircleDashed,
  Clapperboard,
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
  Presentation,
  RotateCw,
  SquareDashed,
  Trash2,
} from "lucide-react";
import { memo, useRef, useState } from "react";

import { useMenuKeys } from "../hooks/useMenuKeys";

import type { AreaShape } from "../lib/comments";
import { INK_COLORS } from "../lib/ink";
import { cn } from "../lib/utils";
import { deckComments, hasReview, useApp } from "../store";
import { ToolButton } from "./Button";
import { CommentsOverview } from "./Comments";
import { Popover } from "./Popover";
import type { Annotations } from "./PresenterTools";
import { RibbonRow, RibbonSection, RibbonToggle, useRibbonFit } from "./Ribbon";
import { ChangeLayoutTool, TidyLayoutTool } from "./stage/SlideLayoutTools";
import { TimelineTools } from "./TimelineTools";

const AREA_SHAPES: { shape: AreaShape; label: string; icon: LucideIcon }[] = [
  { shape: "rect", label: "Rectangle", icon: SquareDashed },
  { shape: "ellipse", label: "Ellipse", icon: CircleDashed },
  { shape: "lasso", label: "Lasso", icon: Lasso },
];

/**
 * View mode's tools, in a ribbon like the edit tools': pen, highlighter and eraser for marking up
 * the slide, comments on its elements or on an area outlined with a rectangle, an ellipse or a
 * lasso, the list of the deck's comments, how slides show here (animated, or in their final
 * state) and replaying the slide's animations, the requests to the agent about the slide's
 * layout, and the deck's timeline. Marks
 * and comments are saved in the deck file as a review, which can be shown and hidden, and go to
 * the agent with the next chat message: the marks as a screenshot, the comments as the composer
 * says, and each new area comment's screenshot of its area as an image in the composer. Find is
 * not here: it is the bar over the stage, the same in every mode (see ./FindReplace.tsx).
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
      <RibbonSection title="Animations" icon={<Clapperboard />} collapsed={collapsedFrom <= 2} closeOn={finalState}>
        <RibbonRow>
          {/* One choice of two, a setting and not a command: how a slide shows when the user comes to it. */}
          <ShowsAs finalState={finalState} />
        </RibbonRow>
        <RibbonRow>
          <RibbonToggle
            label="Replay this slide's animations from their start"
            onClick={() => useApp.getState().replaySlide()}
          >
            <RotateCw />
            Replay animations
          </RibbonToggle>
        </RibbonRow>
      </RibbonSection>
      <RibbonSection title="Slide" icon={<Presentation />} collapsed={collapsedFrom <= 3}>
        <RibbonRow>
          <ChangeLayoutTool />
        </RibbonRow>
        <RibbonRow>
          <TidyLayoutTool />
        </RibbonRow>
      </RibbonSection>
      <TimelineTools collapsed={collapsedFrom <= 4} />
    </div>
  );
});

const SHOWS_AS = [
  { final: false, name: "Animated", hint: "Slides play their animations when you come to them" },
  { final: true, name: "Final state", hint: "Slides show as they end, with nothing moving, as the slide list does" },
];

/**
 * How a slide shows on the stage when the user comes to it: animated, or in its final state. A
 * choice of two that stays as it is set, so a segmented control; playing something is what
 * "Replay animations", the timeline's Play and the top bar's Present do.
 */
function ShowsAs({ finalState }: { finalState: boolean }) {
  return (
    <div
      role="radiogroup"
      aria-label="How slides show here"
      className="grid flex-1 grid-cols-2 gap-0.5 rounded-md border bg-muted p-0.5 text-xs"
    >
      {SHOWS_AS.map(({ final, name, hint }) => (
        <label
          key={name}
          title={hint}
          className={cn(
            "flex h-[18px] cursor-pointer items-center justify-center whitespace-nowrap rounded px-2 text-muted-foreground hover:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-primary/40",
            finalState === final && "bg-background font-medium text-foreground shadow-sm ring-1 ring-border",
          )}
        >
          <input
            type="radio"
            name="slides-show-as"
            className="sr-only"
            checked={finalState === final}
            onChange={() => useApp.getState().setFinalState(final)}
          />
          {name}
        </label>
      ))}
    </div>
  );
}

/** How many comments the deck has, opening the list of them (see `CommentsOverview`). */
function CommentsButton() {
  const count = useApp((s) => deckComments(s).length);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <ToolButton
        ref={anchor}
        label={`Comments (${count})`}
        title="All comments of the deck, by slide: choose which to send, resolve or delete them"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={cn("flex items-center gap-1 px-1.5 text-xs tabular-nums", open && "bg-accent text-foreground")}
      >
        <MessagesSquare />
        {count}
      </ToolButton>
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
