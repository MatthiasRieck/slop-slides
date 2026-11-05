import {
  Check,
  ChevronDown,
  CircleDashed,
  Eraser,
  Eye,
  EyeOff,
  Highlighter,
  Lasso,
  type LucideIcon,
  MessageSquarePlus,
  PenLine,
  SquareDashed,
  Trash2,
  Undo2,
} from "lucide-react";
import { useRef, useState } from "react";

import type { AreaShape } from "../lib/comments";
import { INK_COLORS } from "../lib/ink";
import { cn } from "../lib/utils";
import { useApp } from "../store";
import { ToolButton } from "./Button";
import { Popover } from "./Popover";
import type { Annotations } from "./PresenterTools";

const AREA_SHAPES: { shape: AreaShape; label: string; icon: LucideIcon }[] = [
  { shape: "rect", label: "Rectangle", icon: SquareDashed },
  { shape: "ellipse", label: "Ellipse", icon: CircleDashed },
  { shape: "lasso", label: "Lasso", icon: Lasso },
];

/**
 * View mode's tools: pen, highlighter and eraser for marking up the slide, and comments on its
 * elements or on an area outlined with a rectangle, an ellipse or a lasso. Marks and comments are
 * saved in the deck file as a review, which can be shown and hidden, and go to the agent with the
 * next chat message: the marks as a screenshot, the comments as the composer says, and each new
 * area comment's screenshot of its area as an image in the composer.
 */
export function SketchToolbar(props: {
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
  const hasReview = useApp((s) =>
    [...Object.values(s.sketches), ...Object.values(s.comments)].some((items) => items.length > 0),
  );
  const toggleReview = () => {
    // Hidden marks can't be drawn on, so the tools go away with them.
    if (reviewVisible) {
      setTool("pointer");
      onCommenting(false);
      onDrawingArea(false);
    }
    useApp.getState().setReviewVisible(!reviewVisible);
  };
  const inking = tool === "pen" || tool === "highlighter";
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

  return (
    <div role="toolbar" aria-label="Sketch tools" className="flex items-center gap-0.5">
      {hasReview && (
        <>
          <ToolButton
            variant="plain"
            label={reviewVisible ? "Hide review marks and comments" : "Show review marks and comments"}
            onClick={toggleReview}
          >
            {reviewVisible ? <Eye /> : <EyeOff />}
          </ToolButton>
          <div className="mx-1 h-4 w-px bg-border" />
        </>
      )}
      <ToolButton variant="plain" label="Draw on the slide" active={tool === "pen"} onClick={() => toggle("pen")}>
        <PenLine />
      </ToolButton>
      <ToolButton
        variant="plain"
        label="Highlight on the slide"
        active={tool === "highlighter"}
        onClick={() => toggle("highlighter")}
      >
        <Highlighter />
      </ToolButton>
      <ToolButton variant="plain" label="Erase marks" active={tool === "eraser"} onClick={() => toggle("eraser")}>
        <Eraser />
      </ToolButton>
      <ToolButton variant="plain" label="Comment on an element" active={commenting} onClick={toggleCommenting}>
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
      {inking && (
        <div className="mx-1 flex items-center gap-1">
          {INK_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Color ${color}`}
              aria-pressed={colors[tool] === color}
              onClick={() => setColor(color)}
              className={cn(
                "size-3.5 rounded-full border border-foreground/20",
                colors[tool] === color && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-background",
              )}
              style={{ background: color }}
            />
          ))}
        </div>
      )}
      {strokes.length > 0 && (
        <>
          <div className="mx-1 h-4 w-px bg-border" />
          <ToolButton variant="plain" label="Undo mark" onClick={undo}>
            <Undo2 />
          </ToolButton>
          <ToolButton variant="plain" label="Clear marks on this slide" onClick={clear}>
            <Trash2 />
          </ToolButton>
        </>
      )}
    </div>
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
  const anchor = useRef<HTMLDivElement>(null);
  const current = AREA_SHAPES.find((s) => s.shape === props.shape) ?? AREA_SHAPES[0]!;
  const Icon = current.icon;
  return (
    <div ref={anchor} className="flex items-center">
      <ToolButton
        variant="plain"
        label={`Comment on an area (${current.label.toLowerCase()})`}
        active={props.active}
        onClick={props.onToggle}
      >
        <Icon />
      </ToolButton>
      <ToolButton
        variant="plain"
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
          <div role="menu" aria-label="Area shape">
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
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs hover:bg-accent [&_svg]:size-3.5"
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
