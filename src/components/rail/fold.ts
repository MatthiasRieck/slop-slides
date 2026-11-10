import { getClientRect } from "@dnd-kit/core";

const IFRAME_HOLD_ID = "slide-drag-iframe-hold";

/**
 * A pointer over an iframe (the stage's slide) sends its events to the iframe's document, so a
 * drag that crossed it lost the moves and the release and stayed stuck. Keep iframes out of the
 * way while a slide is dragged.
 */
export function holdIframes() {
  if (document.getElementById(IFRAME_HOLD_ID)) return;
  const style = document.createElement("style");
  style.id = IFRAME_HOLD_ID;
  style.textContent = "iframe { pointer-events: none !important; }";
  document.head.appendChild(style);
}

/** Lets the iframes take the pointer again, once the drag is over. */
export function releaseIframes() {
  document.getElementById(IFRAME_HOLD_ID)?.remove();
}

/** The section being dragged, where its row was when picked up, and how tall a slide's row is. */
export type SectionMove = { key: string; top: number; slideHeight: number };

const FOLD = { duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)" };

/** Shrinks the slides' rows to nothing, or grows them back. The -mt-3 takes back the list's gap. */
export function foldSlides(rows: HTMLElement, height: number, opening: boolean) {
  const open = { height: `${height}px`, marginTop: "0px", opacity: 1, overflow: "hidden" };
  const shut = { height: "0px", marginTop: "-12px", opacity: 0, overflow: "hidden" };
  for (const slide of rows.querySelectorAll("[data-rail-slide]"))
    slide.animate(opening ? [shut, open] : [open, shut], FOLD);
  if (opening) return;
  for (const label of rows.querySelectorAll("[data-fold-label]")) label.animate([{ opacity: 0 }, { opacity: 1 }], FOLD);
}

/** Scrolls or pads the rail so the row `key` sits at `top` in the window. */
function placeRow(rows: HTMLElement, key: string, top: number) {
  const scroller = rows.parentElement;
  const at = rowTop(rows, key);
  if (!scroller || at == null) return;
  const padded = Number.parseFloat(rows.style.paddingTop || "0");
  const scroll = scroller.scrollTop - padded + at - top;
  const content = rows.offsetHeight - padded - Number.parseFloat(rows.style.paddingBottom || "0");
  rows.style.paddingTop = `${Math.max(-scroll, 0)}px`;
  rows.style.paddingBottom = `${Math.max(scroll + scroller.clientHeight - content, 0)}px`;
  scroller.scrollTop = Math.max(scroll, 0);
}

/** Where the row of a section put down ends up once the slides are open and nothing is padded. */
export function openTop(rows: HTMLElement, { key, top }: SectionMove) {
  const scroller = rows.parentElement;
  rows.style.paddingTop = "";
  rows.style.paddingBottom = "";
  const at = rowTop(rows, key);
  if (!scroller || at == null) return top;
  const row = at + scroller.scrollTop;
  return row - Math.min(Math.max(row - top, 0), scroller.scrollHeight - scroller.clientHeight);
}

/**
 * Keeps the row `key` in place, on its way `from` one height `to` another, while the slides fold.
 * Calls `placed` each time the rows have moved, and `done` at the end.
 */
export function holdRow(
  rows: HTMLElement,
  key: string,
  from: number,
  to: number,
  placed?: () => void,
  done?: () => void,
) {
  const start = performance.now();
  let frame = 0;
  // The slides' own animation starts up to a frame later, so one frame more sees them all the way.
  let last = false;
  const step = () => {
    const t = Math.min((performance.now() - start) / FOLD.duration, 1);
    placeRow(rows, key, from + (to - from) * t * t * (3 - 2 * t));
    placed?.();
    if (t < 1 || (placed && !last)) frame = requestAnimationFrame(step);
    if (t < 1) return;
    if (!last) done?.();
    last = true;
  };
  step();
  return () => cancelAnimationFrame(frame);
}

/** Where the section row `key` sits in the window, whatever a drag is doing to it. */
export function rowTop(list: HTMLElement | null, key: string) {
  const row = list?.querySelector(`[data-section-key="${key}"]`);
  return row ? getClientRect(row, { ignoreTransform: true }).top : null;
}
