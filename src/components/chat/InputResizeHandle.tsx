import { type RefObject, useRef } from "react";

/** The smallest the message input gets, in pixels. */
export const MIN_INPUT_HEIGHT = 64;

/**
 * The grip at the top of the composer that makes the message input taller or shorter, by
 * dragging or with the arrow keys (Home and End for the smallest and largest). `height` is the
 * height chosen so far, if any; `onResize` gets the next one, between the smallest and `max`.
 */
export function InputResizeHandle(props: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  height: number | null;
  max: number;
  onResize: (height: number) => void;
}) {
  const { textarea, max } = props;
  const resizeStart = useRef<{ y: number; height: number } | null>(null);
  const resize = (height: number) => props.onResize(Math.max(MIN_INPUT_HEIGHT, Math.min(max, height)));
  const current = () => textarea.current?.getBoundingClientRect().height ?? MIN_INPUT_HEIGHT;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable window splitter supports resizing; hr cannot contain the grip.
    <div
      role="separator"
      aria-label="Resize message input"
      aria-orientation="horizontal"
      aria-valuemin={MIN_INPUT_HEIGHT}
      aria-valuemax={max}
      aria-valuenow={props.height ?? MIN_INPUT_HEIGHT}
      tabIndex={0}
      title="Drag up to make the message input taller"
      className="group flex h-4 w-full cursor-ns-resize touch-none items-center justify-center rounded-t-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        resizeStart.current = { y: e.clientY, height: current() };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const start = resizeStart.current;
        if (start) resize(start.height + start.y - e.clientY);
      }}
      onPointerUp={(e) => {
        resizeStart.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        resizeStart.current = null;
      }}
      onLostPointerCapture={() => {
        resizeStart.current = null;
      }}
      onKeyDown={(e) => {
        const height = current();
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") {
          e.preventDefault();
          resize(
            e.key === "Home" ? MIN_INPUT_HEIGHT : e.key === "End" ? max : height + (e.key === "ArrowUp" ? 16 : -16),
          );
        }
      }}
    >
      <span className="h-1 w-8 rounded-full bg-border group-hover:bg-muted-foreground group-focus-visible:bg-primary" />
    </div>
  );
}
