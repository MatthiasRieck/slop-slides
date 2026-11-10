import { displayCopy, elementsOf, type Handle, handlesOf, type Point, viewBoxOf } from "../../lib/svgEdit";
import { deckFileUrl } from "../../lib/utils";
import type { SvgAncestor, SvgEdit } from "../../svgStore";

/** What the canvas draws over the drawing, in the canvas content's pixels. */
export interface Overlay {
  /** The selected element's box, as a polygon (it turns with its transform). */
  outline: Point[] | null;
  handles: (Handle & { at: Point })[];
}

export const NO_OVERLAY: Overlay = { outline: null, handles: [] };

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
  return { outline, handles };
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
