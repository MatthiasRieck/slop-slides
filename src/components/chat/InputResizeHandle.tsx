import { type RefObject, useRef, useSyncExternalStore } from "react";

/** The smallest the message input gets, in pixels. */
export const MIN_INPUT_HEIGHT = 64;
/** How much of the window's height the input may be dragged to. */
const MAX_WINDOW_SHARE = 0.6;

/** The tallest the message input may be dragged to in the window as it is now, in pixels. */
const tallest = () => Math.max(MIN_INPUT_HEIGHT, Math.round(window.innerHeight * MAX_WINDOW_SHARE));

function onWindowResize(changed: () => void) {
  window.addEventListener("resize", changed);
  return () => window.removeEventListener("resize", changed);
}

/**
 * The grip at the top of the composer that makes the message input taller or shorter, by
 * dragging or with the arrow keys (Home and End for the smallest and largest). `height` is the
 * height chosen so far, null while the input fits itself to its text; `onResize` gets the next
 * one, between the smallest and a share of the window's height, which the grip follows itself as
 * the window is resized. A double click (or Escape on the grip) gives the height back to the
 * text: `onResize(null)`.
 */
export function InputResizeHandle(props: {
  textarea: RefObject<HTMLTextAreaElement | null>;
  height: number | null;
  onResize: (height: number | null) => void;
  className?: string;
}) {
  const { textarea } = props;
  const max = useSyncExternalStore(onWindowResize, tallest);
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
      title={
        props.height === null
          ? "Drag up to make the message input taller"
          : "Drag to resize the message input; double-click to fit it to the text again"
      }
      className={`group flex h-4 w-full shrink-0 cursor-ns-resize touch-none items-center justify-center rounded-t-2xl ${props.className ?? ""}`}
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
      onDoubleClick={() => props.onResize(null)}
      onKeyDown={(e) => {
        const height = current();
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Home" || e.key === "End") {
          e.preventDefault();
          resize(
            e.key === "Home" ? MIN_INPUT_HEIGHT : e.key === "End" ? max : height + (e.key === "ArrowUp" ? 16 : -16),
          );
        } else if (e.key === "Escape" && props.height !== null) {
          e.preventDefault();
          props.onResize(null);
        }
      }}
    >
      <span className="h-1 w-8 rounded-full bg-border group-hover:bg-muted-foreground group-focus-visible:bg-primary" />
    </div>
  );
}
