import {
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

import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { AreaShape } from "../lib/comments";
import { INK_COLORS, inkColorName } from "../lib/ink";
import { cn } from "../lib/utils";
import { deckComments, hasReview, useApp } from "../store";
import { CommentsOverview } from "./Comments";
import { SlideSearch } from "./FindReplace";
import type { Annotations } from "./PresenterTools";
import { RibbonRow, RibbonSection, RibbonToggle, useRibbonFit } from "./Ribbon";

const AREA_SHAPES: { shape: AreaShape; label: string; icon: LucideIcon }[] = [
  { shape: "rect", label: "Rectangle", icon: SquareDashed },
  { shape: "ellipse", label: "Ellipse", icon: CircleDashed },
  { shape: "lasso", label: "Lasso", icon: Lasso },
];

/** What a slide does as it is shown, as the two choices of the Animations section. */
const SHOWN = [
  { value: "play", label: "Play the slide's animations when it is shown", text: "Play", icon: Play },
  {
    value: "final",
    label: "Show the slide's final state, with no animations, as the slide list does",
    text: "Final",
    icon: SkipForward,
  },
] as const;

/**
 * View mode's tools, in a ribbon like the edit tools': pen, highlighter and eraser for marking up
 * the slide, comments on its elements or on an area outlined with a rectangle, an ellipse or a
 * lasso, the list of the deck's comments, whether the slide plays its animations or shows its
 * final state (and playing them again), and the search. Marks
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
          {/*
            Buttons marked as pressed, not a ToggleGroup: they share their one choice with the
            comment tools of Review, and a group's arrows would be taken from the slides, which
            they page through in View.
          */}
          <Button
            variant="tool"
            size="icon-xs"
            tooltip="Draw on the slide"
            aria-pressed={tool === "pen"}
            onClick={() => toggle("pen")}
          >
            <PenLine />
          </Button>
          <Button
            variant="tool"
            size="icon-xs"
            tooltip="Highlight on the slide"
            aria-pressed={tool === "highlighter"}
            onClick={() => toggle("highlighter")}
          >
            <Highlighter />
          </Button>
          <Button
            variant="tool"
            size="icon-xs"
            tooltip="Erase marks"
            aria-pressed={tool === "eraser"}
            onClick={() => toggle("eraser")}
          >
            <Eraser />
          </Button>
          <Separator orientation="vertical" className="mx-0.5 h-4 data-vertical:self-center" />
          {/* Not the deck's undo: it only takes the newest mark off this slide. */}
          <Button variant="tool" size="icon-xs" tooltip="Remove last mark" disabled={noMarks} onClick={undo}>
            <Delete />
          </Button>
          <Button variant="tool" size="icon-xs" tooltip="Clear marks on this slide" disabled={noMarks} onClick={clear}>
            <Trash2 />
          </Button>
        </RibbonRow>
        <RibbonRow>
          <div className="flex flex-1 items-center justify-around">
            {INK_COLORS.map((color) => (
              <Tooltip key={color}>
                {/* A swatch is its color, which no variant of a button is: it stays a plain one. */}
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={inkColorName(color)}
                      aria-pressed={inkColor === color}
                      onClick={() => {
                        onCommenting(false);
                        onDrawingArea(false);
                        setColor(color);
                      }}
                      className={cn(
                        "size-3.5 rounded-full border border-foreground/20 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                        inkColor === color && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-background",
                      )}
                      style={{ background: color }}
                    />
                  }
                />
                <TooltipContent>{inkColorName(color)}</TooltipContent>
              </Tooltip>
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
          <Button
            variant="tool"
            size="icon-xs"
            tooltip="Comment on an element"
            aria-pressed={commenting}
            onClick={toggleCommenting}
          >
            <MessageSquarePlus />
          </Button>
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
            disabledReason="No review marks or comments on this deck yet"
            onClick={toggleReview}
          >
            <Eye />
            Review marks
          </RibbonToggle>
          <Button
            variant="tool"
            size="icon-xs"
            tooltip={
              commentTexts
                ? "Show a comment's text only when its pin is pointed at"
                : "Show every comment's text next to its pin"
            }
            aria-pressed={commentTexts}
            disabled={!reviewVisible}
            onClick={() => useApp.getState().setCommentTexts(!commentTexts)}
          >
            <MessageSquareText />
          </Button>
        </RibbonRow>
      </RibbonSection>
      <RibbonSection title="Animations" icon={<Play />} collapsed={collapsedFrom <= 2} closeOn={finalState}>
        <RibbonRow>
          {/* One choice of two: a slide either plays its animations as it shows, or shows how it ends. */}
          <ToggleGroup
            aria-label="When a slide is shown"
            size="xs"
            variant="outline"
            spacing={0}
            value={[finalState ? "final" : "play"]}
            // Pressing the choice made keeps it: one of the two always holds.
            onValueChange={([shown]) => shown && useApp.getState().setFinalState(shown === "final")}
            className="flex-1"
          >
            {SHOWN.map(({ value, label, text, icon: Icon }) => (
              <Tooltip key={value}>
                <TooltipTrigger render={<ToggleGroupItem value={value} aria-label={label} className="flex-1" />}>
                  <Icon />
                  {text}
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            ))}
          </ToggleGroup>
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
      <RibbonSection title="Find" icon={<Search />} collapsed={collapsedFrom <= 3}>
        <SlideSearch />
      </RibbonSection>
    </div>
  );
});

/** How many comments the deck has, opening the list of them (see `CommentsOverview`). */
function CommentsButton() {
  const count = useApp((s) => deckComments(s).length);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={anchor}
        variant="tool"
        size="xs"
        aria-label={`Comments (${count})`}
        tooltip="All comments of the deck, by slide"
        aria-expanded={open}
        aria-haspopup="dialog"
        // The list leaves a press on this button to it (`closeBesideAnchor`), so it only toggles.
        onClick={() => setOpen(!open)}
        className="px-1.5 tabular-nums"
      >
        <MessagesSquare />
        {count}
      </Button>
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
  const current = AREA_SHAPES.find((s) => s.shape === props.shape) ?? AREA_SHAPES[0]!;
  const Icon = current.icon;
  return (
    <ButtonGroup>
      <Button
        variant="tool"
        size="icon-xs"
        tooltip={`Comment on an area (${current.label.toLowerCase()})`}
        aria-pressed={props.active}
        onClick={props.onToggle}
      >
        <Icon />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="tool" size="2xs" aria-label="Area shape" tooltip="Area shape" className="h-6 w-4 px-0" />
          }
        >
          <ChevronDown className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent aria-label="Area shape" align="start">
          <DropdownMenuRadioGroup value={props.shape}>
            {AREA_SHAPES.map(({ shape, label, icon: ShapeIcon }) => (
              // Picking the shape in use still starts outlining with it.
              <DropdownMenuRadioItem key={shape} value={shape} closeOnClick onClick={() => props.onShape(shape)}>
                <ShapeIcon />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
