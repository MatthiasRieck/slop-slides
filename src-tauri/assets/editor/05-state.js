  // ---- State: the slide and the pasteboard, constants (the figures' shapes among them), the
  // editor's styles and overlays, and what it is in the middle of.

  var slide = document.querySelector(".deck > .slide.active");
  var pasteboard = window.slopPasteboard;
  if (!slide || !pasteboard || window.parent === window) return;
  // One editor at a time, and only while the app wants one (see "Attaching and detaching").
  if (window.slopEditor || (typeof pasteboard.editorWanted === "function" && !pasteboard.editorWanted())) return;

  // What the editor puts on the page, the listeners it adds to the window and the document, and
  // what it says to the app go through these, so that detaching takes all of it away again and
  // nothing is said after (see 75-life.js).
  var detached = false;
  var listening = [];
  var added = [];
  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    listening.push([target, type, fn, options]);
  }
  function addToPage(parent, el) {
    parent.appendChild(el);
    added.push(el);
    return el;
  }
  function tellApp(message) {
    if (!detached) window.parent.postMessage(message, "*");
  }
  var overflow = window.__slopOverflow;
  // A group shows what it holds.
  var paints = function (el) {
    return el.hasAttribute(GROUP_ATTR) ? Array.prototype.some.call(el.children, paints) : overflow.paints(el);
  };
  var paintsBox = overflow.paintsBox;
  var nameOf = overflow.nameOf;

  // Attributes the editor adds while it works; stripped from the markup it saves.
  var EDITOR_ATTRS = [
    "contenteditable", "spellcheck", "data-slop-selected", "data-slop-hover", "data-slop-editing", "data-slop-typing", "data-slop-empty",
  ];
  var MOVED = "data-moved";
  var PLACEHOLDER = overflow.PLACEHOLDER;
  var DELETED = overflow.DELETED;
  var SLOTS = overflow.SLOTS;
  var DROPPED = "data-dropped";
  // What a line's ends are stuck to (see "Sticky ends").
  var ENDS = [
    { attr: "data-from", at: "data-from-at", first: true },
    { attr: "data-to", at: "data-to-at", first: false },
  ];
  var STUCK_ATTRS = ["data-from", "data-from-at", "data-to", "data-to-at"];
  // How far a press may move, in screen pixels (see onScreen), before it drags.
  var DRAG_THRESHOLD = 3;
  var DOUBLE_CLICK_MS = 400;
  var NUDGE_SAVE_MS = 500;
  var ROTATE_SNAP = 15;
  // Degrees of tilt per screen pixel dragged, and how far away the viewer of a tilt stands.
  var TILT_PER_PX = 0.5;
  var PERSPECTIVE = 1000;
  // A handle pulled on an element seen nearly edge-on moves it this much faster, at most.
  var MAX_SPREAD = 8;
  // The tilt the editor puts in front of an element's inline `transform`.
  var TILT = /^perspective\([\d.]+px\) rotateX\((-?[\d.]+)deg\) rotateY\((-?[\d.]+)deg\)\s*/;
  var MIN_SCALE = 0.1;
  var sizeMode = "resize";
  // Resizes keep the aspect ratio (Shift then frees it); see slop:edit-keep-ratio.
  var keepRatio = false;
  var ADDED = overflow.ADDED;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var TOOLS = [
    "select", "text", "rect", "rounded", "ellipse", "triangle", "star", "bubble", "diamond", "chevron", "block-arrow",
    "double-arrow", "hexagon", "octagon", "pentagon", "parallelogram", "trapezoid", "plus", "cylinder", "document", "heart",
    "bracket", "brace", "draw", "line", "arrow", "elbow", "curve", "paint",
  ];
  var RADIUS = { rect: "0px", rounded: "24px", ellipse: "50%" };
  var SHAPE_SIZE = { w: 320, h: 200 };
  var OUTLINE_SIZE = { w: 60, h: 200 };
  var DRAW_STEP = 2;
  var BORDER_WIDTH = 4;
  var BORDER_COLOR = "#111111";
  // The toolbar's default ink, and what it turns into on a dark ground (see readable()).
  var DEFAULT_INK = /^#111(111)?$/i;
  var INK_ON_DARK = "#ffffff";
  // What a new element gets for anything the app's style leaves out.
  var FALLBACK_STYLE = { color: "#111111", fontSize: 48, align: "left", valign: "top", stroke: "#111111", strokeWidth: 4 };
  var JUSTIFY = { top: "flex-start", middle: "center", bottom: "flex-end" };
  // Non-positioned elements paint below positioned ones at z-index 0 and above those below it.
  var STATIC_Z = -0.5;
  // A dropped image fits in a third of the slide's width and half its height; images dropped
  // together fan out by this many slide pixels. Without a known size, it is this wide.
  var DROP_CASCADE = 40;
  var DROP_WIDTH = 640;
  // Starts a copied element's markup; a JSON header with where it came from follows (see copySelected).
  var CLIP_MARKER = "<!--slopslides:";
  // Text styles a copied element takes along to another slide, where the deck's CSS may differ.
  var LOOK = ["color", "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "textAlign", "textTransform"];
  // A long pasted text wraps at this share of the slide's width.
  var PASTE_TEXT_WIDTH = 0.6;
  // An arrow's head: this long (at least, and per unit of line width), this far off the line.
  var ARROW_HEAD_MIN = 24;
  var ARROW_HEAD_PER_WIDTH = 4;
  var ARROW_HEAD_ANGLE = Math.PI / 6;
  // What a line can end in (see "Lines"): an open arrowhead, a filled triangle, a bar across
  // the end or a dot on it. Each is a <path> of its own with `data-head="<end> <kind>"`.
  var HEADS = { arrow: true, triangle: true, bar: true, dot: true };
  var HEAD_ATTR = "data-head";
  // A connector's route between its ends, instead of straight or curved through its points.
  var ROUTES = { elbow: true, curved: true };
  var ROUTE_ATTR = "data-route";
  // How far an elbow connector leaves the element it is stuck to before it turns.
  var ELBOW_STUB = 24;
  // How a line or border is drawn: dashes and dots as multiples of its width.
  var DASHES = { solid: true, dashed: true, dotted: true };
  // Spots checked along each stretch of a curved line for the box around it.
  var LINE_SAMPLES = 16;
  // A line is picked within this many screen pixels of its stroke or heads, not anywhere in its
  // box, so a line lying over (or under) another one leaves it clickable.
  var LINE_HIT_SLOP = 6;
  // Shapes drawn by an SVG in their box's background (see "Figures"), as path data in the box's
  // own pixels (w × h), so a head or notch keeps its size as the box stretches. A figure that
  // has an `adjust` takes a number in `data-adjust` (its default when it has none) for its
  // proportions, as a share of its height (a chevron's notch, an arrow's head), or for a star
  // its points; `handle` puts the yellow handle that drags it, `fromHandle` reads it back.
  // `inset` is how far (top, right, bottom, left) the text keeps clear of the box, so it stays
  // inside the shape. `rim` is more stroke, drawn inside the shape (a cylinder's top).
  var KAPPA = 0.5523;
  function pt(x, y) {
    return roundTenth(x) + " " + roundTenth(y);
  }
  function poly(points) {
    return points.map(function (p, i) {
      return (i ? "L" : "M") + pt(p[0], p[1]);
    }).join(" ") + " Z";
  }
  function share(a) {
    return a / 100;
  }
  function insets(w, h, t, r, b, l) {
    return [t * h, r * w, b * h, l * w];
  }
  var FIGURES = {
    triangle: {
      adjust: { value: 50, min: 0, max: 100, step: 1, label: "Apex" },
      path: function (w, h, a) {
        return poly([[share(a) * w, 0], [w, h], [0, h]]);
      },
      inset: function (w, h) {
        return insets(w, h, 0.42, 0.22, 0.06, 0.22);
      },
      handle: function (w, h, a) {
        return [share(a) * w, 0];
      },
      fromHandle: function (w, h, p) {
        return (p[0] / w) * 100;
      },
    },
    star: {
      adjust: { value: 5, min: 3, max: 12, step: 1, label: "Points" },
      path: function (w, h, a) {
        var n = Math.round(a);
        // A five-pointed star's inner points lie where its outer ones' lines cross.
        var inner = n <= 5 ? 0.382 : 0.5;
        var points = [];
        for (var i = 0; i < 2 * n; i++) {
          var angle = -Math.PI / 2 + (i * Math.PI) / n;
          var r = i % 2 ? inner : 1;
          points.push([w / 2 + (w / 2) * r * Math.cos(angle), h / 2 + (h / 2) * r * Math.sin(angle)]);
        }
        return poly(points);
      },
      inset: function (w, h) {
        return insets(w, h, 0.32, 0.27, 0.3, 0.27);
      },
    },
    bubble: {
      adjust: { value: 22, min: 0, max: 100, step: 1, label: "Tail" },
      path: function (w, h, a) {
        var rx = 0.08 * w;
        var ry = 0.08 * h;
        var body = 0.8 * h;
        var tip = share(a) * w;
        // The tail leaves the body's bottom edge next to where it points.
        var left = Math.min(0.7, Math.max(0.1, share(a) + 0.03)) * w;
        var right = left + 0.2 * w;
        return (
          "M" + pt(rx, 0) + " L" + pt(w - rx, 0) + " Q" + pt(w, 0) + " " + pt(w, ry) + " L" + pt(w, body - ry) +
          " Q" + pt(w, body) + " " + pt(w - rx, body) + " L" + pt(right, body) + " L" + pt(tip, h) + " L" + pt(left, body) +
          " L" + pt(rx, body) + " Q" + pt(0, body) + " " + pt(0, body - ry) + " L" + pt(0, ry) + " Q" + pt(0, 0) + " " + pt(rx, 0) + " Z"
        );
      },
      inset: function (w, h) {
        return insets(w, h, 0.06, 0.05, 0.26, 0.05);
      },
      handle: function (w, h, a) {
        return [share(a) * w, h];
      },
      fromHandle: function (w, h, p) {
        return (p[0] / w) * 100;
      },
    },
    diamond: {
      path: function (w, h) {
        return poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]);
      },
      inset: function (w, h) {
        return insets(w, h, 0.25, 0.25, 0.25, 0.25);
      },
    },
    chevron: {
      adjust: { value: 40, min: 0, max: 200, step: 1, label: "Point" },
      path: function (w, h, a) {
        var d = Math.min(w / 2, share(a) * h);
        return poly([[0, 0], [w - d, 0], [w, h / 2], [w - d, h], [0, h], [d, h / 2]]);
      },
      inset: function (w, h, a) {
        var d = Math.min(w / 2, share(a) * h);
        return [0.08 * h, 1.08 * d, 0.08 * h, 1.08 * d];
      },
      handle: function (w, h, a) {
        return [w - Math.min(w / 2, share(a) * h), 0];
      },
      fromHandle: function (w, h, p) {
        return ((w - p[0]) / h) * 100;
      },
    },
    "block-arrow": {
      adjust: { value: 56, min: 0, max: 400, step: 1, label: "Head" },
      path: function (w, h, a) {
        var head = Math.min(w, share(a) * h);
        return poly([[0, 0.25 * h], [w - head, 0.25 * h], [w - head, 0], [w, h / 2], [w - head, h], [w - head, 0.75 * h], [0, 0.75 * h]]);
      },
      inset: function (w, h, a) {
        return [0.27 * h, 0.86 * Math.min(w, share(a) * h), 0.27 * h, 0.04 * w];
      },
      handle: function (w, h, a) {
        return [w - Math.min(w, share(a) * h), 0];
      },
      fromHandle: function (w, h, p) {
        return ((w - p[0]) / h) * 100;
      },
    },
    "double-arrow": {
      adjust: { value: 40, min: 0, max: 200, step: 1, label: "Heads" },
      path: function (w, h, a) {
        var head = Math.min(w / 2, share(a) * h);
        return poly([
          [0, h / 2], [head, 0], [head, 0.25 * h], [w - head, 0.25 * h], [w - head, 0], [w, h / 2], [w - head, h],
          [w - head, 0.75 * h], [head, 0.75 * h], [head, h],
        ]);
      },
      inset: function (w, h, a) {
        var head = Math.min(w / 2, share(a) * h);
        return [0.27 * h, 0.88 * head, 0.27 * h, 0.88 * head];
      },
      handle: function (w, h, a) {
        return [Math.min(w / 2, share(a) * h), 0];
      },
      fromHandle: function (w, h, p) {
        return (p[0] / h) * 100;
      },
    },
    hexagon: {
      adjust: { value: 29, min: 0, max: 100, step: 1, label: "Corners" },
      path: function (w, h, a) {
        var c = Math.min(w / 2, share(a) * h);
        return poly([[c, 0], [w - c, 0], [w, h / 2], [w - c, h], [c, h], [0, h / 2]]);
      },
      inset: function (w, h, a) {
        var c = Math.min(w / 2, share(a) * h);
        return [0.08 * h, c, 0.08 * h, c];
      },
      handle: function (w, h, a) {
        return [Math.min(w / 2, share(a) * h), 0];
      },
      fromHandle: function (w, h, p) {
        return (p[0] / h) * 100;
      },
    },
    octagon: {
      adjust: { value: 29, min: 0, max: 50, step: 1, label: "Corners" },
      path: function (w, h, a) {
        var c = Math.min(w / 2, h / 2, share(a) * Math.min(w, h));
        return poly([[c, 0], [w - c, 0], [w, c], [w, h - c], [w - c, h], [c, h], [0, h - c], [0, c]]);
      },
      inset: function (w, h, a) {
        var c = Math.min(w / 2, h / 2, share(a) * Math.min(w, h)) / 2;
        return [c, c, c, c];
      },
      handle: function (w, h, a) {
        return [Math.min(w / 2, h / 2, share(a) * Math.min(w, h)), 0];
      },
      fromHandle: function (w, h, p) {
        return (p[0] / Math.min(w, h)) * 100;
      },
    },
    pentagon: {
      path: function (w, h) {
        return poly([[w / 2, 0], [w, 0.38 * h], [0.81 * w, h], [0.19 * w, h], [0, 0.38 * h]]);
      },
      inset: function (w, h) {
        return insets(w, h, 0.3, 0.2, 0.05, 0.2);
      },
    },
    parallelogram: {
      adjust: { value: 25, min: 0, max: 200, step: 1, label: "Slant" },
      path: function (w, h, a) {
        var s = Math.min(w, share(a) * h);
        return poly([[s, 0], [w, 0], [w - s, h], [0, h]]);
      },
      inset: function (w, h, a) {
        var s = 0.8 * Math.min(w, share(a) * h);
        return [0.08 * h, s, 0.08 * h, s];
      },
      handle: function (w, h, a) {
        return [Math.min(w, share(a) * h), 0];
      },
      fromHandle: function (w, h, p) {
        return (p[0] / h) * 100;
      },
    },
    trapezoid: {
      adjust: { value: 25, min: 0, max: 100, step: 1, label: "Slope" },
      path: function (w, h, a) {
        var t = Math.min(w / 2, share(a) * h);
        return poly([[t, 0], [w - t, 0], [w, h], [0, h]]);
      },
      inset: function (w, h, a) {
        var t = 0.8 * Math.min(w / 2, share(a) * h);
        return [0.08 * h, t, 0.08 * h, t];
      },
      handle: function (w, h, a) {
        return [Math.min(w / 2, share(a) * h), 0];
      },
      fromHandle: function (w, h, p) {
        return (p[0] / h) * 100;
      },
    },
    plus: {
      adjust: { value: 30, min: 0, max: 50, step: 1, label: "Arms" },
      path: function (w, h, a) {
        var c = Math.min(w / 2, h / 2, share(a) * Math.min(w, h));
        return poly([
          [c, 0], [w - c, 0], [w - c, c], [w, c], [w, h - c], [w - c, h - c], [w - c, h], [c, h], [c, h - c], [0, h - c],
          [0, c], [c, c],
        ]);
      },
      inset: function (w, h, a) {
        var c = Math.min(w / 2, h / 2, share(a) * Math.min(w, h));
        return [c, c, c, c];
      },
      handle: function (w, h, a) {
        return [Math.min(w / 2, h / 2, share(a) * Math.min(w, h)), 0];
      },
      fromHandle: function (w, h, p) {
        return (p[0] / Math.min(w, h)) * 100;
      },
    },
    cylinder: {
      adjust: { value: 12, min: 0, max: 50, step: 1, label: "Top" },
      path: function (w, h, a) {
        var ry = Math.min(h / 2, share(a) * h);
        var kx = (KAPPA * w) / 2;
        var ky = KAPPA * ry;
        return (
          "M" + pt(0, ry) + " C" + pt(0, ry - ky) + " " + pt(w / 2 - kx, 0) + " " + pt(w / 2, 0) + " C" + pt(w / 2 + kx, 0) + " " +
          pt(w, ry - ky) + " " + pt(w, ry) + " L" + pt(w, h - ry) + " C" + pt(w, h - ry + ky) + " " + pt(w / 2 + kx, h) + " " +
          pt(w / 2, h) + " C" + pt(w / 2 - kx, h) + " " + pt(0, h - ry + ky) + " " + pt(0, h - ry) + " Z"
        );
      },
      rim: function (w, h, a) {
        var ry = Math.min(h / 2, share(a) * h);
        var kx = (KAPPA * w) / 2;
        var ky = KAPPA * ry;
        return (
          "M" + pt(0, ry) + " C" + pt(0, ry + ky) + " " + pt(w / 2 - kx, 2 * ry) + " " + pt(w / 2, 2 * ry) + " C" +
          pt(w / 2 + kx, 2 * ry) + " " + pt(w, ry + ky) + " " + pt(w, ry)
        );
      },
      inset: function (w, h, a) {
        var ry = Math.min(h / 2, share(a) * h);
        return [2.2 * ry, 0.05 * w, 1.2 * ry, 0.05 * w];
      },
      handle: function (w, h, a) {
        return [w / 2, 2 * Math.min(h / 2, share(a) * h)];
      },
      fromHandle: function (w, h, p) {
        return (p[1] / 2 / h) * 100;
      },
    },
    document: {
      adjust: { value: 8, min: 0, max: 25, step: 1, label: "Wave" },
      path: function (w, h, a) {
        var wave = Math.min(h / 4, share(a) * h);
        return (
          "M0 0 L" + pt(w, 0) + " L" + pt(w, h - wave) + " Q" + pt(0.75 * w, h - 3 * wave) + " " + pt(w / 2, h - wave) +
          " Q" + pt(0.25 * w, h + wave) + " " + pt(0, h - wave) + " Z"
        );
      },
      inset: function (w, h, a) {
        var wave = Math.min(h / 4, share(a) * h);
        return [0.06 * h, 0.05 * w, 2 * wave + 0.04 * h, 0.05 * w];
      },
      handle: function (w, h, a) {
        return [0.75 * w, h - 2 * Math.min(h / 4, share(a) * h)];
      },
      fromHandle: function (w, h, p) {
        return ((h - p[1]) / 2 / h) * 100;
      },
    },
    heart: {
      path: function (w, h) {
        var c = function (x1, y1, x2, y2, x, y) {
          return " C" + pt(x1 * w, y1 * h) + " " + pt(x2 * w, y2 * h) + " " + pt(x * w, y * h);
        };
        return (
          "M" + pt(0.5 * w, 0.25 * h) + c(0.5, 0.1, 0.38, 0, 0.25, 0) + c(0.1, 0, 0, 0.12, 0, 0.3) + c(0, 0.55, 0.25, 0.75, 0.5, 1) +
          c(0.75, 0.75, 1, 0.55, 1, 0.3) + c(1, 0.12, 0.9, 0, 0.75, 0) + c(0.62, 0, 0.5, 0.1, 0.5, 0.25) + " Z"
        );
      },
      inset: function (w, h) {
        return insets(w, h, 0.22, 0.18, 0.3, 0.18);
      },
    },
  };
  var SHAPE_ATTR = "data-shape";
  var ADJUST_ATTR = "data-adjust";
  // A group the user made (see "Groups, locks and layers"), and an element they locked.
  var GROUP_ATTR = "data-group";
  var LOCK_ATTR = "data-lock";
  // A figure's text keeps at least this far from its box.
  var FIGURE_PADDING = 8;
  // The `clip-path` cut-outs earlier versions made, which the editor redraws as figures when it changes one.
  var CUT_OUTS = {
    triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
    star: "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)",
    bubble:
      "polygon(8% 0%, 92% 0%, 96% 1.1%, 98.9% 4%, 100% 8%, 100% 72%, 98.9% 76%, 96% 78.9%, 92% 80%, 45% 80%, 22% 100%," +
      " 25% 80%, 8% 80%, 4% 78.9%, 1.1% 76%, 0% 72%, 0% 8%, 1.1% 4%, 4% 1.1%)",
  };
  // Open shapes, drawn as a drawing's one stroke through the box they are dragged out to.
  var OUTLINES = { bracket: true, brace: true };
  // Fully transparent elements can no longer be picked.
  var MIN_OPACITY = 0.05;
  var SHADOW_COLOR = "rgba(0, 0, 0, 0.35)";
  // The blur in a CSS shadow's lengths; a drop-shadow() the editor adds to an element's filter.
  var SHADOW_LENGTHS = /-?[\d.]+px\s+-?[\d.]+px\s+([\d.]+)px/;
  var SHADOW_FILTER = /drop-shadow\((?:[^()]|\([^()]*\))*\)/;
  var MAX_DECK_COLORS = 12;
  // At most this many CSS variables go along with a drawing to the SVG editor.
  var MAX_SVG_VARS = 200;
  // ... and at most this many of the elements it sits in.
  var MAX_SVG_ANCESTORS = 64;
  // What the format painter takes from text.
  var PAINTED_TEXT = ["color", "fontSize", "weight", "italic", "underline", "strike", "letterSpacing", "lineHeight", "align", "textCase"];

  // The handles: a corner's side and an edge handle's length, the gap they keep to the frame, and
  // how far the rotate handle stands off it, in screen pixels.
  var HANDLE = 10;
  var HANDLE_LONG = 16;
  var HANDLE_GAP = 2;
  var ROTATE_STEM = 24;
  // An element narrower or flatter than this on screen has no room for edge handles between its corners.
  var EDGE_HANDLE_ROOM = 40;

  /**
   * A CSS length of `n` screen pixels. The app shows the preview scaled to fit the stage, so what
   * the editor draws over the slide is sized by `--slop-ui` (see pasteboard.js): this window's
   * pixels per screen pixel.
   */
  function px(n) {
    return "calc(" + n + "px * var(--slop-ui, 1))";
  }

  // The line around what is selected, hovered or being typed in: the accent between two light
  // lines, so it shows on any slide, light, dark or the accent's own color.
  var HALO = "color-mix(in srgb, var(--slop-handle) 85%, transparent)";
  var FRAME_LINE =
    " outline: " + px(1.5) + " solid var(--slop-accent); box-shadow: 0 0 0 " + px(2.5) + " " + HALO + ", inset 0 0 0 " + px(1) + " " + HALO + ";";
  // Where each resize handle sits: just outside its corner or the middle of its side.
  var HANDLE_DIRS = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  var handlePlaces = HANDLE_DIRS.map(function (d) {
    var w = d[0] === 0 ? HANDLE_LONG : HANDLE;
    var h = d[1] === 0 ? HANDLE_LONG : HANDLE;
    var outside = function (dir, size) {
      return px(dir < 0 ? -size - HANDLE_GAP : dir > 0 ? HANDLE_GAP : -size / 2);
    };
    return (
      '[data-slop-ui] [data-dir="' + d[0] + " " + d[1] + '"] { left: ' + (d[0] + 1) * 50 + "%; top: " + (d[1] + 1) * 50 + "%; margin: " +
      outside(d[1], h) + " 0 0 " + outside(d[0], w) + "; }"
    );
  }).join("");
  var LOCK_ICON =
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.5'" +
    " stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='5' y='11' width='14' height='10' rx='2'/%3E%3Cpath d='M8 11V7a4 4 0 0 1 8 0v4'/%3E%3C/svg%3E\")";

  var style = document.createElement("style");
  style.textContent =
    // The slide shows what runs past its edge.
    ".deck, .deck > .slide.active { overflow: visible !important; }" +
    ".deck > .slide.active, .deck > .slide.active * { -webkit-user-select: none; user-select: none; }" +
    // A hovered line has no box to outline: it glows along its stroke instead. Anything else is
    // outlined by an overlay (see hover), as the selection is, so the line keeps its size on screen.
    "[data-slop-hover=line] { filter: drop-shadow(0 0 2px var(--slop-accent)) drop-shadow(0 0 2px var(--slop-accent)) !important; }" +
    "[data-slop-selected] { cursor: move !important; }" +
    // A locked element does not move.
    "[data-lock][data-slop-selected], [data-lock] [data-slop-selected] { cursor: default !important; }" +
    "[data-slop-ui], [data-slop-outline] { position: fixed; pointer-events: none; box-sizing: border-box;" + FRAME_LINE + " }" +
    "[data-slop-ui] { z-index: 2147483647; }" +
    // What is hovered, and the text being typed in: the same line, without handles.
    "[data-slop-outline] { z-index: 2147483646; display: none; }" +
    "[data-slop-outline=hover] { outline-color: color-mix(in srgb, var(--slop-accent) 75%, var(--slop-handle)); }" +
    // The group gone into (with a double-click) stays marked while what it holds is worked on.
    "[data-slop-outline=group] { z-index: 2147483645; outline-style: dashed; outline-width: " + px(1) + "; }" +
    // An empty text box says what it is for, until something is typed in it.
    "[data-slop-empty][data-slop-editing] { min-width: 5em; }" +
    "[data-slop-empty][data-slop-editing] > [data-text-body]::before { content: 'Type text'; display: inline-block; width: 0; white-space: nowrap;" +
    " opacity: 0.45; pointer-events: none; }" +
    "[data-slop-ui] * { position: absolute; box-sizing: border-box; }" +
    "[data-slop-ui] [data-handle] { pointer-events: auto; background: var(--slop-handle);" +
    " border: " + px(1.5) + " solid var(--slop-accent); box-shadow: 0 " + px(1) + " " + px(3) + " var(--slop-scrim); touch-action: none;" +
    " width: " + px(HANDLE) + "; height: " + px(HANDLE) + "; }" +
    // Small as a handle looks, it can be grabbed a little way off it.
    "[data-slop-ui] [data-handle]::before { content: ''; position: absolute; inset: " + px(-5) + "; }" +
    "[data-slop-ui] [data-handle=scale] { border-radius: " + px(2) + "; }" +
    "[data-slop-ui] [data-axis] { border-radius: " + px(HANDLE / 2) + "; }" +
    "[data-slop-ui] [data-axis=x] { height: " + px(HANDLE_LONG) + "; }" +
    "[data-slop-ui] [data-axis=y] { width: " + px(HANDLE_LONG) + "; }" +
    handlePlaces +
    "[data-slop-ui][data-narrow] [data-axis=y], [data-slop-ui][data-flat] [data-axis=x] { display: none; }" +
    "[data-slop-ui] > [data-handle=rotate] { border-radius: 50%; width: " + px(12) + "; height: " + px(12) + "; margin: 0 0 0 " + px(-6) + ";" +
    " left: 50%; top: " + px(-ROTATE_STEM - 12) + "; cursor: grab; }" +
    // The tilt is rarely wanted: its handle stands below the frame, well away from the one that turns.
    "[data-slop-ui] > [data-handle=tilt] { width: " + px(HANDLE) + "; height: " + px(HANDLE) + "; margin: 0 0 0 " + px(-HANDLE / 2) + "; left: 50%;" +
    " top: calc(100% + " + (ROTATE_STEM + 2) + "px * var(--slop-ui, 1)); transform: rotate(45deg); cursor: move; }" +
    // A figure's proportions (see FIGURES), on the spot they change.
    "[data-slop-ui] > [data-handle=adjust] { margin: " + px(-HANDLE / 2) + " 0 0 " + px(-HANDLE / 2) + "; transform: rotate(45deg);" +
    " background: var(--slop-search); border-color: var(--slop-accent); cursor: pointer; }" +
    "[data-slop-ui] > [data-handle=adjust][hidden], [data-slop-ui][data-locked] [data-handle]," +
    " [data-slop-ui][data-locked] [data-stem], [data-slop-ui][data-multi] > [data-handle=tilt] { display: none; }" +
    // A locked selection says so at its corner, where a click unlocks it.
    "[data-slop-ui] > [data-lock-mark] { display: none; pointer-events: auto; cursor: pointer; left: 100%; top: 0; width: " + px(20) + ";" +
    " height: " + px(20) + "; margin: " + px(-10) + " 0 0 " + px(-10) + "; padding: 0; border: 0; border-radius: 50%; background: var(--slop-overlay);" +
    " box-shadow: 0 " + px(1) + " " + px(3) + " var(--slop-scrim); }" +
    "[data-slop-ui] > [data-lock-mark]::before { content: ''; inset: 0; background: var(--slop-overlay-foreground);" +
    " -webkit-mask: " + LOCK_ICON + " center / 60% no-repeat; mask: " + LOCK_ICON + " center / 60% no-repeat; }" +
    "[data-slop-ui][data-locked] > [data-lock-mark] { display: block; }" +
    // A line's points, in place of the frame and handles.
    "[data-slop-points] { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }" +
    "[data-slop-points] > * { position: absolute; box-sizing: border-box; pointer-events: auto; touch-action: none; cursor: move;" +
    " width: " + px(HANDLE) + "; height: " + px(HANDLE) + "; margin: " + px(-HANDLE / 2) + " 0 0 " + px(-HANDLE / 2) + "; border-radius: 50%;" +
    " background: var(--slop-handle); border: " + px(1.5) + " solid var(--slop-accent); box-shadow: 0 " + px(1) + " " + px(3) + " var(--slop-scrim); }" +
    "[data-slop-points] > [data-bound] { background: var(--slop-accent); border-color: var(--slop-handle); }" +
    // Each point can be grabbed a little way off it, the bend handles too, small as they look.
    "[data-slop-points] > *::before { content: ''; position: absolute; inset: " + px(-6) + "; border-radius: 50%; }" +
    "[data-slop-points] > [data-point=add] { background: var(--slop-accent); border-color: var(--slop-handle); cursor: crosshair; }" +
    // A small + in each bend handle says dragging it adds a point.
    "[data-slop-points] > [data-point=add]::after { content: ''; position: absolute; inset: 0; pointer-events: none;" +
    " background: linear-gradient(var(--slop-handle), var(--slop-handle)) center / " + px(5) + " " + px(1.5) + " no-repeat," +
    " linear-gradient(var(--slop-handle), var(--slop-handle)) center / " + px(1.5) + " " + px(5) + " no-repeat; }" +
    // The button that opens the selected drawing in the app's SVG editor.
    "[data-slop-svg-open] { position: fixed; z-index: 2147483647; display: flex; align-items: center; gap: " + px(4) + ";" +
    " margin: 0; padding: " + px(3) + " " + px(7) + " " + px(3) + " " + px(9) + "; border: 0; border-radius: " + px(999) + "; background: var(--slop-accent);" +
    " color: var(--slop-handle); font: 600 " + px(11) + "/" + px(16) + " system-ui, sans-serif; white-space: nowrap; cursor: pointer;" +
    " box-shadow: 0 " + px(1) + " " + px(4) + " var(--slop-scrim); }" +
    "[data-slop-svg-open] svg { width: " + px(12) + "; height: " + px(12) + "; }" +
    "[data-slop-svg-open]:hover { filter: brightness(1.1); }" +
    "[data-slop-svg-open][hidden] { display: none; }" +
    "[data-slop-overflow] { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }" +
    // The outline of the element a line's end would stick to the edge of, and the spot on it.
    "[data-slop-edge] { position: fixed; left: 0; top: 0; width: 100%; height: 100%; overflow: visible; z-index: 2147483646; pointer-events: none; }" +
    "[data-slop-edge] path { fill: none; stroke: var(--slop-accent); stroke-width: " + px(2) + "; stroke-linejoin: round; }" +
    "[data-slop-edge] circle { fill: var(--slop-accent); stroke: var(--slop-handle); stroke-width: " + px(1.5) + "; r: " + px(4) + "; }" +
    "[data-slop-edge] circle[data-site] { fill: var(--slop-handle); stroke: var(--slop-accent); r: " + px(3.5) + "; }" +
    "[data-slop-edge] circle[data-site=on] { fill: var(--slop-accent); stroke: var(--slop-handle); r: " + px(5) + "; }" +
    "[data-slop-overflow][data-quiet] { display: none; }" +
    "[data-slop-overflow] > * { position: absolute; box-sizing: border-box; }" +
    "[data-slop-overflow] > [data-wire] { outline: " + px(1.5) + " dashed var(--slop-danger); outline-offset: " + px(-0.5) + ";" +
    " background: color-mix(in srgb, var(--slop-danger) 8%, transparent); }" +
    // The slide's frame marks edit mode, and dims everything outside the slide.
    "[data-slop-frame] { outline: " + px(1.5) + " solid var(--slop-accent); outline-offset: " + px(3) + "; box-shadow: 0 0 0 9999px" +
    " color-mix(in srgb, var(--slop-canvas) 55%, transparent); }" +
    // A drawing or shape tool draws wherever the pointer goes.
    "html[data-slop-tool], html[data-slop-tool] * { cursor: crosshair !important; }" +
    "html[data-slop-tool=text], html[data-slop-tool=text] * { cursor: text !important; }" +
    "html[data-slop-tool=paint], html[data-slop-tool=paint] * { cursor: copy !important; }" +
    "[data-slop-ui] > [data-stem] { pointer-events: none; width: " + px(1.5) + "; height: " + px(ROTATE_STEM) + "; margin: 0 0 0 " + px(-0.75) + ";" +
    " left: 50%; top: " + px(-ROTATE_STEM) + "; border: 0; box-shadow: none; background: var(--slop-accent); }" +
    // While typing, overlays (like invisible hover zones) let clicks through to the text.
    ".deck > .slide.active[data-slop-typing] * { pointer-events: none !important; }" +
    ".deck > .slide.active[data-slop-typing] [data-slop-editing]," +
    " .deck > .slide.active[data-slop-typing] [data-slop-editing] * { pointer-events: auto !important; }" +
    ".deck > .slide.active [data-slop-editing], .deck > .slide.active [data-slop-editing] * {" +
    " -webkit-user-select: text; user-select: text; cursor: text !important; }";
  addToPage(document.head, style);

  // Scale, rotate, and tilt handles, outside the slide so they never end up in its markup. They
  // sit just outside the frame, so even small text stays clickable (and double-clickable) inside
  // it. The frame turns with a rotation but stays flat under a 3D tilt, around the extent of the
  // perspective, so its handles can be grabbed and pull the way they point however far the
  // element is tilted, even turned over. Around several selected elements it is the box around
  // them all, upright, and its handles resize and turn them together.
  var ui = document.createElement("div");
  ui.setAttribute("data-slop-ui", "");
  ui.style.display = "none";
  ui.innerHTML =
    '<div data-stem></div><div data-handle="rotate" title="Rotate (Shift snaps to 15°, double-click resets)"></div>' +
    '<div data-handle="tilt" title="Tilt in 3D (Shift snaps to 15°, double-click resets)"></div>' +
    '<div data-handle="adjust" title="Drag to change the shape (double-click resets)"></div>' +
    '<button type="button" data-lock-mark title="Locked: click to unlock" aria-label="Unlock"></button>' +
    HANDLE_DIRS.map(function (d) {
      var axis = d[0] === 0 ? ' data-axis="y"' : d[1] === 0 ? ' data-axis="x"' : "";
      return (
        '<div data-handle="scale" data-dir="' + d[0] + " " + d[1] + '"' + axis +
        ' title="Resize (Shift keeps the aspect ratio, Alt resizes from the center)"></div>'
      );
    }).join("");
  addToPage(document.body, ui);
  var scaleHandles = Array.prototype.slice.call(ui.querySelectorAll("[data-handle=scale]"));

  // The line around what is hovered, and around the text being typed in (see FRAME_LINE).
  function outlineBox(kind) {
    var box = document.createElement("div");
    box.setAttribute("data-slop-outline", kind);
    addToPage(document.body, box);
    return box;
  }
  var hoverBox = outlineBox("hover");
  var editBox = outlineBox("edit");
  var groupBox = outlineBox("group");

  var pointUi = document.createElement("div");
  pointUi.setAttribute("data-slop-points", "");
  addToPage(document.body, pointUi);

  var edgeUi = document.createElementNS(SVG_NS, "svg");
  edgeUi.setAttribute("data-slop-edge", "");
  addToPage(document.body, edgeUi);

  var svgButton = document.createElement("button");
  svgButton.type = "button";
  svgButton.setAttribute("data-slop-svg-open", "");
  svgButton.title = "Open the drawing in the SVG editor, in the sidebar";
  svgButton.innerHTML =
    'Edit SVG<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  svgButton.hidden = true;
  addToPage(document.body, svgButton);

  var wires = document.createElement("div");
  wires.setAttribute("data-slop-overflow", "");
  addToPage(document.body, wires);

  // The runtime's text fit (data-autofit="shrink"); see runtime.js.
  var autofit = window.slopAutofit || null;
  // Inline elements: text runs that formatting splits and wraps. Anything else is a block.
  var INLINE = /^(a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|font|i|ins|kbd|mark|q|s|samp|small|span|strike|strong|sub|sup|time|u|var)$/i;
  // The one block that holds the text of a text box or shape (see 00-header.js).
  var BODY_ATTR = "data-text-body";
  // Styles that apply to the selected text while typing; the others apply to the whole element.
  var TEXT_KEYS = ["color", "fontSize", "fontFamily", "bold", "weight", "italic", "underline", "strike", "script", "letterSpacing", "highlight", "textCase", "link"];
  var TOGGLES = { b: "bold", i: "italic", u: "underline" };
  var LIST_TYPES = { ul: ["disc", "circle", "square"], ol: ["decimal", "lower-alpha", "lower-roman"] };
  // Elements a paste never brings into text.
  var PASTE_SKIP = /^(script|style|meta|link|title|head|template|noscript|img|picture|svg|video|audio|canvas|iframe|object|embed|button|input|select|textarea)$/i;

  // The slide's markup as it was last saved, which a change is told from: taken once the page has
  // painted, or just before the first thing that could change the slide (see keepSaved).
  var saved = null;
  // The app's messages that only set how the editor works or what is selected, never the slide.
  var SETTINGS = /^slop:edit-(select|tool|snap|size-mode|keep-ratio)$/;
  var selected = null;
  var hovered = null;
  // Where the hovered element is, in slide pixels, when whoever hovered it knew (see hover).
  var hoveredFrame = null;
  var editing = null;
  var drag = null;
  var nudgeTimer = null;
  // What the pending nudges save as (see saveNudges): one key for a run of nudges of the same
  // elements, so the app can make their saves one undo step. Null when anything else waits with them.
  var nudgeGroup = null;
  // The lines that follow the elements being nudged (see nudgeFollowers), until the nudges are saved.
  var nudgeLines = null;
  var lastDown = { el: null, at: 0 };
  // The last press on one of a line's points, to tell a double-click.
  var lastPoint = { index: -1, at: 0 };
  // Where the pointer is over this window, in its pixels; null once it leaves.
  var pointer = null;
  var overflowFrame = 0;
  var reportFrame = 0;
  // What the last selection report said (see report), so one that says the same is not posted.
  var reportedSelection = null;
  var handlesFrame = 0;
  var hoverFrame = 0;
  // Looks at the whole slide (what overflows, its layers) wait for a pause in the typing, and for
  // the end of a drag, of adding an element and of a marquee.
  var TYPING_PAUSE_MS = 250;
  var slideChecksTimer = null;
  var slideChecksDue = false;
  // The text being typed changed since its `data-autofit="shrink"` box was last fitted.
  var refitDue = false;
  // What the pasteboard said of the view (see camera), kept until it pans, zooms or the window resizes.
  var keptCamera = null;
  // How many of this window's pixels one screen pixel takes (see onScreen), as the pasteboard said last.
  var uiScale = 1;
  // How far the frame around the selection is turned, which its resize handles' cursors show.
  var cursorAngle = null;
  // What overflows (see refreshOverflow), each with its box in slide pixels.
  var overflowBoxes = [];
  // The last caret or text selection in the element being edited, kept while focus is in the app.
  var textRange = null;
  // The next paste goes in as plain text (⌘⇧V).
  var plainPaste = false;
  var reportedOverflow = null;
  var tool = "select";
  var toolStyle = {};
  // The group a double-click went into: clicks select what it holds.
  var enteredGroup = null;
  // When the last double-click went into a group: the browser's dblclick that follows it edits nothing.
  var enteredAt = 0;
  // Where the group gone into shows (see shownFrame), kept while a drag in it goes on.
  var groupFrame = null;
  // The steps to undo and redo while typing (see "Undo while typing" in 50-keys.js).
  var textSteps = null;
  // Whether what a tool adds lands on a dark ground, where the default ink would not show (see readable).
  var darkGround = false;
  // The text box, shape or drawing being dragged out with a tool.
  var create = null;
  // The look the format painter took, until it is clicked onto an element.
  var painting = null;
  // Drags and resizes snap to the guides ({ type: "slop:edit-snap", on }); ⌘ / Ctrl does the opposite while held.
  var snapping = true;
  // What a restyle being previewed changed, as it was before ({ el, attrs }), until it is applied or cancelled.
  var preview = null;
  // The font sizes ⌘⇧. and ⌘⇧, (and the toolbar's Larger and Smaller text) step each text through.
  var FONT_STEPS = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 144, 160, 200, 240];
  // What "Clear formatting" takes off text: everything inline but its links.
  var CLEARED = { color: null, fontSize: null, fontFamily: null, bold: null, weight: null, italic: null, underline: null, strike: null, script: null, letterSpacing: null, highlight: null, textCase: null };
  var CLEARED_PROPS = ["color", "font-size", "font-family", "font-weight", "font-style", "text-decoration-line", "text-decoration", "letter-spacing", "text-transform"];
  // The handles and the overflow wires keep to the slide as the view pans and zooms.
  pasteboard.onChange(cameraMoved);
  // Whatever may change the slide comes after its markup was kept: what the user does, and the
  // app's messages, but for the settings it sends as the slide loads.
  ["pointerdown", "keydown", "dblclick", "contextmenu", "paste"].forEach(function (type) {
    listen(window, type, keepSaved, true);
  });
  listen(
    window,
    "message",
    function (event) {
      var type = event.data ? String(event.data.type) : "";
      if (/^slop:edit-/.test(type) && !SETTINGS.test(type)) keepSaved();
    },
    true,
  );
  afterPaint(keepSaved);
  // Space and 0 are text while typing, and Space+drag selects it.
  // What the pasteboard says without the editor, for when it is detached.
  var idleBusy = pasteboard.busy;
  pasteboard.busy = function () {
    return !!editing;
  };

