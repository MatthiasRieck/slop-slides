/* SlopSlide slide editor. The app adds it to the stage's slide preview in edit mode (see
   src-tauri/src/protocol.rs); it is never part of deck.html or an export.

   Click selects an element, drag (or arrow keys) moves it. Its corner and edge handles
   stretch it while the opposite side stays put (Shift keeps the aspect ratio, Alt scales
   from the center); the handle above it rotates it (Shift snaps to 15°). Double-click a
   handle to reset. Added shapes and drawings are resized rather than scaled: a shape gets a new
   width and height, a drawing's points move apart, so borders and lines keep their width.
   Double-click (or Enter) edits its text, Escape selects the parent, Delete removes it.
   Every change is posted to the app as the slide's new markup:
   { type: "slop:edit-commit", slide, markup, select }.

   The app's edit toolbar drives the rest with messages:
   - { type: "slop:edit-tool", tool, style } picks a tool: "select", "text" (click or drag out a
     text box), "rect" / "rounded" / "ellipse" (drag out a shape, Shift keeps it even) or "draw"
     (freehand). `style` is what new elements get. Added elements are absolutely positioned on
     the slide with inline styles and carry `data-added` ("text", "shape" or "drawing"). After a
     text box or shape the tool goes back to "select", and Escape puts any tool away; the editor
     tells the app with { type: "slop:edit-tool", slide, tool }.
   - { type: "slop:edit-style", style } restyles the selection: text color, size, bold, italic,
     alignment (vertical only in flex boxes, which added text boxes and shapes are), fill and
     border (a drawing's fill and stroke).
   - { type: "slop:edit-order", to } moves it "front", "forward", "backward" or "back" among the
     elements it overlaps, with an inline z-index.
   - { type: "slop:edit-delete" } removes it.
   Whenever the selection changes it reports what the toolbar shows for it:
   { type: "slop:edit-selection", slide, selection }.

   It runs on the pasteboard (pasteboard.js), which pans and zooms the view; dragging empty space
   pans too. The slide no longer clips, so content that runs past its edge stays visible (dimmed
   outside the slide, in the color of the panel around it), and the slide's frame turns into the
   app's accent color. Content moved far away can always be panned to and dragged back.
   Anything that runs past the slide's edge or is cut off by its own box is outlined with a red
   dashed wire and reported as { type: "slop:edit-overflow", slide, items } so the app can offer
   to tidy the layout. */
(function () {
  var slide = document.querySelector(".deck > .slide.active");
  var pasteboard = window.slopPasteboard;
  if (!slide || !pasteboard || window.parent === window) return;

  // Attributes the editor adds while it works; stripped from the markup it saves.
  var EDITOR_ATTRS = ["contenteditable", "data-slop-selected", "data-slop-hover", "data-slop-editing", "data-slop-typing"];
  var MOVED = "data-moved";
  var DRAG_THRESHOLD = 3;
  var DOUBLE_CLICK_MS = 400;
  var NUDGE_SAVE_MS = 500;
  var ROTATE_SNAP = 15;
  var MIN_SCALE = 0.1;
  var OVERFLOW_TOLERANCE = 2;
  // Marks an element the user added (a text box, shape or drawing); it stays in the markup.
  var ADDED = "data-added";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var TOOLS = ["select", "text", "rect", "rounded", "ellipse", "draw"];
  var RADIUS = { rect: "0px", rounded: "24px", ellipse: "50%" };
  var SHAPE_SIZE = { w: 320, h: 200 };
  var DRAW_STEP = 2;
  var BORDER_WIDTH = 4;
  var BORDER_COLOR = "#111111";
  // What a new element gets for anything the app's style leaves out.
  var FALLBACK_STYLE = { color: "#111111", fontSize: 48, align: "left", valign: "top", stroke: "#111111", strokeWidth: 4 };
  var JUSTIFY = { top: "flex-start", middle: "center", bottom: "flex-end" };
  // Non-positioned elements paint below positioned ones at z-index 0 and above those below it.
  var STATIC_Z = -0.5;

  var style = document.createElement("style");
  style.textContent =
    // The slide shows what runs past its edge.
    ".deck, .deck > .slide.active { overflow: visible !important; }" +
    ".deck > .slide.active, .deck > .slide.active * { -webkit-user-select: none; user-select: none; }" +
    "[data-slop-hover] { outline: 3px dashed rgba(59, 130, 246, 0.7) !important; outline-offset: 4px; }" +
    // The selection frame is drawn by the handle overlay, so it keeps its size on screen.
    "[data-slop-selected] { cursor: move !important; }" +
    "[data-slop-editing] { outline: 3px solid #3b82f6 !important; outline-offset: 4px; }" +
    "[data-slop-ui] { position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box;" +
    " outline: 2px solid #3b82f6; }" +
    "[data-slop-ui] > * { position: absolute; box-sizing: border-box; pointer-events: auto; background: #fff;" +
    " border: 2px solid #3b82f6; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); touch-action: none;" +
    " width: 16px; height: 16px; }" +
    "[data-slop-ui] > [data-handle=scale] { border-radius: 3px; }" +
    "[data-slop-ui] > [data-axis] { border-radius: 8px; }" +
    "[data-slop-ui] > [data-axis=x] { height: 24px; }" +
    "[data-slop-ui] > [data-axis=y] { width: 24px; }" +
    "[data-slop-ui][data-narrow] > [data-axis=y], [data-slop-ui][data-flat] > [data-axis=x] { display: none; }" +
    "[data-slop-ui] > [data-handle=rotate] { border-radius: 50%; width: 18px; height: 18px; margin: 0 0 0 -9px;" +
    " left: 50%; top: -48px; cursor: grab; }" +
    "[data-slop-overflow] { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }" +
    "[data-slop-overflow][data-quiet] { display: none; }" +
    "[data-slop-overflow] > * { position: absolute; box-sizing: border-box; }" +
    "[data-slop-overflow] > [data-wire] { outline: 3px dashed #ef4444; outline-offset: -1px; background: rgba(239, 68, 68, 0.08); }" +
    // The slide's frame marks edit mode, and dims everything outside the slide.
    "[data-slop-frame] { outline: 2px solid var(--slop-accent, #3b82f6); outline-offset: 4px; box-shadow: 0 0 0 9999px" +
    " color-mix(in srgb, var(--slop-canvas, #f4f4f5) 55%, transparent); }" +
    // A drawing or shape tool draws wherever the pointer goes.
    "html[data-slop-tool], html[data-slop-tool] * { cursor: crosshair !important; }" +
    "html[data-slop-tool=text], html[data-slop-tool=text] * { cursor: text !important; }" +
    "[data-slop-ui] > [data-stem] { pointer-events: none; width: 2px; height: 32px; margin: 0 0 0 -1px;" +
    " left: 50%; top: -32px; border: 0; box-shadow: none; background: #3b82f6; }" +
    // While typing, overlays (like invisible hover zones) let clicks through to the text.
    ".deck > .slide.active[data-slop-typing] * { pointer-events: none !important; }" +
    ".deck > .slide.active[data-slop-typing] [data-slop-editing]," +
    " .deck > .slide.active[data-slop-typing] [data-slop-editing] * { pointer-events: auto !important; }" +
    ".deck > .slide.active [data-slop-editing], .deck > .slide.active [data-slop-editing] * {" +
    " -webkit-user-select: text; user-select: text; cursor: text !important; }";
  document.head.appendChild(style);

  // Scale and rotate handles, outside the slide so they never end up in its markup. They sit
  // just outside the frame, so even small text stays clickable (and double-clickable) inside it.
  var ui = document.createElement("div");
  ui.setAttribute("data-slop-ui", "");
  ui.style.display = "none";
  ui.innerHTML =
    '<div data-stem></div><div data-handle="rotate" title="Rotate (Shift snaps to 15°, double-click resets)"></div>' +
    [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]
      .map(function (d) {
        var cursor = d[0] === 0 ? "ns" : d[1] === 0 ? "ew" : d[0] === d[1] ? "nwse" : "nesw";
        var axis = d[0] === 0 ? ' data-axis="y"' : d[1] === 0 ? ' data-axis="x"' : "";
        var w = d[0] === 0 ? 24 : 16;
        var h = d[1] === 0 ? 24 : 16;
        var outside = function (dir, size) {
          return dir < 0 ? -size - 2 : dir > 0 ? 2 : -size / 2;
        };
        return (
          '<div data-handle="scale" data-dir="' + d[0] + " " + d[1] + '"' + axis +
          ' title="Stretch (Shift keeps the aspect ratio, Alt scales from the center, double-click resets)"' +
          ' style="left: ' + (d[0] + 1) * 50 + "%; top: " + (d[1] + 1) * 50 + "%; margin: " + outside(d[1], h) + "px 0 0 " +
          outside(d[0], w) + "px; cursor: " + cursor + '-resize"></div>'
        );
      })
      .join("");
  document.body.appendChild(ui);

  var wires = document.createElement("div");
  wires.setAttribute("data-slop-overflow", "");
  document.body.appendChild(wires);

  var saved = serialize();
  var selected = null;
  var hovered = null;
  var editing = null;
  var drag = null;
  var nudgeTimer = null;
  var lastDown = { el: null, at: 0 };
  var overflowFrame = 0;
  var reportedOverflow = null;
  var tool = "select";
  var toolStyle = {};
  // The text box, shape or drawing being dragged out with a tool.
  var create = null;
  // The handles keep to the selection as the view pans and zooms.
  pasteboard.onChange(placeHandles);
  // Space and 0 are text while typing, and Space+drag selects it.
  pasteboard.busy = function () {
    return !!editing;
  };

  /** The slide's markup without anything the editor or the player added. */
  function serialize() {
    var copy = slide.cloneNode(true);
    copy.classList.remove("active");
    [copy].concat(Array.prototype.slice.call(copy.querySelectorAll("*"))).forEach(function (el) {
      EDITOR_ATTRS.forEach(function (name) {
        el.removeAttribute(name);
      });
    });
    return copy.outerHTML;
  }

  function commit() {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
    var markup = serialize();
    if (markup === saved) return;
    saved = markup;
    window.parent.postMessage(
      { type: "slop:edit-commit", slide: slide.id, markup: markup, select: pathOf(selected) },
      "*",
    );
  }

  /** Child-index path from the slide to `el`, to select it again after the preview reloads. */
  function pathOf(el) {
    if (!el || !slide.contains(el) || el === slide) return null;
    var path = [];
    for (var node = el; node !== slide; node = node.parentElement) {
      path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    return path;
  }

  function atPath(path) {
    var el = slide;
    for (var i = 0; path && i < path.length && el; i++) el = el.children[path[i]];
    return el && el !== slide ? el : null;
  }

  /** Whether `el` shows anything: text, media, a background, a border, or a shadow. */
  function paints(el) {
    var style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.opacity === "0") return false;
    if (el.hasAttribute(ADDED)) return true;
    if (el.textContent.trim() || /^(img|svg|video|canvas|picture|iframe|object|embed)$/i.test(el.tagName)) return true;
    var bg = style.backgroundColor;
    var clear = !bg || bg === "transparent" || /rgba\(.*,\s*0\)$/.test(bg);
    var border = ["Top", "Right", "Bottom", "Left"].some(function (side) {
      return parseFloat(style["border" + side + "Width"]) > 0 && style["border" + side + "Style"] !== "none";
    });
    return !clear || (style.backgroundImage || "none") !== "none" || border || (style.boxShadow || "none") !== "none";
  }

  /** The element to select for `el`: not inline text runs, whole SVG drawings. */
  function selectable(el) {
    if (!el || el.nodeType !== 1 || !slide.contains(el) || el === slide) return null;
    var svg = el.closest("svg");
    while (svg && svg.parentElement && svg.parentElement.closest("svg")) svg = svg.parentElement.closest("svg");
    if (svg && slide.contains(svg)) el = svg;
    while (el.parentElement !== slide && getComputedStyle(el).display === "inline") el = el.parentElement;
    return el;
  }

  /**
   * What a pointer at (x, y) on `target` picks: the top-most element there that shows
   * something, so invisible overlays (hover zones, empty wrappers) do not get in the way.
   */
  function pickable(target, x, y) {
    var stack = document.elementsFromPoint && x !== undefined ? document.elementsFromPoint(x, y) : [];
    if (!stack.length) {
      for (var node = target && target.nodeType === 1 ? target : target && target.parentElement; node; node = node.parentElement) {
        stack.push(node);
      }
    }
    for (var i = 0; i < stack.length; i++) {
      if (stack[i] === slide) return null;
      var el = selectable(stack[i]);
      if (el && paints(el)) return el;
    }
    return null;
  }

  function mark(el, name, on) {
    if (!el) return;
    if (on) el.setAttribute(name, "");
    else el.removeAttribute(name);
  }

  function select(el) {
    if (el === selected) return;
    mark(selected, "data-slop-selected", false);
    selected = el;
    mark(selected, "data-slop-selected", true);
    placeHandles();
    report();
  }

  /** Tells the app what its toolbar shows for the selection. */
  function report() {
    window.parent.postMessage({ type: "slop:edit-selection", slide: slide.id, selection: describe(selected) }, "*");
  }

  /** `#rrggbb` for a CSS color, or null when it is transparent or not a plain color. */
  function toHex(value) {
    value = String(value || "").trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(value)) return value;
    if (/^#[0-9a-f]{3}$/.test(value)) return "#" + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    var m = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
    if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return null;
    return "#" + [m[1], m[2], m[3]].map(function (n) {
      return ("0" + Math.min(255, Math.round(parseFloat(n))).toString(16)).slice(-2);
    }).join("");
  }

  /** The shapes in a drawing, whose fill and stroke stand for the drawing's. */
  function vectorsOf(el) {
    return el.getAttribute(ADDED) === "drawing"
      ? Array.prototype.slice.call(el.querySelectorAll("path, line, polyline, polygon, rect, circle, ellipse"))
      : [];
  }

  function paintOf(vector, attr) {
    var value = vector && vector.getAttribute(attr);
    return value && value !== "none" ? toHex(value) : null;
  }

  /** Which way `el` lays out its text vertically, when it is a flex box; null otherwise. */
  function valignOf(style) {
    if (!/flex/.test(style.display || "")) return null;
    var value = /column/.test(style.flexDirection || "") ? style.justifyContent : style.alignItems;
    return /center/.test(value) ? "middle" : /end/.test(value) ? "bottom" : "top";
  }

  /** What the toolbar shows for `el`: its kind, text styles, fill and border. */
  function describe(el) {
    if (!el) return null;
    var style = getComputedStyle(el);
    var tag = el.tagName.toLowerCase();
    var kind = el.getAttribute(ADDED) || (/^(img|svg|video|canvas|picture|iframe|object|embed)$/.test(tag) ? "media" : "element");
    var vectors = vectorsOf(el);
    var first = vectors[0];
    var borderWidth = style.borderTopStyle && style.borderTopStyle !== "none" ? parseFloat(style.borderTopWidth) || 0 : 0;
    var weight = style.fontWeight === "bold" ? 700 : parseInt(style.fontWeight, 10) || 400;
    var align = style.textAlign || "left";
    return {
      kind: kind,
      text: kind !== "drawing" && kind !== "media",
      vector: kind === "drawing",
      color: toHex(style.color),
      fontSize: Math.round(parseFloat(style.fontSize)) || null,
      bold: weight >= 600,
      italic: style.fontStyle === "italic",
      align: /center/.test(align) ? "center" : /right|end/.test(align) ? "right" : "left",
      valign: valignOf(style),
      fill: first ? paintOf(first, "fill") : toHex(style.backgroundColor),
      stroke: first ? paintOf(first, "stroke") : borderWidth ? toHex(style.borderTopColor) : null,
      strokeWidth: first ? parseFloat(first.getAttribute("stroke-width")) || 0 : borderWidth,
    };
  }

  function hover(el) {
    if (el === hovered) return;
    mark(hovered, "data-slop-hover", false);
    hovered = el;
    mark(hovered, "data-slop-hover", true);
  }

  /** The element's inline `translate` offset in slide pixels. */
  function offsetOf(el) {
    var parts = (el.style.translate || "").match(/-?[\d.]+(?=px)/g) || [];
    return { x: parseFloat(parts[0] || "0"), y: parseFloat(parts[1] || "0") };
  }

  function moveTo(el, x, y) {
    x = Math.round(x);
    y = Math.round(y);
    setInline(el, "translate", x === 0 && y === 0 ? null : x + "px " + y + "px");
  }

  /** The element's rotation in degrees and its (uniform) scale, inline or from the stylesheet. */
  function angleOf(el) {
    var match = (el.style.rotate || getComputedStyle(el).rotate || "").match(/^(-?[\d.]+)deg$/);
    return match ? parseFloat(match[1]) : 0;
  }
  function scaleOf(el) {
    return parseScale(el.style.scale || getComputedStyle(el).scale);
  }
  function parseScale(value) {
    var parts = String(value || "").trim().split(/\s+/).map(parseFloat);
    var x = isFinite(parts[0]) && parts[0] > 0 ? parts[0] : 1;
    var y = isFinite(parts[1]) && parts[1] > 0 ? parts[1] : x;
    return { x: x, y: y };
  }

  /** What the stylesheet alone gives `el` for `prop`. */
  function sheetValue(el, prop) {
    var inline = el.style[prop];
    if (!inline) return getComputedStyle(el)[prop];
    el.style[prop] = "";
    var value = getComputedStyle(el)[prop];
    el.style[prop] = inline;
    return value;
  }

  function rotateTo(el, degrees) {
    degrees = Math.round(degrees) % 360;
    if (degrees > 180) degrees -= 360;
    if (degrees <= -180) degrees += 360;
    var sheet = sheetValue(el, "rotate");
    var same = degrees === 0 ? !sheet || sheet === "none" || sheet === "0deg" : sheet === degrees + "deg";
    setInline(el, "rotate", same ? null : degrees + "deg");
  }

  function scaleTo(el, x, y) {
    x = Math.max(MIN_SCALE, Math.round(x * 1000) / 1000);
    y = Math.max(MIN_SCALE, Math.round(y * 1000) / 1000);
    var sheet = parseScale(sheetValue(el, "scale"));
    setInline(el, "scale", sheet.x === x && sheet.y === y ? null : x === y ? String(x) : x + " " + y);
  }

  /** Sets (or with null, drops) an inline transform; `data-moved` marks any hand transform. */
  function setInline(el, prop, value) {
    if (value === null) el.style.removeProperty(prop);
    else el.style[prop] = value;
    if (!el.getAttribute("style")) el.removeAttribute("style");
    mark(el, MOVED, !!(el.style.translate || el.style.rotate || el.style.scale));
    placeHandles();
  }

  /** The element's untransformed size, in slide pixels. */
  function sizeOf(el) {
    var computed = getComputedStyle(el);
    return {
      w: el.offsetWidth || parseFloat(computed.width) || 0,
      h: el.offsetHeight || parseFloat(computed.height) || 0,
    };
  }

  /** Screen pixels per slide pixel. */
  function zoom() {
    var value = slide.getBoundingClientRect().width / slide.offsetWidth;
    return isFinite(value) && value > 0 ? value : 1;
  }

  /** Lays the handles over the selection's box, turned with it; they keep their size on screen. */
  function placeHandles() {
    scheduleOverflow();
    if (!selected || editing || !slide.contains(selected)) {
      ui.style.display = "none";
      return;
    }
    var rect = selected.getBoundingClientRect();
    var size = sizeOf(selected);
    var scale = scaleOf(selected);
    var w = size.w * scale.x * zoom();
    var h = size.h * scale.y * zoom();
    ui.style.display = "";
    ui.style.left = rect.left + rect.width / 2 - w / 2 + "px";
    ui.style.top = rect.top + rect.height / 2 - h / 2 + "px";
    ui.style.width = w + "px";
    ui.style.height = h + "px";
    ui.style.transform = "rotate(" + angleOf(selected) + "deg)";
    // Edge handles only where there is room for them between the corners.
    mark(ui, "data-narrow", w < 40);
    mark(ui, "data-flat", h < 40);
  }

  ui.addEventListener("pointerdown", function (event) {
    var kind = event.target.getAttribute && event.target.getAttribute("data-handle");
    if (event.button !== 0 || !kind || !selected) return;
    event.preventDefault();
    event.stopPropagation();
    if (nudgeTimer) commit();
    var rect = selected.getBoundingClientRect();
    var dir = (event.target.getAttribute("data-dir") || "0 0").split(" ").map(Number);
    drag = {
      mode: kind,
      el: selected,
      center: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      start: { x: event.clientX, y: event.clientY },
      angle: angleOf(selected),
      scale: scaleOf(selected),
      offset: offsetOf(selected),
      size: sizeOf(selected),
      zoom: zoom(),
      dir: { x: dir[0], y: dir[1] },
      vectors: resizable(selected) ? vectorShapes(selected) : null,
      moved: false,
    };
    if (event.target.setPointerCapture) {
      try {
        event.target.setPointerCapture(event.pointerId);
      } catch (e) {
        // Synthetic events have no active pointer to capture.
      }
    }
  });
  ui.addEventListener("dblclick", function (event) {
    var kind = event.target.getAttribute && event.target.getAttribute("data-handle");
    event.stopPropagation();
    if (!kind || !selected) return;
    if (kind === "rotate") rotateTo(selected, 0);
    else scaleTo(selected, 1, 1);
    commit();
  });

  /** Turns the screen vector (x, y) by `degrees`. */
  function turn(x, y, degrees) {
    var a = (degrees * Math.PI) / 180;
    return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
  }

  /** Applies a handle drag to the pointer at `event`. */
  function transformTo(event) {
    if (drag.mode === "rotate") {
      var c = drag.center;
      var start = Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
      var degrees = drag.angle + ((Math.atan2(event.clientY - c.y, event.clientX - c.x) - start) * 180) / Math.PI;
      rotateTo(drag.el, event.shiftKey ? Math.round(degrees / ROTATE_SNAP) * ROTATE_SNAP : degrees);
      return;
    }
    stretchTo(event.clientX - drag.start.x, event.clientY - drag.start.y, event.shiftKey, event.altKey);
  }

  /**
   * Stretches along the dragged handle's axes, working in the element's own (turned) frame
   * in slide pixels: the handle follows the pointer and the opposite side stays put, or with
   * `fromCenter` the center does. `keepRatio` scales both axes by the same factor.
   */
  function stretchTo(dx, dy, keepRatio, fromCenter) {
    var d = drag.dir;
    var w = drag.size.w;
    var h = drag.size.h;
    var s0 = drag.scale;
    var moved = turn(dx / drag.zoom, dy / drag.zoom, -drag.angle);
    // The dragged handle's new spot, relative to the element's center before the drag.
    var hx = (d.x * w * s0.x) / 2 + moved.x;
    var hy = (d.y * h * s0.y) / 2 + moved.y;
    var reach = fromCenter ? 2 : 1;
    var sx = d.x && w ? (reach * d.x * (hx + (fromCenter ? 0 : (d.x * w * s0.x) / 2))) / w : s0.x;
    var sy = d.y && h ? (reach * d.y * (hy + (fromCenter ? 0 : (d.y * h * s0.y) / 2))) / h : s0.y;
    if (keepRatio) {
      var fx = sx / s0.x;
      var fy = sy / s0.y;
      var f = !d.x ? fy : !d.y ? fx : Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
      sx = s0.x * f;
      sy = s0.y * f;
    }
    sx = Math.max(MIN_SCALE, sx);
    sy = Math.max(MIN_SCALE, sy);
    // Where the center goes so the opposite side stays put (only along the dragged axes).
    var cx = fromCenter || !d.x ? 0 : (d.x * w * (sx - s0.x)) / 2;
    var cy = fromCenter || !d.y ? 0 : (d.y * h * (sy - s0.y)) / 2;
    var shift = turn(cx, cy, drag.angle);
    if (resizable(drag.el)) {
      resizeTo(sx, sy, shift);
      return;
    }
    scaleTo(drag.el, sx, sy);
    moveTo(drag.el, drag.offset.x + shift.x, drag.offset.y + shift.y);
  }

  /** Added shapes and drawings stretch by their size, not a `scale`, so their borders and lines keep their width. */
  function resizable(el) {
    return /^(shape|drawing)$/.test(el.getAttribute(ADDED) || "");
  }

  /**
   * Gives the dragged element the size `sx` × `sy` times its box (dropping any `scale`), with
   * its center moved by `shift`. A drawing's points spread out to fill the new box.
   */
  function resizeTo(sx, sy, shift) {
    var el = drag.el;
    var w = drag.size.w;
    var h = drag.size.h;
    var nw = Math.max(1, Math.round(w * sx));
    var nh = Math.max(1, Math.round(h * sy));
    el.style.width = nw + "px";
    el.style.height = nh + "px";
    if (drag.vectors && w && h) spreadVectors(drag.vectors, nw / w, nh / h);
    scaleTo(el, 1, 1);
    // A wider box grows from its left and top, moving its center by half the growth; the
    // translate makes up the rest.
    moveTo(el, drag.offset.x + shift.x - (nw - w) / 2, drag.offset.y + shift.y - (nh - h) / 2);
  }

  /** A drawing's viewBox and its shapes' geometry, as they were when the stretch started. */
  function vectorShapes(el) {
    var box = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(parseFloat);
    var vectors = vectorsOf(el);
    return {
      el: el,
      viewBox: box.length === 4 && box.every(isFinite) && box[2] > 0 && box[3] > 0 ? box : null,
      // The line's half width pads the box around the points (see finishDrawing).
      pad: vectors.length ? Math.ceil((parseFloat(vectors[0].getAttribute("stroke-width")) || 0) / 2) : 0,
      items: vectors.map(function (vector) {
        var attrs = {};
        ["d", "points", "x1", "y1", "x2", "y2"].forEach(function (name) {
          if (vector.hasAttribute(name)) attrs[name] = vector.getAttribute(name);
        });
        return { el: vector, attrs: attrs };
      }),
    };
  }

  /** Spreads the drawing's points by `kx` × `ky` around its padded box; the lines keep their width. */
  function spreadVectors(shapes, kx, ky) {
    var box = shapes.viewBox || [0, 0, drag.size.w, drag.size.h];
    var pad = shapes.pad;
    var vw = box[2] * kx;
    var vh = box[3] * ky;
    var factor = function (from, to) {
      return Math.max(0, from > 2 * pad ? (to - 2 * pad) / (from - 2 * pad) : to / from);
    };
    var fx = factor(box[2], vw);
    var fy = factor(box[3], vh);
    var map = {
      fx: fx,
      fy: fy,
      x: function (n) {
        return box[0] + pad + (n - box[0] - pad) * fx;
      },
      y: function (n) {
        return box[1] + pad + (n - box[1] - pad) * fy;
      },
    };
    shapes.el.setAttribute("viewBox", [box[0], box[1], roundTenth(vw), roundTenth(vh)].join(" "));
    shapes.items.forEach(function (item) {
      var a = item.attrs;
      if (a.d !== undefined) item.el.setAttribute("d", spreadPath(a.d, map));
      if (a.points !== undefined) {
        var n = 0;
        item.el.setAttribute(
          "points",
          a.points.replace(NUMBER, function (value) {
            return String(roundTenth(n++ % 2 ? map.y(parseFloat(value)) : map.x(parseFloat(value))));
          }),
        );
      }
      ["x1", "x2"].forEach(function (name) {
        if (a[name] !== undefined) item.el.setAttribute(name, String(roundTenth(map.x(parseFloat(a[name]) || 0))));
      });
      ["y1", "y2"].forEach(function (name) {
        if (a[name] !== undefined) item.el.setAttribute(name, String(roundTenth(map.y(parseFloat(a[name]) || 0))));
      });
    });
  }

  function roundTenth(n) {
    return Math.round(n * 10) / 10;
  }

  var NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
  // What each parameter of a path command is: X / Y a point's coordinate, x / y a length
  // along that axis, - anything else (an angle or a flag).
  var PATH_PARAMS = { M: "XY", L: "XY", T: "XY", C: "XY", S: "XY", Q: "XY", H: "X", V: "Y", A: "xy---XY", Z: "" };

  /** Path data with every point moved by `map` (and relative steps and radii scaled by it). */
  function spreadPath(d, map) {
    var out = "";
    var command = "";
    var params = "";
    var i = 0;
    var commands = 0;
    (String(d).match(new RegExp("[a-df-z]|" + NUMBER.source, "gi")) || []).forEach(function (token) {
      if (/^[a-z]$/i.test(token)) {
        command = token;
        params = PATH_PARAMS[token.toUpperCase()] || "";
        i = 0;
        commands++;
        out += (out ? " " : "") + token;
        return;
      }
      var kind = params ? params[i % params.length] : "-";
      // A path's first move is absolute even when written as `m`.
      var absolute = command === command.toUpperCase() || (commands === 1 && i < 2);
      var n = parseFloat(token);
      if (kind === "X") n = absolute ? map.x(n) : n * map.fx;
      else if (kind === "Y") n = absolute ? map.y(n) : n * map.fy;
      else if (kind === "x") n *= map.fx;
      else if (kind === "y") n *= map.fy;
      out += (/[a-z]$/i.test(out) ? "" : " ") + roundTenth(n);
      i++;
    });
    return out;
  }

  /** Which of the slide's edges `rect` runs past, with by how many slide pixels. */
  function pastEdges(rect, bounds, k) {
    var past = [];
    var add = function (side, by) {
      by /= k;
      if (by > OVERFLOW_TOLERANCE) past.push({ side: side, by: Math.round(by) });
    };
    add("top", bounds.top - rect.top);
    add("right", rect.right - bounds.right);
    add("bottom", rect.bottom - bounds.bottom);
    add("left", bounds.left - rect.left);
    return past;
  }

  /** Whether `el` itself holds text or media, as opposed to decoration like a glow that bleeds off the edge. */
  function hasContent(el) {
    if (el.closest("[aria-hidden=true]")) return false;
    if (/^(img|svg|video|canvas|picture|iframe|object|embed)$/i.test(el.tagName)) return true;
    return Array.prototype.some.call(el.childNodes, function (node) {
      return node.nodeType === 3 && node.textContent.trim();
    });
  }

  /** Elements that run past the slide's edge or are cut off by their own box; the innermost ones. */
  function findOverflow() {
    var bounds = slide.getBoundingClientRect();
    var k = zoom();
    var hits = [];
    Array.prototype.forEach.call(slide.querySelectorAll("*"), function (el) {
      var svg = el.closest("svg");
      if ((svg && svg !== el) || el.closest(".notes")) return;
      var rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      var past = hasContent(el) && paints(el) ? pastEdges(rect, bounds, k) : [];
      var style = getComputedStyle(el);
      var clips = style.overflowX !== "visible" || style.overflowY !== "visible";
      var cut = clips && (el.scrollWidth > el.clientWidth + OVERFLOW_TOLERANCE || el.scrollHeight > el.clientHeight + OVERFLOW_TOLERANCE);
      if (past.length || cut) hits.push({ el: el, rect: rect, past: past, cut: cut });
    });
    return hits.filter(function (hit) {
      return !hits.some(function (other) {
        return other !== hit && hit.el.contains(other.el);
      });
    });
  }

  function describeOverflow(hit) {
    var text = hit.el.textContent.replace(/\s+/g, " ").trim();
    var name = "<" + hit.el.tagName.toLowerCase() + ">" + (text ? ' "' + text.slice(0, 40) + (text.length > 40 ? "…" : "") + '"' : "");
    var what = hit.past.map(function (p) {
      return "runs past the " + p.side + " edge by " + p.by + "px";
    });
    if (hit.cut) what.push("is cut off by its own box");
    return name + " " + what.join(" and ");
  }

  function drawOverflow(hits) {
    wires.textContent = "";
    hits.forEach(function (hit) {
      var left = Math.max(hit.rect.left, 0);
      var top = Math.max(hit.rect.top, 0);
      var right = Math.min(hit.rect.right, window.innerWidth);
      var bottom = Math.min(hit.rect.bottom, window.innerHeight);
      var wire = document.createElement("div");
      wire.setAttribute("data-wire", "");
      wire.style.cssText = "left:" + left + "px;top:" + top + "px;width:" + Math.max(0, right - left) + "px;height:" + Math.max(0, bottom - top) + "px";
      wires.appendChild(wire);
    });
  }

  function refreshOverflow() {
    overflowFrame = 0;
    var hits = findOverflow();
    drawOverflow(hits);
    var items = hits.map(describeOverflow);
    var key = JSON.stringify(items);
    if (key === reportedOverflow) return;
    reportedOverflow = key;
    window.parent.postMessage({ type: "slop:edit-overflow", slide: slide.id, items: items }, "*");
  }

  /** Re-checks for overflow once per frame, however many changes came in. */
  function scheduleOverflow() {
    if (!overflowFrame) overflowFrame = window.requestAnimationFrame(refreshOverflow);
  }

  function startEditing(el, x, y) {
    if (!el || editing || /^(img|svg|video|canvas|iframe|hr|br)$/i.test(el.tagName)) return;
    if (!el.textContent.trim() && !/^(text|shape)$/.test(el.getAttribute(ADDED) || "")) return;
    select(el);
    editing = el;
    el.setAttribute("contenteditable", "true");
    el.setAttribute("data-slop-editing", "");
    slide.setAttribute("data-slop-typing", "");
    el.focus();
    placeHandles();
    var range = x !== undefined && document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (!range || !el.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
    }
    var selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function finishEditing() {
    if (!editing) return;
    var el = editing;
    el.removeAttribute("contenteditable");
    el.removeAttribute("data-slop-editing");
    slide.removeAttribute("data-slop-typing");
    editing = null;
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    // A text box left empty goes away.
    if (el.getAttribute(ADDED) === "text" && !el.textContent.trim()) {
      if (selected === el) select(null);
      el.parentElement.removeChild(el);
    }
    placeHandles();
    commit();
  }

  /** Picks a tool; `tell` lets the app know, when the editor switched by itself. */
  function useTool(next, tell) {
    tool = TOOLS.indexOf(next) >= 0 ? next : "select";
    if (tool === "select") {
      document.documentElement.removeAttribute("data-slop-tool");
    } else {
      document.documentElement.setAttribute("data-slop-tool", tool);
      hover(null);
    }
    if (tell) window.parent.postMessage({ type: "slop:edit-tool", slide: slide.id, tool: tool }, "*");
  }

  /** The style for a new element: what the app sent, with fallbacks. */
  function styleFor(key) {
    var value = toolStyle[key];
    return value === undefined ? FALLBACK_STYLE[key] : value;
  }

  /** Where the pointer at (x, y) is on the slide, in slide pixels. */
  function slidePoint(x, y) {
    var rect = slide.getBoundingClientRect();
    var k = zoom();
    return { x: Math.round((x - rect.left) / k), y: Math.round((y - rect.top) / k) };
  }

  function addElement(kind, css, svg) {
    var el = svg ? document.createElementNS(SVG_NS, "svg") : document.createElement("div");
    el.setAttribute(ADDED, kind);
    el.setAttribute("style", css);
    slide.appendChild(el);
    return el;
  }

  function place(el, x, y, w, h) {
    el.style.left = x + "px";
    el.style.top = y + "px";
    if (w !== null) el.style.width = w + "px";
    if (h !== null) el.style.height = h + "px";
  }

  function borderCss(color, width) {
    return color && width > 0 ? width + "px solid " + color : "none";
  }

  /** Inline styles for text laid out in a flex column, so it can align top, middle or bottom. */
  function textCss() {
    var stroke = styleFor("stroke");
    var width = styleFor("strokeWidth");
    return (
      " display: flex; flex-direction: column; justify-content: " + (JUSTIFY[styleFor("valign")] || "flex-start") +
      "; text-align: " + styleFor("align") + "; color: " + styleFor("color") + "; font-size: " + styleFor("fontSize") + "px;" +
      (styleFor("bold") ? " font-weight: 700;" : "") +
      (styleFor("italic") ? " font-style: italic;" : "") +
      (styleFor("fill") ? " background-color: " + styleFor("fill") + ";" : "") +
      (stroke && width > 0 ? " border: " + borderCss(stroke, width) + ";" : "")
    );
  }

  function newText(x, y, w) {
    var el = addElement(
      "text",
      "position: absolute; left: " + x + "px; top: " + y + "px;" + (w ? " width: " + w + "px;" : "") +
        " margin: 0; line-height: 1.2;" + textCss(),
    );
    el.textContent = "Text";
    return el;
  }

  function newShape(kind, x, y, w, h) {
    return addElement(
      "shape",
      "position: absolute; left: " + x + "px; top: " + y + "px; width: " + w + "px; height: " + h + "px; margin: 0;" +
        " box-sizing: border-box; padding: 16px; border-radius: " + RADIUS[kind] + ";" + textCss(),
    );
  }

  function newDrawing(at) {
    var svg = addElement("drawing", "position: absolute; left: 0px; top: 0px; width: 1px; height: 1px; margin: 0; overflow: visible;", true);
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", styleFor("fill") || "none");
    path.setAttribute("stroke", styleFor("stroke") || BORDER_COLOR);
    path.setAttribute("stroke-width", String(styleFor("strokeWidth") || BORDER_WIDTH));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return { svg: svg, path: path, points: [[at.x, at.y]] };
  }

  function pathData(points, dx, dy) {
    // A tap draws a dot: a zero-length line, which round caps make visible.
    var all = points.length === 1 ? [points[0], points[0]] : points;
    return all.map(function (p, i) {
      return (i ? "L" : "M") + (p[0] - dx) + " " + (p[1] - dy);
    }).join(" ");
  }

  /** Starts adding an element with the current tool at the pointer. */
  function startCreating(event) {
    var at = slidePoint(event.clientX, event.clientY);
    if (tool === "text") {
      // The text tool types into a text box or shape that is already there.
      var target = pickable(event.target, event.clientX, event.clientY);
      if (target && /^(text|shape)$/.test(target.getAttribute(ADDED) || "")) {
        useTool("select", true);
        startEditing(target, event.clientX, event.clientY);
        return;
      }
    }
    select(null);
    create = { tool: tool, x: event.clientX, y: event.clientY, at: at, el: null, moved: false };
    if (tool === "draw") {
      create.drawing = newDrawing(at);
      create.el = create.drawing.svg;
      create.drawing.path.setAttribute("d", pathData(create.drawing.points, 0, 0));
    }
  }

  function createTo(event) {
    var dx = event.clientX - create.x;
    var dy = event.clientY - create.y;
    if (!create.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    create.moved = true;
    var at = slidePoint(event.clientX, event.clientY);
    if (create.drawing) {
      var points = create.drawing.points;
      var last = points[points.length - 1];
      if (Math.abs(at.x - last[0]) < DRAW_STEP && Math.abs(at.y - last[1]) < DRAW_STEP) return;
      points.push([at.x, at.y]);
      create.drawing.path.setAttribute("d", pathData(points, 0, 0));
      return;
    }
    var w = Math.abs(at.x - create.at.x);
    var h = Math.abs(at.y - create.at.y);
    if (event.shiftKey) w = h = Math.max(w, h);
    var x = at.x < create.at.x ? create.at.x - w : create.at.x;
    var y = at.y < create.at.y ? create.at.y - h : create.at.y;
    if (!create.el) create.el = create.tool === "text" ? newText(x, y, w) : newShape(create.tool, x, y, w, h);
    place(create.el, x, y, w, create.tool === "text" ? null : h);
    placeHandles();
  }

  function finishCreating() {
    var done = create;
    create = null;
    if (done.drawing) {
      finishDrawing(done.drawing);
      return;
    }
    var el = done.el;
    if (!el) {
      el = done.tool === "text" ? newText(done.at.x, done.at.y) : newShape(done.tool, done.at.x, done.at.y, SHAPE_SIZE.w, SHAPE_SIZE.h);
    }
    useTool("select", true);
    select(el);
    // A new text box starts out typing, with its placeholder selected; it is saved when done.
    if (done.tool === "text") startEditing(el);
    else commit();
  }

  /** Fits the drawing's box around its line, so it moves, scales and rotates like any element. */
  function finishDrawing(drawing) {
    var xs = drawing.points.map(function (p) {
      return p[0];
    });
    var ys = drawing.points.map(function (p) {
      return p[1];
    });
    var pad = Math.ceil((parseFloat(drawing.path.getAttribute("stroke-width")) || 0) / 2);
    var left = Math.min.apply(null, xs) - pad;
    var top = Math.min.apply(null, ys) - pad;
    var w = Math.max.apply(null, xs) - left + pad;
    var h = Math.max.apply(null, ys) - top + pad;
    place(drawing.svg, left, top, w, h);
    drawing.svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    drawing.path.setAttribute("d", pathData(drawing.points, left, top));
    commit();
  }

  function cancelCreating() {
    if (!create) return;
    if (create.el && create.el.parentElement) create.el.parentElement.removeChild(create.el);
    create = null;
  }

  /** Restyles the selection with the toolbar's `changes` and saves it. */
  function applyStyle(changes) {
    var el = selected;
    if (!el || !slide.contains(el)) return;
    var has = function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    };
    if (has("color")) el.style.color = changes.color || "";
    if (has("fontSize")) el.style.fontSize = changes.fontSize > 0 ? Math.round(changes.fontSize) + "px" : "";
    if (has("bold")) el.style.fontWeight = changes.bold ? "700" : "400";
    if (has("italic")) el.style.fontStyle = changes.italic ? "italic" : "normal";
    if (has("align") && /^(left|center|right)$/.test(changes.align)) el.style.textAlign = changes.align;
    if (has("valign") && JUSTIFY[changes.valign]) {
      var computed = getComputedStyle(el);
      if (/flex/.test(computed.display || "")) {
        el.style[/column/.test(computed.flexDirection || "") ? "justifyContent" : "alignItems"] = JUSTIFY[changes.valign];
      }
    }
    var vectors = vectorsOf(el);
    if (vectors.length) {
      vectors.forEach(function (vector) {
        if (has("fill")) vector.setAttribute("fill", changes.fill || "none");
        if (has("stroke")) vector.setAttribute("stroke", changes.stroke || "none");
        if (has("strokeWidth")) vector.setAttribute("stroke-width", String(Math.max(0, changes.strokeWidth || 0)));
      });
    } else {
      if (has("fill")) el.style.backgroundColor = changes.fill || "transparent";
      if (has("stroke") || has("strokeWidth")) {
        var now = describe(el);
        var color = has("stroke") ? changes.stroke : now.stroke;
        var width = has("strokeWidth") ? changes.strokeWidth : now.strokeWidth;
        // Picking a border color shows a border; picking a width gives it a color.
        if (has("stroke") && color && !width) width = BORDER_WIDTH;
        if (has("strokeWidth") && width && !color) color = BORDER_COLOR;
        el.style.border = borderCss(color, width);
      }
    }
    if (!el.getAttribute("style")) el.removeAttribute("style");
    placeHandles();
    report();
    commit();
  }

  function overlaps(a, b) {
    var r = a.getBoundingClientRect();
    var s = b.getBoundingClientRect();
    return r.left <= s.right && s.left <= r.right && r.top <= s.bottom && s.top <= r.bottom;
  }

  /**
   * Moves the selection up or down the stack among its siblings with an inline z-index, so the
   * layout stays put: "forward" / "backward" past the next element it overlaps, "front" /
   * "back" past all of them.
   */
  function restack(where) {
    var el = selected;
    if (!el || !slide.contains(el) || ["front", "forward", "backward", "back"].indexOf(where) < 0) return;
    var parent = el.parentElement;
    var siblings = Array.prototype.filter.call(parent.children, function (s) {
      return !/^(script|style|template)$/i.test(s.tagName) && !s.classList.contains("notes") && !s.classList.contains("slop-review");
    });
    var layer = function (s) {
      var style = getComputedStyle(s);
      var z = parseInt(style.zIndex, 10);
      var positioned = style.position && style.position !== "static";
      return { el: s, i: siblings.indexOf(s), z: positioned ? (isNaN(z) ? 0 : z) : STATIC_Z };
    };
    var order = function (a, b) {
      return a.z - b.z || a.i - b.i;
    };
    var mine = layer(el);
    var up = where === "front" || where === "forward";
    var past = siblings
      .filter(function (s) {
        return s !== el && (where === "front" || where === "back" || overlaps(s, el));
      })
      .map(layer)
      .filter(function (o) {
        return up ? order(o, mine) > 0 : order(o, mine) < 0;
      })
      .sort(order);
    if (!past.length) return;
    var target = where === "front" || where === "backward" ? past[past.length - 1] : past[0];
    // Equal z-indexes paint in document order.
    var z = up
      ? target.z === STATIC_Z ? 0 : target.i < mine.i ? target.z : target.z + 1
      : target.z === STATIC_Z ? -1 : target.i > mine.i ? target.z : target.z - 1;
    var style = getComputedStyle(el);
    if (!style.position || style.position === "static") el.style.position = "relative";
    el.style.zIndex = String(z);
    // Below zero it would drop behind its parent's background, unless the parent keeps it in.
    if (z < 0 && parent !== slide) parent.style.isolation = "isolate";
    placeHandles();
    commit();
  }

  function removeSelected() {
    var el = selected;
    select(null);
    el.parentElement.removeChild(el);
    commit();
  }

  document.addEventListener("pointerdown", function (event) {
    // The pasteboard takes the middle button and Space+drag before this sees them.
    if (event.button !== 0) return;
    wires.removeAttribute("data-quiet");
    if (editing && editing.contains(event.target)) return;
    finishEditing();
    if (nudgeTimer) commit();
    if (tool !== "select") {
      event.preventDefault();
      startCreating(event);
      return;
    }
    var el = pickable(event.target, event.clientX, event.clientY);
    var now = Date.now();
    var double = el && el === lastDown.el && now - lastDown.at < DOUBLE_CLICK_MS;
    lastDown = { el: el, at: double ? 0 : now };
    select(el);
    if (!el) {
      pasteboard.startPan(event);
      return;
    }
    if (double) {
      // Otherwise the browser moves focus to what was clicked, which may be an overlay.
      event.preventDefault();
      startEditing(el, event.clientX, event.clientY);
      return;
    }
    event.preventDefault();
    var start = offsetOf(el);
    drag = { mode: "move", el: el, x: event.clientX, y: event.clientY, from: start, zoom: zoom(), moved: false };
    if (el.setPointerCapture) {
      try {
        el.setPointerCapture(event.pointerId);
      } catch (e) {
        // Synthetic events have no active pointer to capture.
      }
    }
  });

  document.addEventListener("pointermove", function (event) {
    if (create) {
      createTo(event);
      return;
    }
    if (!drag) {
      var onHandle = ui.contains(event.target);
      hover(editing || onHandle || tool !== "select" ? null : pickable(event.target, event.clientX, event.clientY));
      return;
    }
    if (drag.mode !== "move") {
      drag.moved = true;
      transformTo(event);
      return;
    }
    var dx = event.clientX - drag.x;
    var dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    lastDown = { el: null, at: 0 };
    hover(null);
    moveTo(drag.el, drag.from.x + dx / drag.zoom, drag.from.y + dy / drag.zoom);
  });

  function endDrag() {
    if (create) finishCreating();
    if (!drag) return;
    var moved = drag.moved;
    drag = null;
    if (moved) commit();
  }
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.documentElement.addEventListener("pointerleave", function () {
    hover(null);
  });
  window.addEventListener("resize", placeHandles);
  window.addEventListener("load", scheduleOverflow);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleOverflow);
  scheduleOverflow();
  document.addEventListener("input", placeHandles);
  // Clicking elsewhere in the app ends text editing, keeping the text.
  window.addEventListener("blur", finishEditing);
  document.addEventListener("dblclick", function (event) {
    if (tool !== "select") return;
    var el = pickable(event.target, event.clientX, event.clientY);
    if (el && !editing) startEditing(el, event.clientX, event.clientY);
  });

  // Pasted text arrives as plain text, so editing never brings in foreign markup.
  document.addEventListener("paste", function (event) {
    if (!editing) return;
    event.preventDefault();
    var text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
    document.execCommand("insertText", false, text);
  });
  document.addEventListener("drop", function (event) {
    if (editing) event.preventDefault();
  });

  // Capture phase, so keys the editor handles never reach the player (which forwards keys
  // to the app for slide navigation).
  window.addEventListener(
    "keydown",
    function (event) {
      if (editing) {
        if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
          event.preventDefault();
          finishEditing();
        } else if (event.key === "Enter") {
          event.preventDefault();
          document.execCommand("insertLineBreak");
        }
        event.stopImmediatePropagation();
        return;
      }
      if (tool !== "select" && event.key === "Escape") {
        cancelCreating();
        useTool("select", true);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!selected) return;
      if (event.metaKey || event.ctrlKey) {
        // Undo and other shortcuts go to the app, after any pending nudge is saved.
        if (nudgeTimer) commit();
        return;
      }
      var step = event.shiftKey ? 10 : 1;
      var nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (nudge) {
        var at = offsetOf(selected);
        moveTo(selected, at.x + nudge[0], at.y + nudge[1]);
        clearTimeout(nudgeTimer);
        nudgeTimer = setTimeout(commit, NUDGE_SAVE_MS);
      } else if (event.key === "Escape") {
        select(selected.parentElement === slide ? null : selected.parentElement);
      } else if (event.key === "Enter") {
        startEditing(selected);
      } else if (event.key === "Backspace" || event.key === "Delete") {
        removeSelected();
      } else {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data) return;
    if (data.type === "slop:edit-select") {
      finishEditing();
      select(atPath(data.path));
      // Clearing the selection for a screenshot hides the wires too, until the next interaction.
      if (data.quiet) mark(wires, "data-quiet", true);
    } else if (data.type === "slop:edit-tool") {
      toolStyle = data.style && typeof data.style === "object" ? data.style : {};
      if (data.tool !== tool) {
        cancelCreating();
        finishEditing();
        useTool(String(data.tool));
      }
    } else if (data.type === "slop:edit-style" && data.style && typeof data.style === "object") {
      finishEditing();
      applyStyle(data.style);
    } else if (data.type === "slop:edit-order") {
      finishEditing();
      restack(String(data.to));
    } else if (data.type === "slop:edit-delete") {
      finishEditing();
      if (selected) removeSelected();
    }
  });
})();
