import { displayCopy, elementsOf, type Handle, handlesOf, type Point, viewBoxOf } from "../../lib/svgEdit";
import { deckFileUrl } from "../../lib/utils";
import type { SvgAncestor, SvgEdit } from "../../svgStore";

/** What the canvas draws over the drawing, in the canvas content's pixels. */
export interface Overlay {
  /** The selected element's box, as a polygon (it turns with its transform). */
  outline: Point[] | null;
  handles: (Handle & { at: Point })[];
  /** The handles that resize the selected element, each by the way it pulls (see SCALE_DIRS); none for the drawing itself. */
  scales: { dir: ScaleDir; at: Point }[];
}

export const NO_OVERLAY: Overlay = { outline: null, handles: [], scales: [] };

/** Which way a resize handle pulls: -1, 0 or 1 across and down, from the box's middle. */
export type ScaleDir = [x: -1 | 0 | 1, y: -1 | 0 | 1];

/** The resize handles: the corners and the middles of the sides, clockwise from the top left. */
export const SCALE_DIRS: ScaleDir[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
];

/** How far the resize handles stand off the box, in screen pixels, clear of the points on its edge. */
const SCALE_OFFSET = 8;

/** An element is never resized to less than this share of its size, nor turned over by it. */
const MIN_SCALE = 0.02;

/** A box in some user units. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The box around element `el` of a drawing as it shows, in its parent's user units, which is what
 * resizing it scales in; and the parent's units to the screen's. Null when it is not drawn.
 */
export function parentBox(el: SVGGraphicsElement): { box: Box; toScreen: DOMMatrix } | null {
  const parent = el.parentElement as unknown as SVGGraphicsElement | null;
  if (!parent || typeof parent.getScreenCTM !== "function" || typeof el.getScreenCTM !== "function") return null;
  const own = el.getScreenCTM();
  const toScreen = parent.getScreenCTM();
  if (!own || !toScreen) return null;
  let bbox: { x: number; y: number; width: number; height: number };
  try {
    bbox = el.getBBox();
  } catch {
    return null;
  }
  const toParent = DOMMatrix.fromMatrix(toScreen).inverse();
  const corners = [
    [bbox.x, bbox.y],
    [bbox.x + bbox.width, bbox.y],
    [bbox.x + bbox.width, bbox.y + bbox.height],
    [bbox.x, bbox.y + bbox.height],
  ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(own).matrixTransform(toParent));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }, toScreen: DOMMatrix.fromMatrix(toScreen) };
}

/** Elements that would load or run something; around a drawing they are mirrored as a <div>. */
const ACTIVE_TAGS = /^(script|style|link|iframe|frame|object|embed|template|base|meta|img|video|audio|source)$/;

/**
 * `copy` inside elements mirroring the ones it sits in on the slide (outermost first), so the
 * deck's rules that pick it out by them match; they draw no box of their own.
 */
export function withAncestors(copy: Element, ancestors: SvgAncestor[]): Element {
  let outer = copy;
  for (const { tag, attrs } of [...ancestors].reverse()) {
    let el: HTMLElement;
    try {
      el = document.createElement(ACTIVE_TAGS.test(tag) ? "div" : tag);
    } catch {
      continue;
    }
    for (const [name, value] of Object.entries(attrs)) {
      try {
        el.setAttribute(name, value);
      } catch {
        // Not a name an attribute can have.
      }
    }
    el.style.setProperty("display", "contents", "important");
    el.append(outer);
    outer = el;
  }
  return outer;
}

/**
 * Draws the drawing as edited into `host`'s shadow root, `k` times its size, so its styles stay
 * inside it and the app's do not reach it. Gives back the copy drawn, to find its elements on screen.
 */
export function showDrawing(
  host: HTMLElement,
  svg: SVGSVGElement,
  edit: Pick<SvgEdit, "deckId" | "size" | "vars" | "color" | "css" | "ancestors">,
  k: number,
): Element {
  const { size } = edit;
  const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const copy = displayCopy(svg, (url) => deckFileUrl(edit.deckId, url));
  copy.setAttribute("viewBox", viewBoxOf(svg, size));
  copy.setAttribute("width", String(size.w * k));
  copy.setAttribute("height", String(size.h * k));
  const look = (copy as SVGElement).style;
  // Where the slide put it does not matter here, whatever the deck's rules say.
  for (const [name, value] of [
    ["position", "static"],
    ["inset", "auto"],
    ["translate", "none"],
    ["rotate", "none"],
    ["scale", "none"],
    ["transform", "none"],
    ["margin", "0"],
    ["width", `${size.w * k}px`],
    ["height", `${size.h * k}px`],
    ["min-width", "0"],
    ["min-height", "0"],
    ["max-width", "none"],
    ["max-height", "none"],
    ["display", "block"],
    ["overflow", "visible"],
  ] as const) {
    look.setProperty(name, value, "important");
  }
  const frame = document.createElement("div");
  frame.className = "frame";
  for (const [name, value] of Object.entries(edit.vars)) frame.style.setProperty(name, value);
  if (edit.color) frame.style.color = edit.color;
  frame.append(withAncestors(copy, edit.ancestors));
  const base = document.createElement("style");
  base.textContent = ":host { display: block; } .frame { line-height: normal; } a { pointer-events: none; }";
  // The deck's own rules, so a drawing styled by them looks as it does on the slide.
  const deck = document.createElement("style");
  deck.textContent = edit.css;
  root.replaceChildren(base, deck, frame);
  return copy;
}

/**
 * Where the element at `selected` is drawn in `copy`, measured against the canvas `content`: its
 * outline and the handles of its points, from the model `svg`.
 */
export function overlayOf(
  copy: Element | null,
  svg: SVGSVGElement,
  selected: number | null,
  content: HTMLElement | null,
): Overlay {
  const el = selected !== null && copy ? (elementsOf(copy)[selected] as SVGGraphicsElement | undefined) : undefined;
  const model = selected !== null ? elementsOf(svg)[selected] : undefined;
  if (!content || !el || !model || typeof el.getScreenCTM !== "function") return NO_OVERLAY;
  const ctm = el.getScreenCTM();
  if (!ctm) return NO_OVERLAY;
  const origin = content.getBoundingClientRect();
  const at = (x: number, y: number): Point => {
    const p = new DOMPoint(x, y).matrixTransform(ctm);
    return [p.x - origin.left, p.y - origin.top];
  };
  let outline: Point[] | null = null;
  try {
    const box = el.getBBox();
    outline = [
      at(box.x, box.y),
      at(box.x + box.width, box.y),
      at(box.x + box.width, box.y + box.height),
      at(box.x, box.y + box.height),
    ];
  } catch {
    // Not drawn (display: none, or inside <defs>).
  }
  const handles = handlesOf(model).map((h) => ({
    ...h,
    at: at(h.x, h.y),
    links: h.links?.map((l) => at(l[0], l[1])),
  }));
  return { outline, handles, scales: selected === 0 ? [] : scaleHandles(el, origin) };
}

/** Where the resize handles of `el` go around its box (see parentBox), against the canvas content at `origin`. */
function scaleHandles(el: SVGGraphicsElement, origin: DOMRect): Overlay["scales"] {
  const frame = parentBox(el);
  if (!frame) return [];
  const { box, toScreen } = frame;
  const center = new DOMPoint(box.x + box.w / 2, box.y + box.h / 2).matrixTransform(toScreen);
  return SCALE_DIRS.map((dir) => {
    const p = new DOMPoint(box.x + ((dir[0] + 1) / 2) * box.w, box.y + ((dir[1] + 1) / 2) * box.h).matrixTransform(
      toScreen,
    );
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const length = Math.hypot(dx, dy) || 1;
    return {
      dir,
      at: [p.x - origin.left + (dx / length) * SCALE_OFFSET, p.y - origin.top + (dy / length) * SCALE_OFFSET],
    };
  });
}

/** How many elements `el` counts for in the drawing's list: itself and all inside it. */
export const subtreeSize = (el: Element) => el.querySelectorAll("*").length + 1;

/** Puts a copy of `el` right after it, without its ids, which must stay unique. */
export function duplicate(el: Element) {
  const copy = el.cloneNode(true) as Element;
  copy.removeAttribute("id");
  for (const inner of copy.querySelectorAll("[id]")) inner.removeAttribute("id");
  el.after(copy);
}

/** A checkerboard of `check` squares over the ground color. */
export function checkerboard(check: string) {
  const squares = `linear-gradient(45deg, ${check} 25%, transparent 25%, transparent 75%, ${check} 75%)`;
  return `${squares}, ${squares}`;
}

/**
 * How a resize handle that pulls `dir` scales `box` once dragged (dx, dy), all in the box's
 * units: by (sx, sy) around (ox, oy), the opposite side or corner, or with Alt the box's middle.
 * Shift keeps the box's proportions. It never shrinks to nothing or turns the element over.
 */
export function scaling(
  dir: ScaleDir,
  box: Box,
  dx: number,
  dy: number,
  keys: { shiftKey: boolean; altKey: boolean },
): { sx: number; sy: number; ox: number; oy: number } {
  const reach = keys.altKey ? 2 : 1;
  let sx = dir[0] ? Math.max(MIN_SCALE, (box.w + dir[0] * dx * reach) / box.w) : 1;
  let sy = dir[1] ? Math.max(MIN_SCALE, (box.h + dir[1] * dy * reach) / box.h) : 1;
  if (keys.shiftKey) {
    // A corner goes by whichever way it was pulled further; a side takes the other along.
    const even = dir[0] && dir[1] ? Math.max(sx, sy) : dir[0] ? sx : sy;
    sx = sy = even;
  }
  const side = (d: number, start: number, size: number) =>
    keys.altKey || d === 0 ? start + size / 2 : d > 0 ? start : start + size;
  return { sx, sy, ox: side(dir[0], box.x, box.w), oy: side(dir[1], box.y, box.h) };
}
