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

import { enterMenu } from "../hooks/useMenuKeys";
import { focusTarget, restoreFocus } from "../lib/focus";
import { openLayer } from "../lib/layers";
import { cn } from "../lib/utils";

type Refs = RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[];

const isFrame = (source: MessageEventSource | null) =>
  Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === source);

/**
 * Closes a popover while `open`: on a press outside `refs` (one element or several, such as a
 * button and the panel it opens), a press in a slide preview included (it reports them as
 * `slop:press`, see src-tauri/assets/pasteboard.js), and on Escape, unless `escape` is false.
 * Escape closes only what opened last (see ../lib/layers.ts) and goes no further, so nothing under
 * the popover reacts to it. `close` may change from render to render.
 */
export function useDismiss(open: boolean, refs: Refs, close: () => void, options: { escape?: boolean } = {}) {
  const closesOnEscape = options.escape ?? true;
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
    // A press in a slide preview never reaches this window, but it is a press outside all the same.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "slop:press" && isFrame(event.source)) closeRef.current();
    };
    // Before anything else sees the press, so that nothing which keeps it to itself keeps the popover open.
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("message", onMessage);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("message", onMessage);
    };
  }, [open]);
  useEffect(() => {
    if (open && closesOnEscape) return openLayer(() => closeRef.current());
  }, [open, closesOnEscape]);
}

const MARGIN = 8;

const LOOKS = {
  dialog: { className: "flex flex-col overflow-hidden shadow-lg", gap: 6 },
  menu: { className: "overflow-y-auto shadow-xl shadow-scrim/40", gap: 8 },
};

/**
 * A panel floating next to `anchor`, kept on screen, that closes on Escape or a press outside
 * both (see `useDismiss`). It is fixed in place, on top of everything (the rail and the stage bar
 * would clip it).
 *
 * - `placement`: the anchor's side to open on; `auto` takes the side with more room.
 * - `align`: `start` lines the panel's left edge up with the anchor's, `end` its right edge, for
 *   an anchor near the right of its pane.
 * - `label`: makes the panel a dialog named `label`.
 * - `variant`: `dialog` for panels of controls, `menu` for the chat composer's menus.
 * - `portal`: renders into the body, outside container-query and scroll compositing layers.
 * - `follow`: moves with the anchor as the window, scrolling or the layout around it changes.
 * - `initialFocus`: what to focus once the panel shows. It is hidden until placed, and a hidden
 *   field can't take focus, so focusing it on mount does nothing.
 *
 * Focus: once placed, the focus goes to `initialFocus`, else to what the panel marks `autofocus`
 * (or `data-autofocus`), else into the `role="menu"` it holds (see `useMenuKeys`); a panel with
 * none of these leaves the focus where it is, as the edit ribbon's do, whose buttons keep the
 * focus in the slide. When the panel goes away with the focus in it, the focus returns to what
 * had it before the panel opened.
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

  useDismiss(true, [anchor, panel], props.onClose);

  /** What had the focus before the panel, read before anything in it takes the focus. */
  const [before] = useState(() => document.activeElement);
  // In a layout effect, whose cleanup runs with the panel still in the page.
  useLayoutEffect(() => {
    const root = panel.current;
    return () => restoreFocus(root, before);
  }, [before]);

  const placed = position.visibility !== "hidden";
  const initialFocus = props.initialFocus;
  useEffect(() => {
    const root = panel.current;
    if (!placed || !root) return;
    const target = focusTarget(root, initialFocus);
    if (!target) {
      const menu = root.querySelector<HTMLElement>("[role=menu]");
      if (menu && !root.contains(document.activeElement)) enterMenu(menu);
      return;
    }
    target.focus();
    // A press in the slide preview that opened the panel can hand focus to the preview after
    // this; take it back once that has settled.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== target) target.focus();
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
