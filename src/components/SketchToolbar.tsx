import { Eraser, Eye, EyeOff, Highlighter, PenLine, Trash2, Undo2 } from "lucide-react";
import type { ReactNode } from "react";

import { INK_COLORS } from "../lib/ink";
import { useApp } from "../store";
import { cn } from "../lib/utils";
import type { Annotations } from "./PresenterTools";

/**
 * Pen, highlighter and eraser for marking up the slide in the editor. The marks are saved in
 * deck.html as a review, which can be shown and hidden, and sent to the agent as a screenshot
 * with the next chat message.
 */
export function SketchToolbar({ annotations }: { annotations: Annotations }) {
  const { tool, setTool, colors, setColor, strokes, undo, clear } = annotations;
  const reviewVisible = useApp((s) => s.reviewVisible);
  const hasReview = useApp((s) => Object.values(s.sketches).some((marks) => marks.length > 0));
  const toggleReview = () => {
    // Hidden marks can't be drawn on, so the tools go away with them.
    if (reviewVisible) setTool("pointer");
    useApp.getState().setReviewVisible(!reviewVisible);
  };
  const inking = tool === "pen" || tool === "highlighter";
  // Clicking the active tool puts it away, so the slide is clickable again.
  const toggle = (next: typeof tool) => setTool(tool === next ? "pointer" : next);

  return (
    <div role="toolbar" aria-label="Sketch tools" className="flex items-center gap-0.5">
      {hasReview && (
        <>
          <SketchButton label={reviewVisible ? "Hide review marks" : "Show review marks"} onClick={toggleReview}>
            {reviewVisible ? <Eye /> : <EyeOff />}
          </SketchButton>
          <div className="mx-1 h-4 w-px bg-border" />
        </>
      )}
      <SketchButton label="Draw on the slide" active={tool === "pen"} onClick={() => toggle("pen")}>
        <PenLine />
      </SketchButton>
      <SketchButton label="Highlight on the slide" active={tool === "highlighter"} onClick={() => toggle("highlighter")}>
        <Highlighter />
      </SketchButton>
      <SketchButton label="Erase marks" active={tool === "eraser"} onClick={() => toggle("eraser")}>
        <Eraser />
      </SketchButton>
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
                "size-3.5 rounded-full border border-black/15 dark:border-white/30",
                colors[tool] === color && "ring-2 ring-foreground/60 ring-offset-1 ring-offset-canvas",
              )}
              style={{ background: color }}
            />
          ))}
        </div>
      )}
      {strokes.length > 0 && (
        <>
          <div className="mx-1 h-4 w-px bg-border" />
          <SketchButton label="Undo mark" onClick={undo}>
            <Undo2 />
          </SketchButton>
          <SketchButton label="Clear marks on this slide" onClick={clear}>
            <Trash2 />
          </SketchButton>
        </>
      )}
    </div>
  );
}

function SketchButton(props: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "rounded-md p-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-4",
        props.active && "bg-accent text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}
