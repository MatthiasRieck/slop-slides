import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../lib/utils";

type Refs = RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[];

/**
 * Closes a popover while `open`: on a press outside `refs` (one element or several, such as a
 * button and the panel it opens) and, with `escape`, on Escape. With `capture`, it listens on the
 * document before anything else sees the event and keeps Escape from going further, for popovers
 * whose Escape must not also close what they sit in; otherwise it listens on the window, after
 * the page's own handlers. `close` may change from render to render.
 */
export function useDismiss(
  open: boolean,
  refs: Refs,
  close: () => void,
  options: { escape?: boolean; capture?: boolean } = {},
) {
  const closesOnEscape = options.escape ?? false;
  const capture = options.capture ?? false;
  const closeRef = useRef(close);
  closeRef.current = close;
  const refsRef = useRef(refs);
  refsRef.current = refs;
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      const all = Array.isArray(refsRef.current) ? refsRef.current : [refsRef.current];
      if (!all.some((ref) => ref.current?.contains(target))) closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (capture) event.stopPropagation();
      closeRef.current();
    };
    const target: Document | Window = capture ? document : window;
    target.addEventListener("pointerdown", onPointer as EventListener, capture);
    if (closesOnEscape) target.addEventListener("keydown", onKey as EventListener, capture);
    return () => {
      target.removeEventListener("pointerdown", onPointer as EventListener, capture);
      if (closesOnEscape) target.removeEventListener("keydown", onKey as EventListener, capture);
    };
  }, [open, closesOnEscape, capture]);
}

const MARGIN = 8;

const LOOKS = {
  dialog: { className: "flex flex-col overflow-hidden shadow-lg", gap: 6 },
  menu: { className: "overflow-y-auto shadow-xl shadow-scrim/40", gap: 8 },
};

/**
 * A panel floating next to `anchor`, kept on screen, that closes on Escape or a press outside
 * both. It is fixed in place, on top of everything (the rail and the stage bar would clip it).
 *
 * - `placement`: the anchor's side to open on; `auto` takes the side with more room.
 * - `align`: `start` lines the panel's left edge up with the anchor's, `end` its right edge, for
 *   an anchor near the right of its pane.
 * - `label`: makes the panel a dialog named `label`.
 * - `variant`: `dialog` for panels of controls, `menu` for the chat composer's menus.
 * - `portal`: renders into the body, outside container-query and scroll compositing layers.
 * - `follow`: moves with the anchor as the window, scrolling or the layout around it changes.
 * - `capture`: see `useDismiss`; Escape then stops at the popover.
 * - `initialFocus`: what to focus once the panel shows. It is hidden until placed, and a hidden
 *   field can't take focus, so focusing it on mount does nothing.
 */
export function Popover(props: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  width: number;
  placement?: "above" | "below" | "auto";
  align?: "start" | "end";
  label?: string;
  variant?: keyof typeof LOOKS;
  className?: string;
  portal?: boolean;
  follow?: boolean;
  capture?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const { anchor, width, placement = "auto", align = "start", follow = false } = props;
  const look = LOOKS[props.variant ?? "dialog"];
  const { gap } = look;
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const panelWidth = Math.min(width, window.innerWidth - MARGIN * 2);
      const above = rect.top - MARGIN * 2;
      const below = window.innerHeight - rect.bottom - MARGIN * 2;
      const left = align === "end" ? rect.right - panelWidth : rect.left;
      const opensAbove = placement === "auto" ? above >= below : placement === "above";
      setPosition({
        width: panelWidth,
        left: Math.max(MARGIN, Math.min(left, window.innerWidth - panelWidth - MARGIN)),
        ...(opensAbove ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
        maxHeight: Math.max(0, opensAbove ? above : below),
      });
    };
    place();
    if (!follow) return;
    const observer = new ResizeObserver(place);
    // Panel resizing and textarea resizing can move the anchor without changing its size.
    for (let element = anchor.current; element; element = element.parentElement) observer.observe(element);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [anchor, placement, align, width, gap, follow]);

  useDismiss(true, [anchor, panel], props.onClose, { escape: true, capture: props.capture });

  const placed = position.visibility !== "hidden";
  const initialFocus = props.initialFocus;
  useEffect(() => {
    if (!placed || !initialFocus) return;
    initialFocus.current?.focus();
    // A press in the slide preview that opened the panel can hand focus to the preview after
    // this; take it back once that has settled.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== initialFocus.current) initialFocus.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [placed, initialFocus]);

  const content = (
    <div
      ref={panel}
      data-popover=""
      {...(props.label !== undefined && { role: "dialog", "aria-label": props.label })}
      style={{ width, ...position }}
      className={`fixed z-50 rounded-xl border bg-card text-foreground ${look.className} ${props.className ?? ""}`}
    >
      {props.children}
    </div>
  );
  return props.portal ? createPortal(content, document.body) : content;
}

/** The class of a `DropdownPanel`, for a panel that is not a div (a form, say). */
export const dropdownPanel =
  "absolute top-full left-1/2 z-30 mt-1 -translate-x-1/2 rounded-md border bg-card p-2 shadow-md";

/**
 * A toolbar button's panel, dropping down centered under it. Put it next to the button in a
 * `relative` wrapper; `className` lays out what it holds.
 */
export function DropdownPanel({ className, ...props }: ComponentProps<"div">) {
  return <div {...props} className={cn(dropdownPanel, className)} />;
}
