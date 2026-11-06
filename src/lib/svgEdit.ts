/**
 * Editing one SVG drawing of a slide outside the slide, in the sidebar's SVG editor: reading its
 * markup, the points of its shapes (path data, polylines, lines, rectangles, circles), moving
 * elements, and putting the edited drawing back into the slide's markup.
 *
 * The drawing is edited as markup: each change parses it, changes the parsed copy and
 * serializes it again, so what is saved is exactly what was shown.
 */

export type Point = [number, number];

const SVG_NS = "http://www.w3.org/2000/svg";

// ---- Markup

/** The `<svg>` that `markup` is, parsed as the deck's HTML parses it; null unless it is one drawing. */
export function parseSvg(markup: string): SVGSVGElement | null {
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  const nodes = [...template.content.childNodes].filter(
    (n) => n.nodeType === Node.ELEMENT_NODE || (n.nodeType === Node.TEXT_NODE && n.textContent?.trim()),
  );
  const [root] = nodes;
  if (nodes.length !== 1 || !(root instanceof Element) || !isSvgRoot(root)) return null;
  return root as SVGSVGElement;
}

function isSvgRoot(el: Element): boolean {
  return el.namespaceURI === SVG_NS && el.localName === "svg";
}

/** The drawing's markup again, as the slide editor writes it. */
export function serializeSvg(svg: Element): string {
  return svg.outerHTML;
}

/** Every element of the drawing in document order, the drawing first: an element's index names it across edits. */
export function elementsOf(svg: Element): Element[] {
  return [svg, ...svg.querySelectorAll("*")];
}

/**
 * Parses `markup`, lets `change` edit the element at `index` (the drawing when 0), and gives the
 * new markup; the same markup when the element is not there or `change` returns false.
 */
export function editMarkup(
  markup: string,
  index: number,
  change: (el: Element, svg: SVGSVGElement) => unknown,
): string {
  const svg = parseSvg(markup);
  const el = svg ? elementsOf(svg)[index] : undefined;
  if (!svg || !el) return markup;
  if (change(el, svg) === false) return markup;
  return serializeSvg(svg);
}

/** A short name for an element: its tag, with its id or first class. */
export function labelOf(el: Element): string {
  const id = el.getAttribute("id");
  const cls = el.getAttribute("class")?.trim().split(/\s+/)[0];
  return `${el.localName}${id ? `#${id}` : cls ? `.${cls}` : ""}`;
}

// ---- Numbers

/** `n` with at most three decimals, as SVG writes it. */
export function fmt(n: number): string {
  const r = Math.round(n * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

function num(value: string | null | undefined, fallback = 0): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : fallback;
}

// ---- Path data

export type PathCommand =
  | { type: "M"; to: Point }
  | { type: "L"; to: Point }
  | { type: "C"; c1: Point; c2: Point; to: Point }
  | { type: "Q"; c: Point; to: Point }
  | { type: "A"; rx: number; ry: number; rotation: number; large: boolean; sweep: boolean; to: Point }
  | { type: "Z" };

/**
 * Path data as absolute commands: H and V become L, S and T become C and Q with their control
 * points spelled out, so every point the path goes through or bends towards can be moved.
 */
export function parsePath(d: string): PathCommand[] {
  const out: PathCommand[] = [];
  let i = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  const number = (): number | null => {
    skip();
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(d.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): boolean | null => {
    skip();
    const c = d[i];
    if (c !== "0" && c !== "1") return null;
    i++;
    return c === "1";
  };
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  // The last control point, for S and T to mirror.
  let lastCubic: Point | null = null;
  let lastQuad: Point | null = null;
  let command = "";
  for (;;) {
    skip();
    if (i >= d.length) break;
    if (/[a-zA-Z]/.test(d[i]!)) command = d[i++]!;
    else if (!command || /[zZ]/.test(command)) break; // a number where none can be: the rest is not path data
    const rel = command === command.toLowerCase();
    const up = command.toUpperCase();
    const at = (x: number, y: number): Point => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const pair = (): Point | null => {
      const x = number();
      const y = x === null ? null : number();
      return x === null || y === null ? null : at(x, y);
    };
    let ok = true;
    if (up === "Z") {
      out.push({ type: "Z" });
      cur = start;
      lastCubic = lastQuad = null;
      continue;
    }
    if (up === "M" || up === "L" || up === "T") {
      const to = pair();
      if (!to) break;
      if (up === "M") {
        out.push({ type: "M", to });
        start = to;
        // Pairs after the first go on as lines.
        command = rel ? "l" : "L";
      } else if (up === "L") {
        out.push({ type: "L", to });
      } else {
        const c: Point = lastQuad ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]] : cur;
        out.push({ type: "Q", c, to });
        lastQuad = c;
        lastCubic = null;
        cur = to;
        continue;
      }
      cur = to;
    } else if (up === "H" || up === "V") {
      const v = number();
      if (v === null) break;
      const to: Point = up === "H" ? [rel ? cur[0] + v : v, cur[1]] : [cur[0], rel ? cur[1] + v : v];
      out.push({ type: "L", to });
      cur = to;
    } else if (up === "C" || up === "S") {
      const c1: Point | null =
        up === "C" ? pair() : lastCubic ? [2 * cur[0] - lastCubic[0], 2 * cur[1] - lastCubic[1]] : cur;
      const c2: Point | null = c1 && pair();
      const to: Point | null = c2 && pair();
      if (!c1 || !c2 || !to) break;
      out.push({ type: "C", c1, c2, to });
      cur = to;
      lastCubic = c2;
      lastQuad = null;
      continue;
    } else if (up === "Q") {
      const c: Point | null = pair();
      const to: Point | null = c && pair();
      if (!c || !to) break;
      out.push({ type: "Q", c, to });
      cur = to;
      lastQuad = c;
      lastCubic = null;
      continue;
    } else if (up === "A") {
      const rx = number();
      const ry = rx === null ? null : number();
      const rotation = ry === null ? null : number();
      const large = rotation === null ? null : flag();
      const sweep = large === null ? null : flag();
      const to = sweep === null ? null : pair();
      if (rx === null || ry === null || rotation === null || large === null || sweep === null || !to) break;
      out.push({ type: "A", rx, ry, rotation, large, sweep, to });
      cur = to;
    } else {
      ok = false;
    }
    if (!ok) break;
    lastCubic = lastQuad = null;
  }
  return out;
}

/** Path data for `commands`, all absolute. */
export function serializePath(commands: PathCommand[]): string {
  const p = (pt: Point) => `${fmt(pt[0])} ${fmt(pt[1])}`;
  return commands
    .map((c) => {
      switch (c.type) {
        case "M":
          return `M${p(c.to)}`;
        case "L":
          return `L${p(c.to)}`;
        case "C":
          return `C${p(c.c1)} ${p(c.c2)} ${p(c.to)}`;
        case "Q":
          return `Q${p(c.c)} ${p(c.to)}`;
        case "A":
          return `A${fmt(c.rx)} ${fmt(c.ry)} ${fmt(c.rotation)} ${c.large ? 1 : 0} ${c.sweep ? 1 : 0} ${p(c.to)}`;
        case "Z":
          return "Z";
      }
      return "";
    })
    .join(" ");
}

/** Where each command starts: the end of the one before, or its subpath's start after a Z. */
function startsOf(commands: PathCommand[]): Point[] {
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  return commands.map((c) => {
    const from = cur;
    if (c.type === "Z") cur = start;
    else {
      cur = c.to;
      if (c.type === "M") start = c.to;
    }
    return from;
  });
}

/** Where subpath `index`'s Z goes back to. */
function subpathStart(commands: PathCommand[], index: number): Point {
  for (let i = index; i >= 0; i--) {
    const c = commands[i]!;
    if (c.type === "M") return c.to;
  }
  return [0, 0];
}

function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Splits the cubic Bézier (a, b, c, d) in half: [a, ab, abc, m] and [m, bcd, cd, d]. */
function splitCubic(a: Point, b: Point, c: Point, d: Point): [Point, Point, Point, Point, Point, Point, Point] {
  const ab = lerp(a, b, 0.5);
  const bc = lerp(b, c, 0.5);
  const cd = lerp(c, d, 0.5);
  const abc = lerp(ab, bc, 0.5);
  const bcd = lerp(bc, cd, 0.5);
  const m = lerp(abc, bcd, 0.5);
  return [a, ab, abc, m, bcd, cd, d];
}

// ---- Handles: the points of a shape that can be dragged

export type HandleRole = "anchor" | "control" | "add";

export interface Handle {
  /** Names the point across edits of the same shape (see `moveHandle`). */
  id: string;
  /** In the shape's own user units. */
  x: number;
  y: number;
  /** A point the shape goes through, one it bends towards, or a spot to add a point at. */
  role: HandleRole;
  /** Points a control point is drawn joined to. */
  links?: Point[];
  /** It can be taken out (double-click), leaving a shape that still draws. */
  removable?: boolean;
}

const pointList = (value: string | null): Point[] => {
  const numbers = (value ?? "").match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  const points: Point[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i]!, numbers[i + 1]!]);
  return points;
};

const writePoints = (points: Point[]) => points.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(" ");

/** The shapes whose points can be edited. */
export function hasPoints(el: Element): boolean {
  return /^(path|polyline|polygon|line|rect|circle|ellipse)$/.test(el.localName);
}

/** The draggable points of shape `el`, in its own user units; none for other elements. */
export function handlesOf(el: Element): Handle[] {
  const a = (name: string) => num(el.getAttribute(name));
  switch (el.localName) {
    case "path": {
      const commands = parsePath(el.getAttribute("d") ?? "");
      const starts = startsOf(commands);
      const segments = commands.filter((c) => c.type !== "M").length;
      const handles: Handle[] = [];
      commands.forEach((c, i) => {
        const from = starts[i]!;
        if (c.type === "Z") {
          const back = subpathStart(commands, i);
          if (from[0] !== back[0] || from[1] !== back[1]) {
            const mid = lerp(from, back, 0.5);
            handles.push({ id: `add:${i}`, x: mid[0], y: mid[1], role: "add" });
          }
          return;
        }
        if (c.type === "C") {
          handles.push({ id: `c1:${i}`, x: c.c1[0], y: c.c1[1], role: "control", links: [from] });
          handles.push({ id: `c2:${i}`, x: c.c2[0], y: c.c2[1], role: "control", links: [c.to] });
        } else if (c.type === "Q") {
          handles.push({ id: `c:${i}`, x: c.c[0], y: c.c[1], role: "control", links: [from, c.to] });
        }
        handles.push({ id: `to:${i}`, x: c.to[0], y: c.to[1], role: "anchor", removable: segments > 1 });
        if (c.type === "L" || c.type === "C" || c.type === "Q") {
          const mid =
            c.type === "L"
              ? lerp(from, c.to, 0.5)
              : c.type === "Q"
                ? lerp(lerp(from, c.c, 0.5), lerp(c.c, c.to, 0.5), 0.5)
                : splitCubic(from, c.c1, c.c2, c.to)[3];
          handles.push({ id: `add:${i}`, x: mid[0], y: mid[1], role: "add" });
        }
      });
      return handles;
    }
    case "polyline":
    case "polygon": {
      const points = pointList(el.getAttribute("points"));
      const closed = el.localName === "polygon";
      const min = closed ? 3 : 2;
      const handles: Handle[] = points.map((p, i) => ({
        id: `pt:${i}`,
        x: p[0],
        y: p[1],
        role: "anchor" as const,
        removable: points.length > min,
      }));
      const gaps = closed ? points.length : points.length - 1;
      for (let i = 0; i < gaps; i++) {
        const mid = lerp(points[i]!, points[(i + 1) % points.length]!, 0.5);
        handles.push({ id: `add:${i}`, x: mid[0], y: mid[1], role: "add" });
      }
      return handles;
    }
    case "line":
      return [
        { id: "end:1", x: a("x1"), y: a("y1"), role: "anchor" },
        { id: "end:2", x: a("x2"), y: a("y2"), role: "anchor" },
      ];
    case "rect": {
      const [x, y, w, h] = [a("x"), a("y"), a("width"), a("height")];
      return [
        { id: "corner:0", x, y, role: "anchor" },
        { id: "corner:1", x: x + w, y, role: "anchor" },
        { id: "corner:2", x: x + w, y: y + h, role: "anchor" },
        { id: "corner:3", x, y: y + h, role: "anchor" },
      ];
    }
    case "circle": {
      const [cx, cy, r] = [a("cx"), a("cy"), a("r")];
      return [
        { id: "center", x: cx, y: cy, role: "anchor" },
        { id: "r", x: cx + r, y: cy, role: "control", links: [[cx, cy]] },
      ];
    }
    case "ellipse": {
      const [cx, cy, rx, ry] = [a("cx"), a("cy"), a("rx"), a("ry")];
      return [
        { id: "center", x: cx, y: cy, role: "anchor" },
        { id: "rx", x: cx + rx, y: cy, role: "control", links: [[cx, cy]] },
        { id: "ry", x: cx, y: cy + ry, role: "control", links: [[cx, cy]] },
      ];
    }
  }
  return [];
}

/** Moves point `id` of shape `el` (as it was when the drag started) to `to`, in its user units. */
export function moveHandle(el: Element, id: string, to: Point): void {
  const set = (name: string, value: number) => el.setAttribute(name, fmt(value));
  const [kind, at] = id.split(":");
  const index = Number(at);
  switch (el.localName) {
    case "path": {
      const commands = parsePath(el.getAttribute("d") ?? "");
      const c = commands[index];
      if (!c || c.type === "Z") return;
      if (kind === "to") {
        // Moving a point takes the control points next to it along, so its curves keep their shape.
        const dx = to[0] - c.to[0];
        const dy = to[1] - c.to[1];
        if (c.type === "C") c.c2 = [c.c2[0] + dx, c.c2[1] + dy];
        const next = commands[index + 1];
        if (next?.type === "C") next.c1 = [next.c1[0] + dx, next.c1[1] + dy];
        c.to = to;
      } else if (kind === "c1" && c.type === "C") c.c1 = to;
      else if (kind === "c2" && c.type === "C") c.c2 = to;
      else if (kind === "c" && c.type === "Q") c.c = to;
      el.setAttribute("d", serializePath(commands));
      return;
    }
    case "polyline":
    case "polygon": {
      const points = pointList(el.getAttribute("points"));
      if (!points[index]) return;
      points[index] = to;
      el.setAttribute("points", writePoints(points));
      return;
    }
    case "line":
      set(`x${index}`, to[0]);
      set(`y${index}`, to[1]);
      return;
    case "rect": {
      const [x, y, w, h] = ["x", "y", "width", "height"].map((n) => num(el.getAttribute(n)));
      const corners: Point[] = [
        [x!, y!],
        [x! + w!, y!],
        [x! + w!, y! + h!],
        [x!, y! + h!],
      ];
      const fixed = corners[(index + 2) % 4]!;
      set("x", Math.min(fixed[0], to[0]));
      set("y", Math.min(fixed[1], to[1]));
      set("width", Math.abs(to[0] - fixed[0]));
      set("height", Math.abs(to[1] - fixed[1]));
      return;
    }
    case "circle":
    case "ellipse": {
      const cx = num(el.getAttribute("cx"));
      const cy = num(el.getAttribute("cy"));
      if (kind === "center") {
        set("cx", to[0]);
        set("cy", to[1]);
      } else if (kind === "r") set("r", Math.hypot(to[0] - cx, to[1] - cy));
      else if (kind === "rx") set("rx", Math.abs(to[0] - cx));
      else if (kind === "ry") set("ry", Math.abs(to[1] - cy));
      return;
    }
  }
}

/** Takes point `id` out of shape `el`; false when the shape would no longer draw without it. */
export function removeHandle(el: Element, id: string): boolean {
  const handle = handlesOf(el).find((h) => h.id === id);
  if (!handle?.removable) return false;
  const index = Number(id.split(":")[1]);
  if (el.localName === "path") {
    const commands = parsePath(el.getAttribute("d") ?? "");
    const c = commands[index];
    if (!c || c.type === "Z") return false;
    if (c.type === "M") {
      // The subpath starts at the next point instead.
      const next = commands[index + 1];
      if (!next || next.type === "Z" || next.type === "M") commands.splice(index, next?.type === "Z" ? 2 : 1);
      else commands.splice(index, 2, { type: "M", to: next.to });
    } else commands.splice(index, 1);
    el.setAttribute("d", serializePath(commands));
    return true;
  }
  const points = pointList(el.getAttribute("points"));
  points.splice(index, 1);
  el.setAttribute("points", writePoints(points));
  return true;
}

/**
 * Adds a point at "add" handle `id`, halfway along its stretch of shape `el`, keeping the shape
 * as it was; gives the new point's handle id, or null.
 */
export function addHandle(el: Element, id: string): string | null {
  const [kind, at] = id.split(":");
  const index = Number(at);
  if (kind !== "add") return null;
  if (el.localName === "path") {
    const commands = parsePath(el.getAttribute("d") ?? "");
    const c = commands[index];
    const from = startsOf(commands)[index];
    if (!c || !from) return null;
    let added: PathCommand[];
    if (c.type === "L") added = [{ type: "L", to: lerp(from, c.to, 0.5) }, c];
    else if (c.type === "Z") added = [{ type: "L", to: lerp(from, subpathStart(commands, index), 0.5) }, c];
    else if (c.type === "C") {
      const [, b1, c1, m, b2, c2, d] = splitCubic(from, c.c1, c.c2, c.to);
      added = [
        { type: "C", c1: b1, c2: c1, to: m },
        { type: "C", c1: b2, c2, to: d },
      ];
    } else if (c.type === "Q") {
      const q1 = lerp(from, c.c, 0.5);
      const q2 = lerp(c.c, c.to, 0.5);
      added = [
        { type: "Q", c: q1, to: lerp(q1, q2, 0.5) },
        { type: "Q", c: q2, to: c.to },
      ];
    } else return null;
    commands.splice(index, 1, ...added);
    el.setAttribute("d", serializePath(commands));
    return `to:${index}`;
  }
  if (el.localName === "polyline" || el.localName === "polygon") {
    const points = pointList(el.getAttribute("points"));
    const a = points[index];
    const b = points[(index + 1) % points.length];
    if (!a || !b) return null;
    points.splice(index + 1, 0, lerp(a, b, 0.5));
    el.setAttribute("points", writePoints(points));
    return `pt:${index + 1}`;
  }
  return null;
}

// ---- Moving and styling elements

const LEADING_TRANSLATE = /^\s*translate\(\s*([-+.\deE]+)(?:[\s,]+([-+.\deE]+))?\s*\)\s*/;

/** Moves `el` by (dx, dy) in its parent's user units, with a `translate` before its transform. */
export function translateBy(el: Element, dx: number, dy: number): void {
  if (isSvgRoot(el) && !el.parentElement?.closest("svg")) return;
  const transform = el.getAttribute("transform") ?? "";
  const m = LEADING_TRANSLATE.exec(transform);
  const x = (m ? num(m[1]) : 0) + dx;
  const y = (m ? num(m[2]) : 0) + dy;
  const rest = m ? transform.slice(m[0].length) : transform.trim();
  const lead = x === 0 && y === 0 ? "" : `translate(${fmt(x)} ${fmt(y)})`;
  const next = [lead, rest].filter(Boolean).join(" ");
  if (next) el.setAttribute("transform", next);
  else el.removeAttribute("transform");
}

/**
 * Sets the presentation attribute `name` of `el` (an empty value removes it). An inline style
 * would override the attribute, so the same property is taken out of it.
 */
export function setPresentation(el: Element, name: string, value: string): void {
  const style = (el as SVGElement).style;
  if (style?.getPropertyValue(name)) {
    style.removeProperty(name);
    if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
  }
  if (value.trim()) el.setAttribute(name, value.trim());
  else el.removeAttribute(name);
}

/** The value of presentation property `name` on `el`: its inline style's, else its attribute's. */
export function presentationOf(el: Element, name: string): string {
  return (el as SVGElement).style?.getPropertyValue(name) || el.getAttribute(name) || "";
}

/** `#rrggbb` for a plain color value, for a color picker; null for none, gradients or variables. */
export function hexOf(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(v);
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
}

/** Moves `el` one step later (`forward`, drawn above) or earlier among its siblings. */
export function restack(el: Element, forward: boolean): boolean {
  const sibling = forward ? el.nextElementSibling : el.previousElementSibling;
  if (!sibling || !el.parentNode) return false;
  if (forward) sibling.after(el);
  else sibling.before(el);
  return true;
}

// ---- Showing the drawing in the app

/** Elements that would run code or load pages if shown in the app. */
const UNSAFE = /^(script|iframe|object|embed)$/i;

/**
 * A copy of the drawing that is safe to show in the app: no scripts, event handlers or
 * `javascript:` links, and relative links resolved by `resolve` (against the deck). Unsafe
 * elements become empty groups, so each element is at the same index as in the drawing.
 */
export function displayCopy(svg: Element, resolve: (url: string) => string): Element {
  const copy = svg.cloneNode(true) as Element;
  for (const el of elementsOf(copy)) {
    if (UNSAFE.test(el.localName)) {
      const group = el.ownerDocument.createElementNS(SVG_NS, "g");
      group.append(...[...el.childNodes].filter((n) => n.nodeType === Node.ELEMENT_NODE));
      el.replaceWith(group);
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if (/(^|:)href$|^src$/.test(name)) {
        const value = attr.value.trim();
        if (/^\s*javascript:/i.test(value)) el.removeAttribute(attr.name);
        else if (value && !/^([a-z][a-z\d+.-]*:|#|\/\/)/i.test(value)) el.setAttribute(attr.name, resolve(value));
      }
    }
  }
  return copy;
}

/**
 * The viewBox to show the drawing with at any zoom: its own, or else the user space it has at
 * its size on the slide (`size`, in slide pixels).
 */
export function viewBoxOf(svg: Element, size: { w: number; h: number }): string {
  const own = svg.getAttribute("viewBox");
  if (own && own.trim().split(/[\s,]+/).length === 4) return own;
  const length = (name: string, fallback: number) => {
    const v = svg.getAttribute(name);
    return v && /^\s*[\d.]+(px)?\s*$/.test(v) ? num(v, fallback) : fallback;
  };
  return `0 0 ${fmt(length("width", size.w) || 100)} ${fmt(length("height", size.h) || 100)}`;
}

// ---- Putting the drawing back on the slide

/** The drawing without its own attributes, to compare what it draws. */
function inner(svg: Element): Element {
  const copy = svg.cloneNode(true) as Element;
  for (const attr of [...copy.attributes]) copy.removeAttribute(attr.name);
  return copy;
}

/**
 * `slide` (a slide's markup) with the drawing at child-index `path` replaced by `draft`.
 * `original` is the drawing as the SVG editor got it: when the slide's drawing has moved or been
 * restyled on the slide since, only its own attributes differ, and those the editor left alone
 * keep the slide's values. When it is not where it was, the one drawing like it is used.
 */
export function replaceSvgInSlide(slide: string, path: number[] | null, original: string, draft: string): string {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${slide}</body></html>`, "text/html");
  const section = doc.body.firstElementChild;
  const before = parseSvg(original);
  const after = parseSvg(draft);
  if (!section || !before) throw new Error("The drawing could not be read.");
  if (!after) throw new Error("The SVG editor's markup is not one <svg> drawing.");
  const same = (el: Element) => el.isEqualNode(before);
  const moved = (el: Element) => inner(el).isEqualNode(inner(before));
  let target: Element | null = section;
  for (const i of path ?? []) target = target?.children[i] ?? null;
  const at = target && target !== section && isSvgRoot(target) ? target : null;
  const drawings = [...section.querySelectorAll("svg")].filter((el) => !el.parentElement?.closest("svg"));
  const pick = (match: (el: Element) => boolean) => {
    if (at && match(at)) return at;
    const found = drawings.filter(match);
    return found.length === 1 ? found[0]! : null;
  };
  const exact = pick(same);
  const found = exact ?? pick(moved);
  if (!found) throw new Error("The drawing has changed on the slide since it was opened in the SVG editor.");
  const node = doc.importNode(after, true);
  if (!exact) {
    // Its own attributes: the slide's, with what the SVG editor changed on top.
    for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
    for (const attr of [...found.attributes]) node.setAttribute(attr.name, attr.value);
    const names = new Set([...before.getAttributeNames(), ...after.getAttributeNames()]);
    for (const name of names) {
      const was = before.getAttribute(name);
      const now = after.getAttribute(name);
      if (was === now) continue;
      if (now === null) node.removeAttribute(name);
      else node.setAttribute(name, now);
    }
  }
  found.replaceWith(node);
  return section.outerHTML;
}
