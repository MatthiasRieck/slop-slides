/* SlopSlide slide editor. The app adds it to the stage's slide preview in edit mode (see
   src-tauri/src/protocol.rs); it is never part of deck.html or an export.

   Click selects an element, drag (or arrow keys) moves it. Its corner and edge handles
   resize its box while the opposite side stays put (Shift keeps the aspect ratio, Alt resizes
   from the center); the round handle above it rotates it and the diamond next to it tilts it
   in depth, in 3D with perspective (Shift snaps to 15°). Double-click a handle to reset.
   Resize keeps text and borders at their size; drawings spread their points. The toolbar
   can switch to Stretch, which scales the contents too. On the first box resize, an in-flow
   element leaves an invisible placeholder in its original slot so its siblings stay put.
   A line or arrow has no box: a handle at each end and on each point it bends at moves that
   point (snapping like a resize; Shift snaps to 45° from the point before it, ⌘ / Ctrl moves
   freely), dragging the small handle on a stretch of the line adds a point there, which curves
   it, and double-clicking a point in between removes it.
   Double-click (or Enter) edits its text, Escape selects the parent (see "Editing text" below).
   Dragging and resizing snap to the slide's edges and center and to other elements' edges and
   centers, with guide lines (hold ⌘ / Ctrl to move freely; Shift-resizes, and turned elements'
   resizes, do not snap), and a readout by the pointer shows the position and size.
   Shift- or ⌘-click adds to the selection or takes out of it, and dragging from empty space on
   the slide (or from a see-through wrapper that is not selected) draws a marquee around what to
   select (with Shift or ⌘, adding to the selection). ⌘A selects everything on the slide and Tab
   / Shift+Tab go through its elements. Several selected elements move, nudge, restyle, restack,
   delete, copy and duplicate together; their handles make way for a frame around each.
   ⌘D (or { type: "slop:edit-duplicate" } from the app) duplicates the selection, offset so the
   copy shows; Alt-drag leaves the original and drags a copy.
   Delete (or Backspace, or
   { type: "slop:edit-delete" } from the app) removes it; an in-flow element leaves an invisible
   `data-delete-placeholder` in its slot (or takes over its resize placeholder) so the rest of
   the layout stays put.
   Every change is posted to the app as the slide's new markup:
   { type: "slop:edit-commit", slide, markup, select, also }; `select` and `also` are the paths of
   the selection's primary element and of the others, which the app selects again after the
   reload with { type: "slop:edit-select", path, also }.

   A right-click selects what is under it and asks the app for its menu: { type: "slop:edit-menu",
   slide, x, y, element: { path, markup, name, added } | null }, with (x, y) in the preview's pixels.

   Images dropped on the slide come from the app (which saved them as assets) as
   { type: "slop:edit-insert-images", images: [{ src, w, h }], x, y }: each is placed on top,
   centered on the drop point (x, y in this window's pixels), and marked `data-dropped` until
   the agent gives it a place in the layout.
   ⌘C / ⌘X (or { type: "slop:edit-copy", cut } from the app) copy / cut the selection: it is
   posted as { type: "slop:edit-copied", slide, html, text } for the app to put on the system
   clipboard, `html` being its markup behind a header saying where it came from (for several
   elements, the header's `group` lists each one's). ⌘V goes to the
   app, which reads the clipboard and sends back what to paste. Whatever is pasted goes on top
   of the slide, absolutely positioned so the layout stays put, centered on the pointer when it
   is over the slide and otherwise in the middle of the view:
   - { type: "slop:edit-paste", html } an element copied here, sized and looking as it did
     (offset when a copy already sits at the same spot, so the copy shows);
   - { type: "slop:edit-paste-text", text, style } a text box with `text`;
   - { type: "slop:edit-paste-images", images: [{ src, w, h }] } images, as dropped ones.

   The app's edit toolbar drives the rest with messages:
   - { type: "slop:edit-tool", tool, style } picks a tool: "select", "text" (click or drag out a
     text box), "rect" / "rounded" / "ellipse" / "triangle" / "star" / "bubble" (drag out a shape,
     Shift keeps it even; the last three are boxes cut out with a `clip-path`, so they hold text
     but show no border, shadow or corner radius), "draw" (freehand), "line" / "arrow" (drag out a
     straight line, Shift snaps to 45°) or "paint" (the format painter: takes the selection's look
     and gives it to the next element clicked). `style` is what new elements get. Added elements
     are absolutely positioned on the slide with inline styles and carry `data-added` ("text",
     "shape" or "drawing", which lines and arrows are too: one <path>, `M L` when straight and
     `M C C …` through its points when curved, an arrow's head a last stroke in it, `M L L`).
     After a text box, shape, line or painted element the tool goes back to
     "select", and Escape puts any tool away; the editor tells the app with
     { type: "slop:edit-tool", slide, tool }.
   - { type: "slop:edit-style", style } restyles the selection: text color, size, font, bold,
     italic, underline, strikethrough, superscript / subscript (`script`), letter spacing, line
     height, alignment (vertical only in flex boxes, which added text boxes and shapes are),
     fill and border (a drawing's fill and stroke), and `autofit`: "shrink" (data-autofit, the
     runtime shrinks the text until it fits the box), "grow" (the box's height becomes a
     min-height, so it grows with its text) or null (overflow is only reported). Any element also
     takes `opacity` (0.05 to 1, so it stays clickable), `shadow` (blur in pixels, 0 for none; SVG
     gets a drop-shadow filter) and `radius` (corner radius in pixels), and an image `fit`
     ("contain", "cover" or "fill"), `fitPosition` ("50% 0%"), `alt`, `flipX` and `flipY` (an
     inline `transform`, after any tilt).
   - { type: "slop:edit-replace-image", src } points the selected image at another `assets/…`
     file, keeping its box (and cropping to it with `object-fit: cover`, unless it has a fit).
   - { type: "slop:edit-background", color } sets the slide's own background, or with null, goes
     back to the deck's. The editor reports it, on load and when it changes, the same way:
     { type: "slop:edit-background", slide, color }.
   - { type: "slop:edit-list", list: "ul" | "ol" } turns its text into a bulleted or numbered
     list (one item per line), switches the list's kind, or with the same kind turns it back
     into lines.
   - { type: "slop:edit-link", href } links it (wrapping its text, or an element without text,
     in an <a>; `#slide-id` links go to another slide) or with a null href removes its link.
   - { type: "slop:edit-finish" } ends text editing (the app sends it on a click outside its
     edit toolbar).
   - { type: "slop:edit-order", to } moves it "front", "forward", "backward" or "back" among the
     elements it overlaps, with an inline z-index.
   - { type: "slop:edit-size-mode", mode: "resize" | "stretch" } sets how handles change size.
   - { type: "slop:edit-delete" } removes it.
   - { type: "slop:edit-select-all" } selects everything on the slide, like ⌘A.
   - { type: "slop:edit-align", to } lines several elements up with their bounds, or one with the
     slide: "left", "center", "right", "top", "middle" or "bottom".
   - { type: "slop:edit-distribute", axis: "h" | "v" } evens out the gaps between three or more.
   - { type: "slop:edit-geometry", x, y, w, h, rotation } sets any of them, in slide pixels from
     the slide's top left. Several elements only take x and y, which move them together.
   Whenever the selection or its place changes, it reports { type: "slop:edit-geometry", slide,
   geometry: { count, x, y, w, h, rotation } } (null when nothing is selected): the unturned box
   of one element, or the bounds of several, with a null rotation.
   Whenever the selection changes it reports whether anything is selected and what the toolbar
   shows for it: { type: "slop:edit-selection", slide, selected, selection }. It reports the
   fonts the deck uses once: { type: "slop:edit-fonts", slide, fonts: [{ name, stack }] }, and
   the colors in its CSS variables: { type: "slop:edit-colors", slide, colors: [{ name, value }] }.

   Editing text: while typing, the toolbar's text styles, ⌘B / ⌘I / ⌘U and links apply to the
   selected text (wrapped in inline <span> styles, <sup> / <sub> or <a>); with only a caret, to
   the whole element. Editing survives a click on the app's toolbar (the text selection is kept
   and put back), and ends with Escape, Enter, a click elsewhere or { type: "slop:edit-finish" }.
   In a list, Enter starts a new item (Enter on an empty item outdents it, or ends the list),
   Tab / Shift+Tab indent and outdent the item, and Shift+Enter breaks the line. ⌘V pastes
   with the formatting (bold, italic, underline, strikethrough, color, links and line breaks;
   fonts and sizes are dropped), ⌘⇧V as plain text: the editor asks the app for the clipboard's
   text with { type: "slop:edit-paste-request", slide, plain: true } and the app answers with
   { type: "slop:edit-insert-text", text }.

   It runs on the pasteboard (pasteboard.js), which pans and zooms the view; dragging the empty
   space around the slide pans too (on the slide, Space+drag or the middle button). The slide no longer clips, so content that runs past its edge stays visible (dimmed
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
  var EDITOR_ATTRS = ["contenteditable", "spellcheck", "data-slop-selected", "data-slop-hover", "data-slop-editing", "data-slop-typing"];
  var MOVED = "data-moved";
  var PLACEHOLDER = "data-resize-placeholder";
  var DELETED = "data-delete-placeholder";
  // Invisible layout slots the editor leaves behind; never selected or checked for overflow.
  var SLOTS = "[" + PLACEHOLDER + "], [" + DELETED + "]";
  var DROPPED = "data-dropped";
  var DRAG_THRESHOLD = 3;
  var DOUBLE_CLICK_MS = 400;
  var NUDGE_SAVE_MS = 500;
  var ROTATE_SNAP = 15;
  // Degrees of tilt per screen pixel dragged, and how far away the viewer of a tilt stands.
  var TILT_PER_PX = 0.5;
  var PERSPECTIVE = 1000;
  // The tilt the editor puts in front of an element's inline `transform`.
  var TILT = /^perspective\([\d.]+px\) rotateX\((-?[\d.]+)deg\) rotateY\((-?[\d.]+)deg\)\s*/;
  var MIN_SCALE = 0.1;
  var sizeMode = "resize";
  var OVERFLOW_TOLERANCE = 2;
  // Marks an element the user added (a text box, shape or drawing); it stays in the markup.
  var ADDED = "data-added";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var TOOLS = ["select", "text", "rect", "rounded", "ellipse", "triangle", "star", "bubble", "draw", "line", "arrow", "paint"];
  var RADIUS = { rect: "0px", rounded: "24px", ellipse: "50%", triangle: "0px", star: "0px", bubble: "0px" };
  var SHAPE_SIZE = { w: 320, h: 200 };
  var DRAW_STEP = 2;
  var BORDER_WIDTH = 4;
  var BORDER_COLOR = "#111111";
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
  // Spots checked along each stretch of a curved line for the box around it.
  var LINE_SAMPLES = 16;
  // Shapes cut out of a box, as percentages of it; their padding keeps the text in the shape.
  var CUTOUTS = {
    triangle: { clip: "polygon(50% 0%, 100% 100%, 0% 100%)", padding: "25% 16px 16px" },
    star: { clip: "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)" },
    bubble: {
      clip:
        "polygon(8% 0%, 92% 0%, 96% 1.1%, 98.9% 4%, 100% 8%, 100% 72%, 98.9% 76%, 96% 78.9%, 92% 80%, 45% 80%, 22% 100%," +
        " 25% 80%, 8% 80%, 4% 78.9%, 1.1% 76%, 0% 72%, 0% 8%, 1.1% 4%, 4% 1.1%)",
      padding: "16px 16px 20%",
    },
  };
  // Fully transparent elements can no longer be picked.
  var MIN_OPACITY = 0.05;
  var SHADOW_COLOR = "rgba(0, 0, 0, 0.35)";
  // The blur in a CSS shadow's lengths; a drop-shadow() the editor adds to an element's filter.
  var SHADOW_LENGTHS = /-?[\d.]+px\s+-?[\d.]+px\s+([\d.]+)px/;
  var SHADOW_FILTER = /drop-shadow\((?:[^()]|\([^()]*\))*\)/;
  var MAX_DECK_COLORS = 12;
  // What the format painter takes from text.
  var PAINTED_TEXT = ["color", "fontSize", "bold", "italic", "underline", "strike", "letterSpacing", "lineHeight", "align"];

  var style = document.createElement("style");
  style.textContent =
    // The slide shows what runs past its edge.
    ".deck, .deck > .slide.active { overflow: visible !important; }" +
    ".deck > .slide.active, .deck > .slide.active * { -webkit-user-select: none; user-select: none; }" +
    "[data-slop-hover] { outline: 3px dashed rgba(59, 130, 246, 0.7) !important; outline-offset: 4px; }" +
    // The selection frame is drawn by the handle overlay, so it keeps its size on screen.
    "[data-slop-selected] { cursor: move !important; }" +
    "[data-slop-editing] { outline: 3px solid #3b82f6 !important; outline-offset: 4px; }" +
    "[data-slop-ui] { position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box; }" +
    "[data-slop-ui] * { position: absolute; box-sizing: border-box; }" +
    // The frame and its stretch handles lie in the element's plane, tilted with it.
    "[data-slop-ui] > [data-plane] { inset: 0; outline: 2px solid #3b82f6; }" +
    "[data-slop-ui] [data-handle] { pointer-events: auto; background: #fff;" +
    " border: 2px solid #3b82f6; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); touch-action: none;" +
    " width: 16px; height: 16px; }" +
    "[data-slop-ui] [data-handle=scale] { border-radius: 3px; }" +
    "[data-slop-ui] [data-axis] { border-radius: 8px; }" +
    "[data-slop-ui] [data-axis=x] { height: 24px; }" +
    "[data-slop-ui] [data-axis=y] { width: 24px; }" +
    "[data-slop-ui][data-narrow] [data-axis=y], [data-slop-ui][data-flat] [data-axis=x] { display: none; }" +
    "[data-slop-ui] > [data-handle=rotate] { border-radius: 50%; width: 18px; height: 18px; margin: 0 0 0 -9px;" +
    " left: 50%; top: -48px; cursor: grab; }" +
    "[data-slop-ui] > [data-handle=tilt] { width: 14px; height: 14px; margin: 2px 0 0 18px; left: 50%; top: -48px;" +
    " transform: rotate(45deg); cursor: move; }" +
    // A line's points, in place of the frame and handles.
    "[data-slop-points] { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }" +
    "[data-slop-points] > * { position: absolute; box-sizing: border-box; pointer-events: auto; touch-action: none; cursor: move;" +
    " width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; background: #fff; border: 2px solid #3b82f6;" +
    " box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }" +
    "[data-slop-points] > [data-point=add] { width: 10px; height: 10px; margin: -5px 0 0 -5px; background: #3b82f6;" +
    " border-color: #fff; cursor: crosshair; }" +
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
    "html[data-slop-tool=paint], html[data-slop-tool=paint] * { cursor: copy !important; }" +
    "[data-slop-ui] > [data-stem] { pointer-events: none; width: 2px; height: 32px; margin: 0 0 0 -1px;" +
    " left: 50%; top: -32px; border: 0; box-shadow: none; background: #3b82f6; }" +
    // While typing, overlays (like invisible hover zones) let clicks through to the text.
    ".deck > .slide.active[data-slop-typing] * { pointer-events: none !important; }" +
    ".deck > .slide.active[data-slop-typing] [data-slop-editing]," +
    " .deck > .slide.active[data-slop-typing] [data-slop-editing] * { pointer-events: auto !important; }" +
    ".deck > .slide.active [data-slop-editing], .deck > .slide.active [data-slop-editing] * {" +
    " -webkit-user-select: text; user-select: text; cursor: text !important; }";
  document.head.appendChild(style);

  // Scale, rotate, and tilt handles, outside the slide so they never end up in its markup. They
  // sit just outside the frame, so even small text stays clickable (and double-clickable) inside
  // it. The rotate and tilt handles stay flat, so they can be grabbed however far it is tilted.
  var ui = document.createElement("div");
  ui.setAttribute("data-slop-ui", "");
  ui.style.display = "none";
  ui.innerHTML =
    '<div data-stem></div><div data-handle="rotate" title="Rotate (Shift snaps to 15°, double-click resets)"></div>' +
    '<div data-handle="tilt" title="Tilt in 3D (Shift snaps to 15°, double-click resets)"></div><div data-plane>' +
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
          ' title="Resize (Shift keeps the aspect ratio, Alt resizes from the center)"' +
          ' style="left: ' + (d[0] + 1) * 50 + "%; top: " + (d[1] + 1) * 50 + "%; margin: " + outside(d[1], h) + "px 0 0 " +
          outside(d[0], w) + "px; cursor: " + cursor + '-resize"></div>'
        );
      })
      .join("") +
    "</div>";
  document.body.appendChild(ui);
  var plane = ui.querySelector("[data-plane]");

  var pointUi = document.createElement("div");
  pointUi.setAttribute("data-slop-points", "");
  document.body.appendChild(pointUi);

  var wires = document.createElement("div");
  wires.setAttribute("data-slop-overflow", "");
  document.body.appendChild(wires);

  // The runtime's text fit (data-autofit="shrink"); see runtime.js.
  var autofit = window.slopAutofit || null;
  // Inline elements: text runs that formatting splits and wraps. Anything else is a block.
  var INLINE = /^(a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|font|i|ins|kbd|mark|q|s|samp|small|span|strike|strong|sub|sup|time|u|var)$/i;
  // Styles that apply to the selected text while typing; the others apply to the whole element.
  var TEXT_KEYS = ["color", "fontSize", "fontFamily", "bold", "italic", "underline", "strike", "script", "letterSpacing", "link"];
  var TOGGLES = { b: "bold", i: "italic", u: "underline" };
  var LIST_TYPES = { ul: ["disc", "circle", "square"], ol: ["decimal", "lower-alpha", "lower-roman"] };
  // Elements a paste never brings into text.
  var PASTE_SKIP = /^(script|style|meta|link|title|head|template|noscript|img|picture|svg|video|audio|canvas|iframe|object|embed|button|input|select|textarea)$/i;

  var saved = serialize();
  var selected = null;
  var hovered = null;
  var editing = null;
  var drag = null;
  var nudgeTimer = null;
  var lastDown = { el: null, at: 0 };
  // The last press on one of a line's points, to tell a double-click.
  var lastPoint = { index: -1, at: 0 };
  // Where the pointer is over this window, in its pixels; null once it leaves.
  var pointer = null;
  var overflowFrame = 0;
  var reportFrame = 0;
  // The last caret or text selection in the element being edited, kept while focus is in the app.
  var textRange = null;
  // The next paste goes in as plain text (⌘⇧V).
  var plainPaste = false;
  var reportedOverflow = null;
  var tool = "select";
  var toolStyle = {};
  // The text box, shape or drawing being dragged out with a tool.
  var create = null;
  // The look the format painter took, until it is clicked onto an element.
  var painting = null;
  // The handles keep to the selection as the view pans and zooms.
  pasteboard.onChange(placeHandles);
  // Space and 0 are text while typing, and Space+drag selects it.
  pasteboard.busy = function () {
    return !!editing;
  };

  /** The slide's markup without anything the editor or the player added. */
  function serialize() {
    var copy = cleanCopy(slide);
    copy.classList.remove("active");
    return copy.outerHTML;
  }

  /** A copy of `el` without the editor's marks, or the font sizes a text fit set. */
  function cleanCopy(el) {
    var copy = el.cloneNode(true);
    var originals = withDescendants(el);
    withDescendants(copy).forEach(function (node, i) {
      EDITOR_ATTRS.forEach(function (name) {
        node.removeAttribute(name);
      });
      var before = autofit && autofit.original(originals[i]);
      if (!before) return;
      if (before.value) node.style.setProperty("font-size", before.value, before.priority);
      else node.style.removeProperty("font-size");
      if (!node.getAttribute("style")) node.removeAttribute("style");
    });
    return copy;
  }

  function withDescendants(el) {
    return [el].concat(Array.prototype.slice.call(el.querySelectorAll("*")));
  }

  function commit() {
    if (batching) return;
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
    var markup = serialize();
    if (markup === saved) return;
    saved = markup;
    window.parent.postMessage(
      { type: "slop:edit-commit", slide: slide.id, markup: markup, select: pathOf(selected), also: extras.map(pathOf) },
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
    return paintsBox(style);
  }

  /** Whether a box with this computed style shows a background, a border, or a shadow. */
  function paintsBox(style) {
    var bg = style.backgroundColor;
    var clear = !bg || bg === "transparent" || /rgba\(.*,\s*0\)$/.test(bg);
    var border = ["Top", "Right", "Bottom", "Left"].some(function (side) {
      return parseFloat(style["border" + side + "Width"]) > 0 && style["border" + side + "Style"] !== "none";
    });
    return !clear || (style.backgroundImage || "none") !== "none" || border || (style.boxShadow || "none") !== "none";
  }

  /** The element to select for `el`: not inline text runs, whole SVG drawings. */
  function selectable(el) {
    if (!el || el.nodeType !== 1 || !slide.contains(el) || el === slide || el.closest(SLOTS)) return null;
    var svg = el.closest("svg");
    while (svg && svg.parentElement && svg.parentElement.closest("svg")) svg = svg.parentElement.closest("svg");
    if (svg && slide.contains(svg)) el = svg;
    while (el.parentElement !== slide && getComputedStyle(el).display === "inline") {
      // A link around an element without text (display: contents) leaves the element selected.
      if (getComputedStyle(el.parentElement).display === "contents") break;
      el = el.parentElement;
    }
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
    if (el === selected && !extras.length) return;
    clearExtras();
    mark(selected, "data-slop-selected", false);
    selected = el;
    mark(selected, "data-slop-selected", true);
    placeHandles();
    report();
  }

  /** Tells the app what its toolbar shows for the selection. */
  function report() {
    reportFrame = 0;
    window.parent.postMessage({ type: "slop:edit-selection", slide: slide.id, selected: !!selected, selection: describe(selected) }, "*");
  }

  /** Reports once per frame, however often the text selection moves while typing. */
  function scheduleReport() {
    if (!reportFrame) reportFrame = window.requestAnimationFrame(report);
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

  function weightOf(style) {
    return style.fontWeight === "bold" ? 700 : parseInt(style.fontWeight, 10) || 400;
  }

  /** The first family of a CSS `font-family` stack, unquoted. */
  function firstFamily(stack) {
    return String(stack || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  }

  /** Whether `node` (an element) shows `line` ("underline" or "line-through"), from it or an ancestor. */
  function decorated(node, line) {
    var tags = line === "underline" ? /^u$/i : /^(s|strike|del)$/i;
    for (var n = node; n && n.nodeType === 1 && n !== slide.parentElement; n = n.parentElement) {
      var style = getComputedStyle(n);
      if (tags.test(n.tagName) || (style.textDecorationLine || "").indexOf(line) >= 0 || (style.textDecoration || "").indexOf(line) >= 0) {
        return true;
      }
      if (n === slide) break;
    }
    return false;
  }

  /** The element the text selection starts in, while `el` is being edited; otherwise `el`. */
  function textNodeOf(el) {
    var range = editing === el ? editRange() : null;
    if (!range) return el;
    var node = range.startContainer;
    if (node.nodeType === 1 && !range.collapsed && node.childNodes[range.startOffset]) node = node.childNodes[range.startOffset];
    if (node.nodeType !== 1) node = node.parentNode;
    return node && node.nodeType === 1 && el.contains(node) ? node : el;
  }

  /** The list `el`'s text is in: `el` itself, its item's, the one at the caret, or one it holds. */
  function listOf(el, node) {
    if (/^(ul|ol)$/i.test(el.tagName)) return el;
    if (/^li$/i.test(el.tagName) && /^(ul|ol)$/i.test(el.parentElement.tagName)) return el.parentElement;
    var at = node && node !== el ? node.closest("ul, ol") : null;
    if (at && el.contains(at)) return at;
    return Array.prototype.find.call(el.children, function (child) {
      return /^(ul|ol)$/i.test(child.tagName);
    }) || null;
  }

  /** The link `el` (or the text at `node` in it) is in, or that wraps all of its text. */
  function linkOf(el, node) {
    var at = (node || el).closest("a");
    if (at && (slide.contains(at) || at === el)) return at;
    var only = el.children.length === 1 && el.firstElementChild;
    return only && /^a$/i.test(only.tagName) && only.textContent.trim() === el.textContent.trim() ? only : null;
  }

  /** The line height as a multiple of the font size; null when it is `normal`. */
  function lineHeightOf(style) {
    var size = parseFloat(style.fontSize);
    var value = style.lineHeight;
    if (!value || value === "normal") return null;
    if (/px$/.test(value)) return size ? Math.round((parseFloat(value) / size) * 100) / 100 : null;
    return parseFloat(value) || null;
  }

  /** What the toolbar shows for `el`: its kind, text styles (of the selected text, while typing), fill and border. */
  function describe(el) {
    if (!el) return null;
    var style = getComputedStyle(el);
    var tag = el.tagName.toLowerCase();
    var kind = el.getAttribute(ADDED) || (/^(img|svg|video|canvas|picture|iframe|object|embed)$/.test(tag) ? "media" : "element");
    var vectors = vectorsOf(el);
    var first = vectors[0];
    var borderWidth = style.borderTopStyle && style.borderTopStyle !== "none" ? parseFloat(style.borderTopWidth) || 0 : 0;
    var align = style.textAlign || "left";
    var node = textNodeOf(el);
    var text = node === el ? style : getComputedStyle(node);
    var range = editing === el ? editRange() : null;
    var script = node.closest("sup, sub");
    var link = linkOf(el, node);
    var list = listOf(el, node);
    // A shrunk box reports the sizes it was given, not the ones it shrank to.
    var fit = autofit ? autofit.scale(el.closest('[data-autofit="shrink"]') || el) : 1;
    var spacing = parseFloat(text.letterSpacing);
    var look = lookOf(el, style);
    return {
      kind: kind,
      text: kind !== "drawing" && kind !== "media",
      vector: kind === "drawing",
      color: toHex(text.color),
      fontSize: Math.round(parseFloat(text.fontSize) / fit) || null,
      fontFamily: firstFamily(text.fontFamily) || null,
      bold: weightOf(text) >= 600,
      italic: text.fontStyle === "italic",
      underline: decorated(node, "underline"),
      strike: decorated(node, "line-through"),
      script: script && el.contains(script) ? script.tagName.toLowerCase() : null,
      letterSpacing: isFinite(spacing) ? Math.round(spacing * 10) / 10 : 0,
      lineHeight: lineHeightOf(style),
      align: /center/.test(align) ? "center" : /right|end/.test(align) ? "right" : "left",
      valign: valignOf(style),
      list: list ? list.tagName.toLowerCase() : null,
      link: link ? link.getAttribute("href") || "" : null,
      autofit: /^(shrink|grow)$/.test(el.getAttribute("data-autofit") || "") ? el.getAttribute("data-autofit") : null,
      editing: editing === el,
      range: !!range && !range.collapsed,
      fill: first ? paintOf(first, "fill") : toHex(style.backgroundColor),
      stroke: first ? paintOf(first, "stroke") : borderWidth ? toHex(style.borderTopColor) : null,
      strokeWidth: first ? parseFloat(first.getAttribute("stroke-width")) || 0 : borderWidth,
      opacity: look.opacity,
      shadow: look.shadow,
      radius: look.radius,
      clipped: look.clipped,
      image: look.image,
      fit: look.fit,
      fitPosition: look.fitPosition,
      alt: look.alt,
      flipX: look.flipX,
      flipY: look.flipY,
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
    var priority = el.style.getPropertyPriority(prop);
    el.style[prop] = "";
    var value = getComputedStyle(el)[prop];
    el.style.setProperty(prop, inline, priority);
    return value;
  }

  /** The element's 3D tilt in degrees: around its horizontal (x) and vertical (y) axis. */
  function tiltOf(el) {
    var match = (el.style.transform || "").match(TILT);
    return match ? { x: parseFloat(match[1]), y: parseFloat(match[2]) } : { x: 0, y: 0 };
  }

  /**
   * Tilts `el` in depth with an inline `transform` (there is no separate property for it), seen
   * with perspective. It is `!important` so entrance animations, which animate `transform`,
   * cannot undo it, and keeps whatever `transform` the element already had after the tilt.
   */
  function tiltTo(el, x, y) {
    x = wrapAngle(x);
    y = wrapAngle(y);
    var inline = el.style.transform;
    var sheet = sheetValue(el, "transform");
    // An entrance animation that ended leaves the identity matrix.
    sheet = !sheet || sheet === "none" || sheet === "matrix(1, 0, 0, 1, 0, 0)" ? "" : sheet;
    var rest = inline ? inline.replace(TILT, "") : sheet;
    if (x || y) {
      var tilt = "perspective(" + PERSPECTIVE + "px) rotateX(" + x + "deg) rotateY(" + y + "deg)";
      setInline(el, "transform", rest ? tilt + " " + rest : tilt, "important");
    } else {
      setInline(el, "transform", rest && rest !== sheet ? rest : null);
    }
  }

  /** Whole degrees in (-180, 180]. */
  function wrapAngle(degrees) {
    degrees = Math.round(degrees) % 360;
    if (degrees > 180) degrees -= 360;
    if (degrees <= -180) degrees += 360;
    return degrees;
  }

  function rotateTo(el, degrees) {
    degrees = wrapAngle(degrees);
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
  function setInline(el, prop, value, priority) {
    if (value === null) el.style.removeProperty(prop);
    else el.style.setProperty(prop, value, priority || "");
    if (!el.getAttribute("style")) el.removeAttribute("style");
    mark(el, MOVED, !!(el.style.translate || el.style.rotate || el.style.scale || TILT.test(el.style.transform || "")));
    placeHandles();
  }

  /** The center of the element's box on screen; a tilt in perspective would shift its bounds. */
  function centerOf(el) {
    var inline = el.style.transform || "";
    var tilted = TILT.test(inline);
    var priority = el.style.getPropertyPriority("transform");
    if (tilted) el.style.setProperty("transform", inline.replace(TILT, "") || "none", priority);
    var rect = el.getBoundingClientRect();
    if (tilted) el.style.setProperty("transform", inline, priority);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** The element's untransformed size, in slide pixels. */
  function sizeOf(el) {
    var computed = getComputedStyle(el);
    var px = function (name) { return parseFloat(computed[name]) || 0; };
    var contentBox = computed.boxSizing !== "border-box";
    // offsetWidth/Height round to whole pixels, which can shift flex/grid siblings.
    return {
      w: /px$/.test(computed.width) ? px("width") + (contentBox ? px("paddingLeft") + px("paddingRight") + px("borderLeftWidth") + px("borderRightWidth") : 0) : el.offsetWidth || 0,
      h: /px$/.test(computed.height) ? px("height") + (contentBox ? px("paddingTop") + px("paddingBottom") + px("borderTopWidth") + px("borderBottomWidth") : 0) : el.offsetHeight || 0,
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
    scheduleGeometry();
    placeFrames();
    if (placePoints() || !selected || editing || extras.length || !slide.contains(selected)) {
      ui.style.display = "none";
      return;
    }
    var center = centerOf(selected);
    var size = sizeOf(selected);
    var scale = scaleOf(selected);
    var w = size.w * scale.x * zoom();
    var h = size.h * scale.y * zoom();
    ui.style.display = "";
    ui.style.left = center.x - w / 2 + "px";
    ui.style.top = center.y - h / 2 + "px";
    ui.style.width = w + "px";
    ui.style.height = h + "px";
    ui.style.transform = "rotate(" + angleOf(selected) + "deg)";
    // The frame tilts like the element; its perspective scales with it to look the same.
    var tilt = tiltOf(selected);
    var k = zoom() * Math.sqrt(scale.x * scale.y);
    plane.style.transform =
      tilt.x || tilt.y ? "perspective(" + PERSPECTIVE * k + "px) rotateX(" + tilt.x + "deg) rotateY(" + tilt.y + "deg)" : "";
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
    var dir = (event.target.getAttribute("data-dir") || "0 0").split(" ").map(Number);
    drag = {
      mode: kind,
      el: selected,
      center: centerOf(selected),
      start: { x: event.clientX, y: event.clientY },
      angle: angleOf(selected),
      tilt: tiltOf(selected),
      scale: scaleOf(selected),
      offset: offsetOf(selected),
      size: sizeOf(selected),
      zoom: zoom(),
      dir: { x: dir[0], y: dir[1] },
      resize: sizeMode === "resize",
      vectors: sizeMode === "resize" && selected.getAttribute(ADDED) === "drawing" ? vectorShapes(selected) : null,
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
    else if (kind === "tilt") tiltTo(selected, 0, 0);
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
    if (drag.mode === "tilt") {
      // Like rolling a ball: the side the pointer pulls towards turns away. Dragging follows
      // the element's own axes, however it is rotated.
      var pulled = turn(event.clientX - drag.start.x, event.clientY - drag.start.y, -drag.angle);
      var snap = function (deg) {
        return event.shiftKey ? Math.round(deg / ROTATE_SNAP) * ROTATE_SNAP : deg;
      };
      tiltTo(drag.el, snap(drag.tilt.x - pulled.y * TILT_PER_PX), snap(drag.tilt.y + pulled.x * TILT_PER_PX));
      return;
    }
    var to = snapResize(event);
    stretchTo(to.x, to.y, event.shiftKey, event.altKey);
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
    if (drag.resize) {
      resizeTo(sx, sy, shift);
      return;
    }
    scaleTo(drag.el, sx, sy);
    moveTo(drag.el, drag.offset.x + shift.x, drag.offset.y + shift.y);
  }

  /** The invisible layout slot immediately following its freely positioned element. */
  function placeholderOf(el) {
    var next = el.nextElementSibling;
    return next && next.hasAttribute(PLACEHOLDER) ? next : null;
  }

  /** An invisible, inert copy of an in-flow element that fills exactly its layout slot. */
  function slotFor(el, attr) {
    var computed = getComputedStyle(el);
    var size = sizeOf(el);
    var placeholder = el.cloneNode(true);
    // Capture resolved styles so ID selectors and inherited styles still reserve the same slot.
    // Keep a hidden copy of the contents for its text baseline and intrinsic grid sizing.
    placeholder.style.cssText = "";
    for (var i = 0; i < computed.length; i++) {
      var prop = computed[i];
      placeholder.style.setProperty(prop, computed.getPropertyValue(prop));
    }
    placeholder.setAttribute(attr, "");
    placeholder.setAttribute("aria-hidden", "true");
    placeholder.setAttribute("inert", "");
    [placeholder].concat(Array.prototype.slice.call(placeholder.querySelectorAll("*"))).forEach(function (node) {
      ["id", MOVED, ADDED, DROPPED].concat(EDITOR_ATTRS).forEach(function (name) { node.removeAttribute(name); });
      node.style.setProperty("visibility", "hidden", "important");
      node.style.setProperty("pointer-events", "none", "important");
      node.style.setProperty("animation", "none", "important");
      node.style.setProperty("transition", "none", "important");
    });
    placeholder.style.boxSizing = "border-box";
    placeholder.style.width = placeholder.style.minWidth = placeholder.style.maxWidth = size.w + "px";
    placeholder.style.height = placeholder.style.minHeight = placeholder.style.maxHeight = size.h + "px";
    // A fixed flex contribution preserves the space already allocated after grow/shrink.
    placeholder.style.flex = "0 0 auto";
    return placeholder;
  }

  /** Reserves the original footprint before taking an element out of normal flow. */
  function reserveLayout(el) {
    var computed = getComputedStyle(el);
    if (/^(absolute|fixed)$/.test(computed.position) || placeholderOf(el)) return;
    var size = sizeOf(el);
    var center = centerOf(el);
    el.parentElement.insertBefore(slotFor(el, PLACEHOLDER), el.nextSibling);
    var contentBox = computed.boxSizing !== "border-box";
    var px = function (name) { return parseFloat(computed[name]) || 0; };
    var width = size.w - (contentBox ? px("paddingLeft") + px("paddingRight") + px("borderLeftWidth") + px("borderRightWidth") : 0);
    var height = size.h - (contentBox ? px("paddingTop") + px("paddingBottom") + px("borderTopWidth") + px("borderBottomWidth") : 0);
    el.style.position = "absolute";
    el.style.margin = "0px";
    el.style.left = el.style.top = "0px";
    el.style.right = el.style.bottom = "auto";
    el.style.width = Math.max(0, width) + "px";
    el.style.height = Math.max(0, height) + "px";
    // Locate it in its existing containing block, preserving its rotation, scale and translate.
    var placed = centerOf(el);
    el.style.left = (center.x - placed.x) / drag.zoom + "px";
    el.style.top = (center.y - placed.y) / drag.zoom + "px";
  }

  /** Changes the border box without scaling its contents or discarding an existing scale. */
  function resizeTo(sx, sy, shift) {
    var el = drag.el;
    reserveLayout(el);
    var w = drag.size.w;
    var h = drag.size.h;
    var nw = Math.max(1, Math.round(w * sx / drag.scale.x * 1000) / 1000);
    var nh = Math.max(1, Math.round(h * sy / drag.scale.y * 1000) / 1000);
    var computed = getComputedStyle(el);
    var px = function (name) { return parseFloat(computed[name]) || 0; };
    var contentBox = computed.boxSizing !== "border-box";
    var paddingX = contentBox ? px("paddingLeft") + px("paddingRight") + px("borderLeftWidth") + px("borderRightWidth") : 0;
    var paddingY = contentBox ? px("paddingTop") + px("paddingBottom") + px("borderTopWidth") + px("borderBottomWidth") : 0;
    el.style.width = Math.max(0, nw - paddingX) + "px";
    el.style.minWidth = "0px";
    if (el.getAttribute("data-autofit") === "grow") {
      // A box that grows with its text keeps the height as its least.
      el.style.height = "auto";
      el.style.minHeight = Math.max(0, nh - paddingY) + "px";
    } else {
      el.style.height = Math.max(0, nh - paddingY) + "px";
      el.style.minHeight = "0px";
    }
    el.style.maxWidth = "none";
    el.style.maxHeight = "none";
    el.style.flexShrink = "0";
    el.style.flexBasis = "auto";
    if (computed.display === "inline") el.style.display = "inline-block";
    if (computed.whiteSpace === "nowrap") el.style.whiteSpace = "normal";
    if (drag.vectors && w && h) spreadVectors(drag.vectors, nw / w, nh / h);
    // Layout grows from the top left; translate compensates to keep the opposite handle fixed.
    moveTo(el, drag.offset.x + shift.x - (nw - w) / 2, drag.offset.y + shift.y - (nh - h) / 2);
  }

  /** The element's viewBox as [x, y, w, h], or null without a usable one. */
  function viewBoxOf(el) {
    var box = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(parseFloat);
    return box.length === 4 && box.every(isFinite) && box[2] > 0 && box[3] > 0 ? box : null;
  }

  /** A drawing's viewBox and its shapes' geometry, as they were when the stretch started. */
  function vectorShapes(el) {
    var vectors = vectorsOf(el);
    return {
      el: el,
      viewBox: viewBoxOf(el),
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
    // A line's curve and head are redrawn through its spread points, not spread with them.
    var line = lineOf(shapes.el);
    if (line) line.path.setAttribute("d", lineData(line.points, line.arrow, line.width, 0, 0));
  }

  function roundTenth(n) {
    return Math.round(n * 10) / 10;
  }

  var NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
  // What each parameter of a path command is: X / Y a point's coordinate, x / y a length
  // along that axis, - anything else (an angle or a flag).
  var PATH_PARAMS = { M: "XY", L: "XY", T: "XY", C: "XY", S: "XY", Q: "XY", H: "X", V: "Y", A: "xy---XY", Z: "" };
  // A line's path (see lineData): its stroke, straight or curved, and then an arrow's head.
  var PATH_POINT = "\\s*" + NUMBER.source + "[\\s,]+" + NUMBER.source + "\\s*";
  var LINE_PATH = new RegExp(
    "^\\s*(M" + PATH_POINT + "(?:L" + PATH_POINT + "|(?:C" + PATH_POINT + PATH_POINT + PATH_POINT + ")+))" +
      "(M" + PATH_POINT + "L" + PATH_POINT + "L" + PATH_POINT + ")?$",
  );

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
      if ((svg && svg !== el) || el.closest(".notes, .narration, " + SLOTS)) return;
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

  /** `el` in a few words: its tag and the start of its text. */
  function nameOf(el) {
    var text = el.textContent.replace(/\s+/g, " ").trim();
    return "<" + el.tagName.toLowerCase() + ">" + (text ? ' "' + text.slice(0, 40) + (text.length > 40 ? "…" : "") + '"' : "");
  }

  function describeOverflow(hit) {
    var what = hit.past.map(function (p) {
      return "runs past the " + p.side + " edge by " + p.by + "px";
    });
    if (hit.cut) what.push("is cut off by its own box");
    return nameOf(hit.el) + " " + what.join(" and ");
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
    textRange = null;
    el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "true");
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
    textRange = range.cloneRange();
    report();
  }

  function finishEditing() {
    if (!editing) return;
    var el = editing;
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
    el.removeAttribute("data-slop-editing");
    slide.removeAttribute("data-slop-typing");
    editing = null;
    textRange = null;
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    // A text box left empty goes away.
    if (el.getAttribute(ADDED) === "text" && !el.textContent.trim()) {
      if (selected === el) select(null);
      el.parentElement.removeChild(el);
    } else {
      dropTrailingBreaks(el);
      refit(el);
    }
    placeHandles();
    if (selected === el) report();
    commit();
  }

  /** Enter at the end of the text leaves line breaks for the caret that would stay as blank lines. */
  function dropTrailingBreaks(el) {
    while (el.lastChild && (el.lastChild.nodeName === "BR" || (el.lastChild.nodeType === 3 && !el.lastChild.data))) {
      el.removeChild(el.lastChild);
    }
  }

  /** The text selection (or caret) in the element being edited, or the last one it had. */
  function editRange() {
    if (!editing) return null;
    var selection = window.getSelection();
    if (selection && selection.rangeCount) {
      var live = selection.getRangeAt(0);
      if (editing.contains(live.startContainer) && editing.contains(live.endContainer)) textRange = live.cloneRange();
    }
    if (textRange && editing.contains(textRange.startContainer) && editing.contains(textRange.endContainer)) return textRange;
    return null;
  }

  /** Makes `range` the text selection again, with focus in the text. */
  function useRange(range) {
    if (!editing) return;
    if (document.activeElement !== editing && editing.focus) editing.focus();
    var selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    textRange = range.cloneRange();
  }

  /** Where `range` starts and ends in `root`'s text, in characters. */
  function textOffsets(root, range) {
    var before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    var start = before.toString().length;
    return { start: start, end: start + range.toString().length };
  }

  /** The range spanning characters `start` to `end` of `root`'s text. */
  function rangeAt(root, at) {
    var range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(true);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var seen = 0;
    var started = false;
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var end = seen + node.data.length;
      // A selection starts in the text after a boundary, and ends in the text before it.
      if (!started && (at.start < end || (at.start === end && at.start === at.end))) {
        range.setStart(node, at.start - seen);
        started = true;
      }
      if (started && at.end <= end) {
        range.setEnd(node, at.end - seen);
        return range;
      }
      seen = end;
    }
    var whole = document.createRange();
    whole.selectNodeContents(root);
    if (started) range.setEnd(whole.endContainer, whole.endOffset);
    else range = whole;
    if (!started) range.collapse(false);
    return range;
  }

  /** The caret's place by node, which survives moving nodes (unlike a live range). */
  function caretOf(range) {
    return { sc: range.startContainer, so: range.startOffset, ec: range.endContainer, eo: range.endOffset };
  }

  function rangeFromCaret(caret, root) {
    if (!root.contains(caret.sc) || !root.contains(caret.ec)) return null;
    var range = document.createRange();
    try {
      range.setStart(caret.sc, Math.min(caret.so, lengthOf(caret.sc)));
      range.setEnd(caret.ec, Math.min(caret.eo, lengthOf(caret.ec)));
    } catch (e) {
      return null;
    }
    return range;
  }

  function lengthOf(node) {
    return node.nodeType === 1 ? node.childNodes.length : node.data.length;
  }

  function isInline(node) {
    return node.nodeType !== 1 || INLINE.test(node.tagName);
  }

  /** Whether `node` holds anything that shows: text, a line break, or media. */
  function hasContent(node) {
    return !!(node.textContent.trim() || (node.querySelector && node.querySelector("br, img, svg")) || /^(br|img|svg)$/i.test(node.nodeName));
  }

  /** Replaces `node` with its children. */
  function unwrap(node) {
    var parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }

  /** Puts `node` inside `wrapper`, where `node` was. */
  function wrap(node, wrapper) {
    node.parentNode.insertBefore(wrapper, node);
    wrapper.appendChild(node);
    return wrapper;
  }

  function cloneShallow(el) {
    var copy = el.cloneNode(false);
    copy.removeAttribute("id");
    return copy;
  }

  /**
   * Splits the inline elements around text node `t` (up to its block) so each holds only `t`,
   * and returns them, innermost first: restyling them restyles exactly `t`.
   */
  function isolate(t, root) {
    var chain = [];
    var node = t;
    while (node.parentNode && node.parentNode !== root && isInline(node.parentNode)) {
      var parent = node.parentNode;
      if (node.previousSibling) {
        var head = cloneShallow(parent);
        while (parent.firstChild !== node) head.appendChild(parent.firstChild);
        parent.parentNode.insertBefore(head, parent);
      }
      if (node.nextSibling) {
        var tail = cloneShallow(parent);
        while (node.nextSibling) tail.appendChild(node.nextSibling);
        parent.parentNode.insertBefore(tail, parent.nextSibling);
      }
      chain.push(parent);
      node = parent;
    }
    return chain;
  }

  function removeLine(el, line) {
    ["text-decoration-line", "text-decoration"].forEach(function (prop) {
      var value = el.style.getPropertyValue(prop);
      if (!value || value.indexOf(line) < 0) return;
      var rest = value.split(/\s+/).filter(function (part) {
        return part && part !== line;
      });
      if (rest.length && !/^(none|solid|double|dotted|dashed|wavy)$/.test(rest.join(" "))) el.style.setProperty(prop, rest.join(" "));
      else el.style.removeProperty(prop);
    });
  }

  /**
   * Takes the formatting `changes` replace off `el`: inline styles, and tags that only mean
   * that formatting (`keep` leaves the element itself in place).
   */
  function stripFormatting(el, changes, keep) {
    var has = function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    };
    var tag = el.tagName.toLowerCase();
    var props = { color: "color", fontSize: "font-size", fontFamily: "font-family", bold: "font-weight", italic: "font-style", letterSpacing: "letter-spacing" };
    Object.keys(props).forEach(function (key) {
      if (has(key)) el.style.removeProperty(props[key]);
    });
    if (has("underline")) removeLine(el, "underline");
    if (has("strike")) removeLine(el, "line-through");
    if (has("script")) el.style.removeProperty("vertical-align");
    if (tag === "font") {
      if (has("color")) el.removeAttribute("color");
      if (has("fontSize")) el.removeAttribute("size");
      if (has("fontFamily")) el.removeAttribute("face");
    }
    if (!el.getAttribute("style")) el.removeAttribute("style");
    var means =
      (has("bold") && /^(b|strong)$/.test(tag)) ||
      (has("italic") && /^(i|em)$/.test(tag)) ||
      (has("underline") && tag === "u") ||
      (has("strike") && /^(s|strike|del)$/.test(tag)) ||
      (has("script") && /^(sup|sub)$/.test(tag)) ||
      (has("link") && tag === "a") ||
      (/^(span|font)$/.test(tag) && !el.attributes.length);
    if (means && !keep) unwrap(el);
  }

  /**
   * Gives text node `t` the formatting `changes`, where its surroundings do not already: on
   * the <span> that holds only it, or a new one around it.
   */
  function applyFormatting(t, changes, root) {
    var has = function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    };
    var own = t.parentNode !== root && /^span$/i.test(t.parentNode.tagName) && t.parentNode.childNodes.length === 1;
    if (own) {
      // What its own span already sets for these gives way, so the comparison is with its surroundings.
      stripFormatting(t.parentNode, changes, true);
    }
    var around = getComputedStyle(own ? t.parentNode.parentNode : t.parentNode);
    var span = own ? t.parentNode : document.createElement("span");
    if (has("bold") && changes.bold !== weightOf(around) >= 600) span.style.fontWeight = changes.bold ? "700" : "400";
    if (has("italic") && changes.italic !== (around.fontStyle === "italic")) span.style.fontStyle = changes.italic ? "italic" : "normal";
    if (has("color") && changes.color && toHex(around.color) !== changes.color) span.style.color = changes.color;
    if (has("fontSize") && changes.fontSize > 0 && Math.round(parseFloat(around.fontSize)) !== Math.round(changes.fontSize)) {
      span.style.fontSize = Math.round(changes.fontSize) + "px";
    }
    if (has("fontFamily") && changes.fontFamily && firstFamily(around.fontFamily) !== firstFamily(changes.fontFamily)) {
      span.style.fontFamily = changes.fontFamily;
    }
    if (has("letterSpacing") && isFinite(changes.letterSpacing)) {
      var now = parseFloat(around.letterSpacing) || 0;
      if (now !== changes.letterSpacing) span.style.letterSpacing = changes.letterSpacing ? changes.letterSpacing + "px" : "normal";
    }
    var lines = [];
    if (changes.underline && !decorated(t.parentNode, "underline")) lines.push("underline");
    if (changes.strike && !decorated(t.parentNode, "line-through")) lines.push("line-through");
    if (lines.length) {
      var kept = span.style.getPropertyValue("text-decoration-line");
      span.style.setProperty("text-decoration-line", (kept && kept !== "none" ? kept + " " : "") + lines.join(" "));
    }
    var node = own ? span : t;
    if (!own && span.getAttribute("style")) node = wrap(node, span);
    if (changes.script === "sup" || changes.script === "sub") node = wrap(node, document.createElement(changes.script));
    if (changes.link) node = wrap(node, linkTo(document.createElement("a"), changes.link));
  }

  /** The text nodes `range` covers, split at its ends so it covers each one whole. */
  function coveredText(range, root) {
    if (range.startContainer.nodeType === 3 && range.startOffset > 0 && range.startOffset < range.startContainer.data.length) {
      var rest = range.startContainer.splitText(range.startOffset);
      if (range.endContainer === range.startContainer) range.setEnd(rest, range.endOffset - range.startOffset);
      range.setStart(rest, 0);
    }
    if (range.endContainer.nodeType === 3 && range.endOffset > 0 && range.endOffset < range.endContainer.data.length) {
      range.endContainer.splitText(range.endOffset);
    }
    var nodes = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.length && range.comparePoint(node, 0) >= 0 && range.comparePoint(node, node.data.length) <= 0) nodes.push(node);
    }
    return nodes;
  }

  /** Merges neighboring inline elements that look the same, and drops empty, attribute-less ones. */
  function tidy(root) {
    Array.prototype.slice.call(root.querySelectorAll("*")).reverse().forEach(function (el) {
      if (!INLINE.test(el.tagName) || el.attributes.length) return;
      if (!hasContent(el)) el.parentNode.removeChild(el);
      else if (/^(span|font)$/i.test(el.tagName)) unwrap(el);
    });
    withDescendants(root).forEach(function (el) {
      for (var child = el.firstChild; child; child = child.nextSibling) {
        var next = child.nextSibling;
        while (next && sameInline(child, next)) {
          while (next.firstChild) child.appendChild(next.firstChild);
          el.removeChild(next);
          next = child.nextSibling;
        }
      }
    });
    root.normalize();
  }

  function sameInline(a, b) {
    if (a.nodeType !== 1 || b.nodeType !== 1 || a.tagName !== b.tagName || !INLINE.test(a.tagName)) return false;
    if (a.attributes.length !== b.attributes.length) return false;
    return Array.prototype.every.call(a.attributes, function (attr) {
      return b.getAttribute(attr.name) === attr.value;
    });
  }

  /** Gives the text `range` covers in the element being edited the formatting `changes`. */
  function formatRange(range, changes) {
    var root = editing;
    var at = textOffsets(root, range);
    coveredText(range, root).forEach(function (t) {
      isolate(t, root).forEach(function (el) {
        if (el !== t.parentNode || !/^span$/i.test(el.tagName)) stripFormatting(el, changes);
      });
      applyFormatting(t, changes, root);
    });
    tidy(root);
    useRange(rangeAt(root, at));
  }

  /** Changes to the text while typing, without losing the text selection or the text fit. */
  function changeText(el, change) {
    if (autofit) autofit.unfit(el);
    change();
    refit(el);
    placeHandles();
  }

  /** Shrinks the text of a `data-autofit="shrink"` box again until it fits. */
  function refit(el) {
    if (autofit && el && el.getAttribute && el.getAttribute("data-autofit") === "shrink") autofit.fit(el);
  }

  /**
   * Restyles the text being edited: the text styles go to the selected text (or with a caret,
   * the whole element), the rest to the element.
   */
  function styleText(changes) {
    var el = editing;
    var range = editRange();
    var text = {};
    var rest = {};
    Object.keys(changes).forEach(function (key) {
      (TEXT_KEYS.indexOf(key) >= 0 && range && !range.collapsed ? text : rest)[key] = changes[key];
    });
    if (Object.keys(text).length) {
      changeText(el, function () {
        formatRange(range, text);
      });
    }
    if (Object.keys(rest).length) {
      applyStyle(rest);
      var again = editRange();
      if (again) useRange(again);
    }
    report();
  }

  /** ⌘B / ⌘I / ⌘U: turns bold, italic or underline on or off, as the selected text has it now. */
  function toggleStyle(key) {
    var now = describe(selected);
    if (!now || !now.text) return;
    var changes = {};
    changes[key] = !now[key];
    if (editing) styleText(changes);
    else applyToSelection(changes);
  }

  /** Lines of `el`'s content, as fragments: split at line breaks and blocks, list items one each. */
  function linesOf(el) {
    var lines = [document.createDocumentFragment()];
    var current = function () {
      return lines[lines.length - 1];
    };
    var breakLine = function () {
      if (current().childNodes.length) lines.push(document.createDocumentFragment());
    };
    var take = function (container) {
      Array.prototype.slice.call(container.childNodes).forEach(function (node) {
        if (node.nodeName === "BR") {
          lines.push(document.createDocumentFragment());
        } else if (isInline(node)) {
          current().appendChild(node);
        } else if (/^(ul|ol)$/i.test(node.tagName)) {
          breakLine();
          Array.prototype.slice.call(node.children).forEach(function (item) {
            take(item);
            breakLine();
          });
        } else {
          breakLine();
          take(node);
          breakLine();
        }
      });
    };
    take(el);
    var full = lines.filter(hasContent);
    return full.length ? full : [document.createDocumentFragment()];
  }

  function styleList(list, depth) {
    list.style.margin = "0";
    list.style.paddingLeft = "1.2em";
    list.style.listStyleType = LIST_TYPES[list.tagName.toLowerCase()][depth % 3];
  }

  /** How many lists `list` is nested in, inside `root`. */
  function depthOf(list, root) {
    var depth = 0;
    for (var n = list.parentElement; n && n !== root && root.contains(n); n = n.parentElement) {
      if (/^(ul|ol)$/i.test(n.tagName)) depth++;
    }
    return depth;
  }

  /** `list` as a list of `kind`, keeping its attributes, items and an editor-set bullet style. */
  function retag(list, kind, root) {
    var next = document.createElement(kind);
    Array.prototype.forEach.call(list.attributes, function (attr) {
      next.setAttribute(attr.name, attr.value);
    });
    while (list.firstChild) next.appendChild(list.firstChild);
    list.parentNode.replaceChild(next, list);
    if (next.style.listStyleType) next.style.listStyleType = LIST_TYPES[kind][depthOf(next, root) % 3];
    return next;
  }

  function ensureLine(item) {
    if (!hasContent(item)) item.appendChild(document.createElement("br"));
  }

  /**
   * Turns the selection's text into a list of `kind` ("ul" or "ol"), one item per line; turns
   * its list into one of `kind`, or one of `kind` already back into lines.
   */
  function toggleList(kind) {
    var el = editing || selected;
    if (!el || !slide.contains(el) || !LIST_TYPES[kind] || !describe(el).text) return;
    var range = editing ? editRange() : null;
    var caret = range ? caretOf(range) : null;
    changeText(el, function () {
      var list = listOf(el, range ? textNodeOf(el) : null);
      if (list && list.tagName.toLowerCase() !== kind) {
        var next = retag(list, kind, el);
        if (list === el) {
          if (editing === el) editing = next;
          selected = next;
          mark(next, "data-slop-selected", true);
        }
      } else if (list && list !== el && el.contains(list)) {
        var lines = linesOf(list);
        var flat = document.createDocumentFragment();
        lines.forEach(function (line, i) {
          if (i) flat.appendChild(document.createElement("br"));
          flat.appendChild(line);
        });
        list.parentNode.replaceChild(flat, list);
      } else if (!list) {
        var items = linesOf(el);
        el.textContent = "";
        var made = document.createElement(kind);
        styleList(made, 0);
        items.forEach(function (line) {
          var item = document.createElement("li");
          item.appendChild(line);
          ensureLine(item);
          made.appendChild(item);
        });
        el.appendChild(made);
      }
    });
    var back = caret && rangeFromCaret(caret, editing);
    if (editing) {
      if (!back) {
        back = document.createRange();
        back.selectNodeContents(editing);
        back.collapse(false);
      }
      useRange(back);
    }
    placeHandles();
    report();
    if (!editing) commit();
  }

  /** The list item the caret is in, inside the element being edited. */
  function caretItem() {
    var range = editRange();
    if (!range) return null;
    var node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentNode;
    var item = node && node.closest ? node.closest("li") : null;
    return item && item !== editing && editing.contains(item) ? item : null;
  }

  /** Enter in a list: the rest of the item goes into a new one after it. */
  function newItem(item) {
    var range = editRange();
    if (!item.textContent.trim() && !item.querySelector("img, svg")) {
      var outer = item.parentElement.parentElement;
      if (outer && /^li$/i.test(outer.tagName) && editing.contains(outer)) {
        outdent(item);
      } else {
        // An empty last item ends the list, and the editing.
        var list = item.parentElement;
        if (list.children.length > 1) list.removeChild(item);
        finishEditing();
      }
      return;
    }
    changeText(editing, function () {
      if (!range.collapsed) range.deleteContents();
      var rest = document.createRange();
      rest.setStart(range.startContainer, range.startOffset);
      rest.setEnd(item, item.childNodes.length);
      var next = cloneShallow(item);
      next.appendChild(rest.extractContents());
      item.parentNode.insertBefore(next, item.nextSibling);
      ensureLine(item);
      ensureLine(next);
      var caret = document.createRange();
      caret.setStart(next, 0);
      caret.collapse(true);
      useRange(caret);
    });
  }

  /** Tab in a list: the item goes into a list inside the item before it. */
  function indent(item) {
    var before = item.previousElementSibling;
    if (!before || !/^li$/i.test(before.tagName)) return;
    var range = editRange();
    var caret = range ? caretOf(range) : null;
    var list = item.parentElement;
    var inner = before.lastElementChild && before.lastElementChild.tagName === list.tagName ? before.lastElementChild : null;
    if (!inner) {
      inner = cloneShallow(list);
      before.appendChild(inner);
      if (inner.style.listStyleType) inner.style.listStyleType = LIST_TYPES[inner.tagName.toLowerCase()][depthOf(inner, editing) % 3];
    }
    inner.appendChild(item);
    var back = caret && rangeFromCaret(caret, editing);
    if (back) useRange(back);
    placeHandles();
  }

  /** Shift+Tab in a nested list: the item moves out after the item it is in, taking the items after it along. */
  function outdent(item) {
    var list = item.parentElement;
    var outer = list.parentElement;
    if (!outer || !/^li$/i.test(outer.tagName) || !editing.contains(outer)) return;
    var range = editRange();
    var caret = range ? caretOf(range) : null;
    if (item.nextElementSibling) {
      var rest = cloneShallow(list);
      while (item.nextSibling) rest.appendChild(item.nextSibling);
      item.appendChild(rest);
    }
    outer.parentNode.insertBefore(item, outer.nextSibling);
    if (!list.children.length) list.parentNode.removeChild(list);
    var back = caret && rangeFromCaret(caret, editing);
    if (!back) {
      back = document.createRange();
      back.setStart(item, 0);
      back.collapse(true);
    }
    useRange(back);
    placeHandles();
  }

  /** Enter, or Shift+Enter in a list: a line break at the caret. */
  function insertLineBreak() {
    if (document.execCommand && document.execCommand("insertLineBreak")) return;
    insertAtCaret(document.createElement("br"));
  }

  /** Puts `content` (a node or fragment) in place of the selected text and the caret after it. */
  function insertAtCaret(content) {
    var range = editRange();
    if (!range) return;
    changeText(editing, function () {
      range.deleteContents();
      var last = content.nodeType === 11 ? content.lastChild : content;
      if (!last) return;
      range.insertNode(content);
      var after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      useRange(after);
    });
  }

  /** Plain text as text with line breaks. */
  function textFragment(text) {
    var fragment = document.createDocumentFragment();
    String(text || "").replace(/\r\n?/g, "\n").split("\n").forEach(function (line, i) {
      if (i) fragment.appendChild(document.createElement("br"));
      if (line) fragment.appendChild(document.createTextNode(line));
    });
    return fragment;
  }

  /**
   * Pasted HTML as text with its formatting: bold, italic, underline, strikethrough,
   * superscript / subscript, color, links and line breaks. Fonts, sizes, classes and
   * everything else are dropped, so it takes on the look of the text it goes into.
   */
  function pastedFragment(html) {
    var template = document.createElement("template");
    template.innerHTML = html;
    var out = document.createDocumentFragment();
    var add = function (into, node) {
      into.appendChild(node);
    };
    var walk = function (from, into) {
      Array.prototype.forEach.call(from.childNodes, function (node) {
        if (node.nodeType === 3) {
          var text = node.data.replace(/[\t\n\r ]+/g, " ");
          if (text.trim() || (into.lastChild && into.lastChild.nodeName !== "BR")) add(into, document.createTextNode(text));
          return;
        }
        if (node.nodeType !== 1 || PASTE_SKIP.test(node.tagName)) return;
        var tag = node.tagName.toLowerCase();
        if (tag === "br") {
          add(into, document.createElement("br"));
          return;
        }
        if (!INLINE.test(tag)) {
          // Blocks become lines; the extra breaks this leaves are tidied below.
          into.appendChild(document.createElement("br"));
          walk(node, into);
          into.appendChild(document.createElement("br"));
          return;
        }
        var style = node.style;
        var weight = style.fontWeight === "bold" ? 700 : parseInt(style.fontWeight, 10);
        var lines = (style.textDecorationLine || "") + " " + (style.textDecoration || "");
        var bold = /^(b|strong)$/.test(tag) ? !(weight < 600 || style.fontWeight === "normal") : weight >= 600;
        var span = document.createElement("span");
        if (bold) span.style.fontWeight = "700";
        if (/^(i|em)$/.test(tag) || style.fontStyle === "italic") span.style.fontStyle = "italic";
        var decoration = [];
        if (tag === "u" || /underline/.test(lines)) decoration.push("underline");
        if (/^(s|strike|del)$/.test(tag) || /line-through/.test(lines)) decoration.push("line-through");
        if (decoration.length) span.style.setProperty("text-decoration-line", decoration.join(" "));
        var color = toHex(style.color || node.getAttribute("color"));
        if (color) span.style.color = color;
        var inner = document.createDocumentFragment();
        walk(node, inner);
        if (!hasContent(inner) && !inner.textContent) return;
        var result = inner;
        if (span.getAttribute("style")) {
          span.appendChild(result);
          result = span;
        }
        if (tag === "sup" || tag === "sub") {
          var script = document.createElement(tag);
          script.appendChild(result);
          result = script;
        }
        var href = tag === "a" ? safeHref(node.getAttribute("href")) : null;
        if (href) result = wrapIn(linkTo(document.createElement("a"), href), result);
        add(into, result);
      });
    };
    walk(template.content, out);
    // One break between lines: none before the first or after the last, none doubled.
    var walker = document.createTreeWalker(out, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var breaks = [];
    var text = false;
    var lastBreak = null;
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeName === "BR") {
        if (!text || lastBreak) breaks.push(node);
        else lastBreak = node;
      } else if (node.nodeType === 3 && node.data.trim()) {
        text = true;
        lastBreak = null;
      }
    }
    if (lastBreak) breaks.push(lastBreak);
    breaks.forEach(function (br) {
      br.parentNode.removeChild(br);
    });
    while (out.lastChild && out.lastChild.nodeType === 3 && !out.lastChild.data.trim()) out.removeChild(out.lastChild);
    return out;
  }

  function wrapIn(wrapper, content) {
    wrapper.appendChild(content);
    return wrapper;
  }

  /** A link's href as given, if it is one a slide may hold: a web or mail address, or another slide. */
  function safeHref(href) {
    href = String(href || "").trim();
    return /^(https?:|mailto:|#)/i.test(href) && href !== "#" ? href : null;
  }

  /** Points `a` at `href`; web links open in a new window, so the presentation stays open. */
  function linkTo(a, href) {
    a.setAttribute("href", href);
    if (/^https?:/i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    } else {
      a.removeAttribute("target");
      a.removeAttribute("rel");
    }
    return a;
  }

  /**
   * Links the selection to `href`, or with null, removes its link. While typing, the selected
   * text (or the link at the caret, or else all of the text); otherwise the element: its text,
   * or an element without text (an image, a shape) in an <a> that leaves its layout alone.
   */
  function setLink(given) {
    var href = given === null ? null : safeHref(given);
    var el = editing || selected;
    if (!el || !slide.contains(el) || (given !== null && !href)) return;
    if (editing) {
      var range = editRange();
      var node = textNodeOf(el);
      var at = node.closest("a");
      changeText(el, function () {
        if (range && !range.collapsed) {
          formatRange(range, { link: href });
        } else if (at && el.contains(at)) {
          if (href) linkTo(at, href);
          else unwrap(at);
        } else if (href) {
          var all = document.createRange();
          all.selectNodeContents(el);
          formatRange(all, { link: href });
          var caret = rangeAt(el, { start: el.textContent.length, end: el.textContent.length });
          useRange(caret);
        }
      });
      report();
      return;
    }
    var link = linkOf(el, el);
    if (link && href) {
      linkTo(link, href);
    } else if (link) {
      if (link === el) select(link.firstElementChild || null);
      unwrap(link);
    } else if (href && describe(el).text && el.textContent.trim()) {
      var a = linkTo(document.createElement("a"), href);
      while (el.firstChild) a.appendChild(el.firstChild);
      el.appendChild(a);
    } else if (href) {
      var around = linkTo(document.createElement("a"), href);
      around.style.display = "contents";
      wrap(el, around);
    } else {
      return;
    }
    placeHandles();
    report();
    commit();
  }

  /**
   * How the box handles text that does not fit: "shrink" its text (data-autofit, see
   * runtime.js), "grow" (its height becomes a min-height, so it grows with its text), or null.
   */
  function setAutofit(el, mode) {
    mode = mode === "shrink" || mode === "grow" ? mode : null;
    var was = el.getAttribute("data-autofit");
    if (was === mode) return;
    if (autofit) autofit.unfit(el);
    if (was === "grow") {
      // Back to a fixed box, as tall as it grew.
      var grown = getComputedStyle(el).height;
      el.style.removeProperty("min-height");
      if (/px$/.test(grown)) el.style.height = grown;
    }
    if (mode) el.setAttribute("data-autofit", mode);
    else el.removeAttribute("data-autofit");
    if (mode === "grow") {
      var height = getComputedStyle(el).height;
      if (/px$/.test(height)) el.style.minHeight = height;
      el.style.height = "auto";
      el.style.removeProperty("max-height");
    }
    refit(el);
  }

  /** Picks a tool; `tell` lets the app know, when the editor switched by itself. */
  function useTool(next, tell) {
    tool = TOOLS.indexOf(next) >= 0 ? next : "select";
    painting = tool === "paint" && selected ? paintableStyle(selected) : null;
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
      (styleFor("fontFamily") ? " font-family: " + String(styleFor("fontFamily")).replace(/[;{}<>]/g, "") + ";" : "") +
      (styleFor("bold") ? " font-weight: 700;" : "") +
      (styleFor("italic") ? " font-style: italic;" : "") +
      (styleFor("underline") || styleFor("strike")
        ? " text-decoration-line:" + (styleFor("underline") ? " underline" : "") + (styleFor("strike") ? " line-through" : "") + ";"
        : "") +
      (styleFor("letterSpacing") ? " letter-spacing: " + Number(styleFor("letterSpacing")) + "px;" : "") +
      (styleFor("lineHeight") > 0 ? " line-height: " + Number(styleFor("lineHeight")) + ";" : "") +
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
    var el = addElement(
      "shape",
      "position: absolute; left: " + x + "px; top: " + y + "px; width: " + w + "px; height: " + h + "px; margin: 0;" +
        " box-sizing: border-box; padding: 16px; border-radius: " + RADIUS[kind] + ";" + textCss(),
    );
    if (CUTOUTS[kind]) cutOut(el, CUTOUTS[kind]);
    return el;
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
    if (tool === "paint") {
      paintOnto(pickable(event.target, event.clientX, event.clientY));
      return;
    }
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
    create = { tool: tool, x: event.clientX, y: event.clientY, at: at, el: null, moved: false, line: isLine(tool) };
    if (tool === "draw" || create.line) {
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
    if (create.line) {
      drawLine(create, event.shiftKey ? snapLine(create.at, at) : at);
      return;
    }
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
      if (done.line) {
        if (!done.moved) drawLine(done, { x: done.at.x + SHAPE_SIZE.w, y: done.at.y });
        useTool("select", true);
        select(done.el);
      }
      finishDrawing(done.drawing);
      placeHandles();
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
    var points = drawing.strokes ? drawing.strokes[0].concat(drawing.strokes[1] || []) : drawing.points;
    var xs = points.map(function (p) {
      return p[0];
    });
    var ys = points.map(function (p) {
      return p[1];
    });
    var pad = Math.ceil((parseFloat(drawing.path.getAttribute("stroke-width")) || 0) / 2);
    var left = Math.min.apply(null, xs) - pad;
    var top = Math.min.apply(null, ys) - pad;
    var w = Math.max.apply(null, xs) - left + pad;
    var h = Math.max.apply(null, ys) - top + pad;
    place(drawing.svg, left, top, w, h);
    drawing.svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    drawing.path.setAttribute("d", drawing.strokes ? strokesData(drawing.strokes, left, top) : pathData(drawing.points, left, top));
    commit();
  }

  function cancelCreating() {
    if (!create) return;
    if (create.el && create.el.parentElement) create.el.parentElement.removeChild(create.el);
    create = null;
  }

  /**
   * Restyles the selection with the toolbar's `changes` and saves it (or, while its text is
   * being edited, once that is done). Text styles go to all of its text: what its own inline
   * elements set for them gives way.
   */
  function applyStyle(changes) {
    var el = selected;
    if (!el || !slide.contains(el)) return;
    var has = function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    };
    if (autofit) autofit.unfit(el);
    var text = {};
    TEXT_KEYS.forEach(function (key) {
      if (has(key) && key !== "link" && key !== "script") text[key] = changes[key];
    });
    if (Object.keys(text).length && vectorsOf(el).length === 0) {
      Array.prototype.slice.call(el.querySelectorAll("*")).reverse().forEach(function (inner) {
        if (INLINE.test(inner.tagName) && inner.namespaceURI !== SVG_NS) stripFormatting(inner, text);
      });
    }
    if (has("color")) el.style.color = changes.color || "";
    if (has("fontSize")) el.style.fontSize = changes.fontSize > 0 ? Math.round(changes.fontSize) + "px" : "";
    if (has("fontFamily")) el.style.fontFamily = changes.fontFamily || "";
    if (has("bold")) el.style.fontWeight = changes.bold ? "700" : "400";
    if (has("italic")) el.style.fontStyle = changes.italic ? "italic" : "normal";
    if (has("underline") || has("strike")) {
      removeLine(el, "underline");
      removeLine(el, "line-through");
      var lines = [];
      if (has("underline") ? changes.underline : decorated(el, "underline")) lines.push("underline");
      if (has("strike") ? changes.strike : decorated(el, "line-through")) lines.push("line-through");
      if (lines.length) el.style.setProperty("text-decoration-line", lines.join(" "));
      else if (decorated(el, "underline") || decorated(el, "line-through")) el.style.setProperty("text-decoration-line", "none");
    }
    if (has("script")) {
      Array.prototype.slice.call(el.querySelectorAll("sup, sub")).forEach(unwrap);
      if (changes.script === "sup" || changes.script === "sub") {
        var script = document.createElement(changes.script);
        while (el.firstChild) script.appendChild(el.firstChild);
        el.appendChild(script);
      }
    }
    if (has("letterSpacing")) el.style.letterSpacing = changes.letterSpacing ? changes.letterSpacing + "px" : "";
    if (has("lineHeight")) el.style.lineHeight = changes.lineHeight > 0 ? String(Math.round(changes.lineHeight * 100) / 100) : "";
    if (has("autofit")) setAutofit(el, changes.autofit);
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
      // An arrow's head and the box around a line go with its width.
      var line = has("strokeWidth") ? lineOf(el) : null;
      if (line) writeLine(el, slidePoints(el, line), line.arrow);
    } else {
      if (has("fill")) el.style.backgroundColor = changes.fill || "transparent";
      if ((has("stroke") || has("strokeWidth")) && !isCutOut(el)) {
        var now = describe(el);
        var color = has("stroke") ? changes.stroke : now.stroke;
        var width = has("strokeWidth") ? changes.strokeWidth : now.strokeWidth;
        // Picking a border color shows a border; picking a width gives it a color.
        if (has("stroke") && color && !width) width = BORDER_WIDTH;
        if (has("strokeWidth") && width && !color) color = BORDER_COLOR;
        el.style.border = borderCss(color, width);
      }
    }
    applyLook(el, changes);
    if (!el.getAttribute("style")) el.removeAttribute("style");
    if (editing) tidy(el);
    refit(el);
    placeHandles();
    report();
    if (!editing) commit();
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
      return !/^(script|style|template)$/i.test(s.tagName) && !s.classList.contains("notes") && !s.classList.contains("narration") && !s.classList.contains("slop-review");
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
    var group = allSelected();
    if (!group.length) return;
    finishEditing();
    select(null);
    group.forEach(removeElement);
    commit();
  }

  function removeElement(el) {
    // Keep its slot so the rest of the layout does not reflow; a resized element already has one.
    var placeholder = placeholderOf(el);
    if (placeholder) {
      placeholder.removeAttribute(PLACEHOLDER);
      placeholder.setAttribute(DELETED, "");
    } else if (el.parentElement && !/^(absolute|fixed)$/.test(getComputedStyle(el).position) && getComputedStyle(el).display !== "none") {
      el.parentElement.insertBefore(slotFor(el, DELETED), el);
    }
    if (el.parentElement) el.parentElement.removeChild(el);
  }

  // Whatever is open in the app closes on a press outside it, which a press here is.
  window.addEventListener(
    "pointerdown",
    function () {
      window.parent.postMessage({ type: "slop:edit-press" }, "*");
    },
    true,
  );

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
    if (addsToSelection(event)) {
      event.preventDefault();
      lastDown = { el: null, at: 0 };
      if (el) toggleSelected(el);
      else startMarquee(event, null, true);
      return;
    }
    // On a Mac, Ctrl-click is a right click, which leaves the selection it lands on alone.
    if (event.ctrlKey && isSelected(el)) return;
    var now = Date.now();
    var double = el && el === lastDown.el && now - lastDown.at < DOUBLE_CLICK_MS;
    lastDown = { el: el, at: double ? 0 : now };
    if (!isSelected(el) && (!el || isBackdrop(el)) && startMarquee(event, el, false)) return;
    if (!isSelected(el)) select(el);
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

  /** A CSS selector for `el` that also finds it in the saved slide. */
  function selectorOf(el) {
    var parts = [];
    for (var node = el; node !== slide; node = node.parentElement) {
      var index = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ":nth-child(" + index + ")");
    }
    return ["#" + slide.id].concat(parts).join(" > ");
  }

  // A right-click selects what is under it and the app shows its menu. While typing, the
  // webview's own menu stays, for its spelling suggestions.
  document.addEventListener("contextmenu", function (event) {
    if (editing && editing.contains(event.target)) return;
    event.preventDefault();
    if (tool !== "select") return;
    // On macOS, Control-click starts out as a primary press.
    endDrag();
    finishEditing();
    if (nudgeTimer) commit();
    var el = pickable(event.target, event.clientX, event.clientY);
    // A member of a multi-selection, or what is inside the selection (it may be a parent, picked
    // with Escape), leaves it selected.
    if (!isSelected(el) && (!selected || !el || !selected.contains(el))) select(el);
    window.parent.postMessage(
      {
        type: "slop:edit-menu",
        slide: slide.id,
        x: event.clientX,
        y: event.clientY,
        element: selected && {
          path: selectorOf(selected),
          markup: cleanCopy(selected).outerHTML,
          name: nameOf(selected),
          added: !!selected.closest("[" + ADDED + "], [" + DROPPED + "]"),
        },
      },
      "*",
    );
  });

  document.addEventListener("pointermove", function (event) {
    pointer = { x: event.clientX, y: event.clientY };
    if (create) {
      createTo(event);
      return;
    }
    if (marquee) {
      marqueeTo(event);
      return;
    }
    if (!drag) {
      var onHandle = ui.contains(event.target) || pointUi.contains(event.target);
      hover(editing || onHandle || tool !== "select" ? null : pickable(event.target, event.clientX, event.clientY));
      return;
    }
    if (drag.mode === "point") {
      pointTo(event);
      return;
    }
    if (drag.mode !== "move") {
      drag.moved = true;
      transformTo(event);
      showReadout(event);
      return;
    }
    var dx = event.clientX - drag.x;
    var dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    lastDown = { el: null, at: 0 };
    hover(null);
    moveDrag(event, dx, dy);
  });

  function endDrag() {
    if (create) finishCreating();
    if (marquee) finishMarquee();
    if (!drag) return;
    var moved = drag.moved;
    var el = drag.el;
    // A click on one of several selected elements leaves just that one selected.
    var click = !moved && drag.mode === "move" && extras.length > 0;
    var point = drag.mode === "point";
    drag = null;
    clearDragMarks();
    // The handles to add points are away during a drag.
    if (point) placeHandles();
    if (moved) {
      refit(el);
      commit();
    }
    if (click) select(el);
  }
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.documentElement.addEventListener("pointerleave", function () {
    pointer = null;
    hover(null);
  });
  window.addEventListener("resize", placeHandles);
  window.addEventListener("load", scheduleOverflow);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleOverflow);
  scheduleOverflow();
  document.addEventListener("input", function () {
    if (editing) refit(editing);
    placeHandles();
    if (editing) scheduleReport();
  });
  document.addEventListener("selectionchange", function () {
    if (editing && editRange()) scheduleReport();
  });
  // Clicking the app's toolbar keeps the text being edited, and its selection, for the toolbar
  // to restyle; a click elsewhere in the app ends editing ({ type: "slop:edit-finish" }).
  window.addEventListener("blur", function () {
    if (editing) editRange();
  });
  window.addEventListener("focus", function () {
    var range = editRange();
    if (range) useRange(range);
  });
  // Links on the slide do not go anywhere while editing it.
  document.addEventListener(
    "click",
    function (event) {
      var link = event.target && event.target.closest ? event.target.closest("a") : null;
      if (link && slide.contains(link)) event.preventDefault();
    },
    true,
  );
  document.addEventListener("dblclick", function (event) {
    if (tool !== "select") return;
    var el = pickable(event.target, event.clientX, event.clientY);
    if (el && !editing) startEditing(el, event.clientX, event.clientY);
  });

  // Pasted text keeps its formatting (cleaned, see pastedFragment), or with ⌘⇧V comes as plain text.
  document.addEventListener("paste", function (event) {
    if (!editing) return;
    event.preventDefault();
    var data = event.clipboardData;
    var html = data && !plainPaste ? data.getData("text/html") : "";
    var text = data ? data.getData("text/plain") : "";
    plainPaste = false;
    var content = html ? pastedFragment(html) : textFragment(text);
    if (!content.childNodes.length && text) content = textFragment(text);
    insertAtCaret(content);
  });
  document.addEventListener("drop", function (event) {
    if (editing) event.preventDefault();
  });

  /**
   * Adds dropped images (`assets/…` files) on top of the slide, centered on (x, y) and fit to
   * the slide, then selects the last one and saves. Each sits at the slide's top left with an
   * inline `translate` to where it was dropped, so it moves like any hand-moved element.
   */
  function insertImages(images, x, y) {
    finishEditing();
    if (nudgeTimer) commit();
    var rect = slide.getBoundingClientRect();
    var k = zoom();
    var maxW = (slide.offsetWidth || 1920) / 3;
    var maxH = (slide.offsetHeight || 1080) / 2;
    var last = null;
    var placed = 0;
    (Array.isArray(images) ? images : []).forEach(function (image) {
      if (!image || typeof image.src !== "string" || !/^assets\//.test(image.src)) return;
      var w = image.w > 0 ? image.w : DROP_WIDTH;
      var h = image.h > 0 ? image.h : 0;
      var fit = Math.min(1, maxW / w, h ? maxH / h : 1);
      w = Math.round(w * fit);
      h = Math.round(h * fit);
      var img = document.createElement("img");
      img.setAttribute("src", image.src);
      img.setAttribute("alt", "");
      img.setAttribute(DROPPED, "");
      img.style.position = "absolute";
      img.style.left = "0px";
      img.style.top = "0px";
      img.style.width = w + "px";
      slide.appendChild(img);
      var shift = DROP_CASCADE * placed++;
      moveTo(img, (x - rect.left) / k - w / 2 + shift, (y - rect.top) / k - h / 2 + shift);
      mark(img, MOVED, true);
      last = img;
    });
    if (!last) return;
    select(last);
    commit();
  }

  /**
   * Posts the selection for the app to put on the clipboard (and with `cut`, removes it). The
   * header says where it came from: the slide, its path, whether it floats freely (absolutely
   * positioned) and its box and text styles, for pasting it elsewhere.
   */
  function copySelected(cut) {
    if (!selected || !slide.contains(selected)) return;
    finishEditing();
    if (nudgeTimer) commit();
    var group = inDocumentOrder(allSelected());
    if (!group.length) return;
    var headers = group.map(clipHeader);
    var header = headers.length > 1 ? Object.assign({}, headers[0], { group: headers }) : headers[0];
    // `>` only appears inside JSON strings, where `\u003e` stands for it, so `-->` cannot end the comment early.
    var markup = group.map(function (el) {
      return cleanCopy(el).outerHTML;
    }).join("");
    var html = CLIP_MARKER + JSON.stringify(header).replace(/>/g, "\\u003e") + "-->" + markup;
    var text = group.map(function (el) {
      return (typeof el.innerText === "string" ? el.innerText : el.textContent).trim();
    }).join("\n");
    window.parent.postMessage({ type: "slop:edit-copied", slide: slide.id, html: html, text: text }, "*");
    if (cut) removeSelected();
  }

  /** What a copy of `el` needs to know of where it came from (see copySelected). */
  function clipHeader(el) {
    var computed = getComputedStyle(el);
    var center = centerOf(el);
    var size = sizeOf(el);
    var rect = slide.getBoundingClientRect();
    var k = zoom();
    var look = {};
    LOOK.forEach(function (prop) {
      if (computed[prop]) look[prop] = computed[prop];
    });
    return {
      slide: slide.id,
      path: pathOf(el),
      free: /^(absolute|fixed)$/.test(computed.position),
      box: {
        x: Math.round((center.x - rect.left) / k - size.w / 2),
        y: Math.round((center.y - rect.top) / k - size.h / 2),
        w: Math.round(size.w),
        h: Math.round(size.h),
      },
      look: look,
    };
  }

  /** The header and element of markup copied by copySelected; null for anything else. */
  function parseClip(html) {
    if (typeof html !== "string" || html.indexOf(CLIP_MARKER) !== 0) return null;
    var end = html.indexOf("-->");
    if (end < 0) return null;
    var header;
    try {
      header = JSON.parse(html.slice(CLIP_MARKER.length, end));
    } catch (e) {
      return null;
    }
    var template = document.createElement("template");
    template.innerHTML = html.slice(end + 3).trim();
    var el = template.content.firstElementChild;
    if (!el || !header || typeof header !== "object") return null;
    return { header: header, el: el, els: Array.prototype.slice.call(template.content.children), markup: el.outerHTML };
  }

  /**
   * Where a paste goes, in this window's pixels: the pointer when it is over the slide, or
   * else the middle of the view.
   */
  function pastePoint() {
    var rect = slide.getBoundingClientRect();
    var over = pointer && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom;
    return over ? { x: pointer.x, y: pointer.y } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  /** Pastes an element copied by copySelected on top of the slide (see the top of this file). */
  function pasteElement(html) {
    var clip = parseClip(html);
    if (!clip) return;
    finishEditing();
    if (nudgeTimer) commit();
    if (Array.isArray(clip.header.group) && clip.header.group.length === clip.els.length && clip.els.length > 1) {
      pasteGroup(clip);
      return;
    }
    var el = document.importNode(clip.el, true);
    // Ids stay unique; a copy takes one only when the original is gone.
    withDescendants(el).forEach(function (node) {
      if (node.id && document.getElementById(node.id)) node.removeAttribute("id");
    });
    var box = clip.header.box && typeof clip.header.box === "object" ? clip.header.box : {};
    var w = box.w > 0 ? box.w : 0;
    var h = box.h > 0 ? box.h : 0;
    var at = pastePoint();
    var center = slidePoint(at.x, at.y);
    slide.appendChild(el);
    placeFree(el, clip.header, { x: center.x - w / 2, y: center.y - h / 2 });
    cascade(el);
    select(el);
    commit();
  }

  /** Moves a pasted copy down and right of any element of its kind already at the same spot. */
  function cascade(el) {
    var at = offsetOf(el);
    var x = at.x;
    var y = at.y;
    for (var i = 0; i < 50 && spotTaken(el, x, y, [el]); i++) {
      x += DROP_CASCADE;
      y += DROP_CASCADE;
    }
    moveTo(el, x, y);
  }

  /** Whether an element of `el`'s kind, other than those in `skip`, sits where `el` would at offset (x, y). */
  function spotTaken(el, x, y, skip) {
    return Array.prototype.some.call(el.parentElement.children, function (other) {
      if (skip.indexOf(other) >= 0 || other.tagName !== el.tagName) return false;
      var o = offsetOf(other);
      return other.style.left === el.style.left && other.style.top === el.style.top && o.x === x && o.y === y;
    });
  }

  /** Puts a copied element on the slide with its top left at `at`, sized and styled as it looked. */
  function placeFree(el, header, at) {
    var box = header.box && typeof header.box === "object" ? header.box : {};
    var num = function (n) {
      return isFinite(n) ? Math.round(n) : 0;
    };
    el.style.position = "absolute";
    el.style.margin = "0px";
    el.style.left = num(at.x) + "px";
    el.style.top = num(at.y) + "px";
    el.style.right = el.style.bottom = "auto";
    el.style.boxSizing = "border-box";
    if (box.w > 0) el.style.width = num(box.w) + "px";
    // Text may wrap differently here, so only boxes without text keep their height.
    if (box.h > 0 && !el.textContent.trim()) el.style.height = num(box.h) + "px";
    var look = header.look && typeof header.look === "object" ? header.look : {};
    LOOK.forEach(function (prop) {
      if (typeof look[prop] === "string" && !el.style[prop]) el.style[prop] = look[prop];
    });
    // Its place is all in left and top.
    moveTo(el, 0, 0);
  }

  /** Adds a text box with pasted `text` where pastes go, styled like new text boxes. */
  function pasteText(text, style) {
    text = String(text || "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    if (!text.trim()) return;
    finishEditing();
    if (nudgeTimer) commit();
    var toolStyleBefore = toolStyle;
    toolStyle = style && typeof style === "object" ? style : {};
    var el = newText(0, 0);
    toolStyle = toolStyleBefore;
    el.textContent = "";
    text.split("\n").forEach(function (line, i) {
      if (i) el.appendChild(document.createElement("br"));
      el.appendChild(document.createTextNode(line));
    });
    var maxW = Math.round((slide.offsetWidth || 1920) * PASTE_TEXT_WIDTH);
    if (sizeOf(el).w > maxW) el.style.width = maxW + "px";
    var at = pastePoint();
    var center = slidePoint(at.x, at.y);
    var size = sizeOf(el);
    place(el, Math.round(center.x - size.w / 2), Math.round(center.y - size.h / 2), null, null);
    select(el);
    commit();
  }

  // ----- Selection and arrangement: several selected elements, the marquee, ⌘A and Tab, duplicates,
  // smart guides, align and distribute, and numeric geometry (see the top of this file). -----

  // The selected elements other than `selected`, which stays the primary one.
  var extras = [];
  // The marquee being dragged out: where it started and what stays selected.
  var marquee = null;
  // While on, `commit` waits, so changing several elements saves (and undoes) as one.
  var batching = false;
  var reportedGeometry = "null";
  var geometryFrame = 0;
  // How close, in screen pixels, a dragged edge or center comes before it snaps.
  var SNAP_PX = 6;
  // Never part of the slide's visible content.
  var NOT_CONTENT = /^(script|style|template|link|meta|title)$/i;
  var ASIDES = ".notes, .narration, .slop-review, " + SLOTS;
  var ALIGN_TO = ["left", "center", "right", "top", "middle", "bottom"];

  style.textContent +=
    "[data-slop-multi], [data-slop-guides] { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }" +
    "[data-slop-multi] > *, [data-slop-guides] > * { position: absolute; box-sizing: border-box; }" +
    "[data-slop-multi] > * { outline: 2px solid #3b82f6; }" +
    "[data-slop-guides] > * { background: #ec4899; }" +
    "[data-slop-marquee], [data-slop-readout] { position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box; }" +
    "[data-slop-marquee] { border: 1px solid #3b82f6; background: rgba(59, 130, 246, 0.12); }" +
    "[data-slop-readout] { padding: 2px 6px; border-radius: 4px; background: rgba(17, 17, 17, 0.85); color: #fff;" +
    " font: 12px/1.4 system-ui, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }";

  function overlay(attr) {
    var el = document.createElement("div");
    el.setAttribute(attr, "");
    document.body.appendChild(el);
    return el;
  }
  var frames = overlay("data-slop-multi");
  var guides = overlay("data-slop-guides");
  var marqueeBox = overlay("data-slop-marquee");
  var readout = overlay("data-slop-readout");
  marqueeBox.style.display = readout.style.display = "none";

  /** The selected elements, the primary one first. */
  function allSelected() {
    return (selected ? [selected] : []).concat(extras).filter(function (el) {
      return slide.contains(el);
    });
  }

  function isSelected(el) {
    return !!el && (el === selected || extras.indexOf(el) >= 0);
  }

  function clearExtras() {
    extras.forEach(function (el) {
      mark(el, "data-slop-selected", false);
    });
    extras = [];
  }

  /** Selects just `list`, the first one primary; an element goes along with one that holds it. */
  function selectMany(list) {
    var unique = list.filter(function (el, i) {
      return el && list.indexOf(el) === i && !list.some(function (other) {
        return other && other !== el && other.contains(el);
      });
    });
    if (unique.length === allSelected().length && unique.every(isSelected)) return;
    select(unique[0] || null);
    extras = unique.slice(1);
    extras.forEach(function (el) {
      mark(el, "data-slop-selected", true);
    });
    placeHandles();
    report();
  }

  /** Shift- or ⌘-click: takes `el` out of the selection, or adds it instead of what holds it or it holds. */
  function toggleSelected(el) {
    var group = allSelected();
    selectMany(isSelected(el)
      ? group.filter(function (other) {
          return other !== el;
        })
      : group.filter(function (other) {
          return !other.contains(el) && !el.contains(other);
        }).concat(el));
  }

  /** Whether this press changes the selection instead of replacing it. On a Mac, Ctrl-click is a right click. */
  function addsToSelection(event) {
    return event.shiftKey || event.metaKey || (event.ctrlKey && !/Mac/.test(navigator.platform));
  }

  /**
   * Runs `change` once per selected element, with each in turn as `selected` for code that works
   * on one, and saves them together.
   */
  function forEachSelected(change) {
    if (!extras.length) {
      change(selected);
      return;
    }
    var primary = selected;
    var group = allSelected();
    batching = true;
    group.forEach(function (el) {
      selected = el;
      change(el);
    });
    selected = primary;
    batching = false;
    placeHandles();
    report();
    commit();
  }

  function applyToSelection(changes) {
    forEachSelected(function () {
      applyStyle(changes);
    });
  }

  function inDocumentOrder(list) {
    return list.slice().sort(function (a, b) {
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  /** Whether `el` is only a see-through wrapper around other elements: no text or box of its own. */
  function isBackdrop(el) {
    if (el.hasAttribute(ADDED) || paintsBox(getComputedStyle(el))) return false;
    var ownText = Array.prototype.some.call(el.childNodes, function (node) {
      return node.nodeType === 3 && node.data.trim();
    });
    return !ownText && Array.prototype.some.call(el.children, function (child) {
      return selectable(child) === child;
    });
  }

  /** Whether `el` is a thing on the slide of its own, to select with others. */
  function arrangeable(el) {
    return selectable(el) === el && paints(el) && !isBackdrop(el);
  }

  /** Goes through what shows inside `root`; a true from `visit` skips what is in that element. */
  function walkContent(root, visit) {
    Array.prototype.forEach.call(root.children, function (el) {
      if (NOT_CONTENT.test(el.tagName) || el.matches(ASIDES) || getComputedStyle(el).display === "none") return;
      if (!visit(el)) walkContent(el, visit);
    });
  }

  function slideWidth() {
    return slide.offsetWidth || 1920;
  }

  function slideHeight() {
    return slide.offsetHeight || 1080;
  }

  /** The bounds of `el` on screen, in slide pixels from the slide's top left. */
  function boxOf(el) {
    var rect = el.getBoundingClientRect();
    var origin = slide.getBoundingClientRect();
    var k = zoom();
    return {
      left: (rect.left - origin.left) / k,
      top: (rect.top - origin.top) / k,
      right: (rect.right - origin.left) / k,
      bottom: (rect.bottom - origin.top) / k,
    };
  }

  function boundsOf(list) {
    var boxes = list.map(boxOf);
    var side = function (pick, name) {
      return pick.apply(null, boxes.map(function (box) {
        return box[name];
      }));
    };
    return { left: side(Math.min, "left"), top: side(Math.min, "top"), right: side(Math.max, "right"), bottom: side(Math.max, "bottom") };
  }

  /** The box of `el` before it is turned, in slide pixels from the slide's top left. */
  function frameOf(el) {
    var center = centerOf(el);
    var origin = slide.getBoundingClientRect();
    var size = sizeOf(el);
    var scale = scaleOf(el);
    var k = zoom();
    var w = size.w * scale.x;
    var h = size.h * scale.y;
    var left = (center.x - origin.left) / k - w / 2;
    var top = (center.y - origin.top) / k - h / 2;
    return { left: left, top: top, right: left + w, bottom: top + h };
  }

  /** A frame around each of several selected elements, turned with it. */
  function placeFrames() {
    frames.textContent = "";
    if (!extras.length || editing) return;
    var k = zoom();
    allSelected().forEach(function (el) {
      var center = centerOf(el);
      var size = sizeOf(el);
      var scale = scaleOf(el);
      var w = size.w * scale.x * k;
      var h = size.h * scale.y * k;
      var frame = document.createElement("div");
      frame.style.cssText = "left:" + (center.x - w / 2) + "px;top:" + (center.y - h / 2) + "px;width:" + w + "px;height:" + h + "px;transform:rotate(" + angleOf(el) + "deg)";
      frames.appendChild(frame);
    });
  }

  /** Starts a marquee at the pointer if it is on the slide; `picked` is what a click there selects. */
  function startMarquee(event, picked, add) {
    var rect = slide.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return false;
    if (!rect.width || !rect.height) return false;
    event.preventDefault();
    hover(null);
    marquee = { x: event.clientX, y: event.clientY, picked: picked, add: add, base: add ? allSelected() : [], moved: false };
    try {
      document.documentElement.setPointerCapture(event.pointerId);
    } catch (e) {
      // Synthetic events have no active pointer to capture.
    }
    return true;
  }

  /** The outermost elements fully inside `area`, in slide pixels. */
  function elementsIn(area) {
    var found = [];
    walkContent(slide, function (el) {
      if (!arrangeable(el)) return false;
      var box = boxOf(el);
      var inside = box.right > box.left && box.bottom > box.top && box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom;
      if (inside) found.push(el);
      return inside;
    });
    return found;
  }

  function marqueeTo(event) {
    var dx = event.clientX - marquee.x;
    var dy = event.clientY - marquee.y;
    if (!marquee.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    marquee.moved = true;
    lastDown = { el: null, at: 0 };
    var left = Math.min(marquee.x, event.clientX);
    var top = Math.min(marquee.y, event.clientY);
    var w = Math.abs(dx);
    var h = Math.abs(dy);
    marqueeBox.style.cssText = "left:" + left + "px;top:" + top + "px;width:" + w + "px;height:" + h + "px";
    var origin = slide.getBoundingClientRect();
    var k = zoom();
    var x = (left - origin.left) / k;
    var y = (top - origin.top) / k;
    selectMany(marquee.base.concat(elementsIn({ left: x, top: y, right: x + w / k, bottom: y + h / k })));
  }

  function finishMarquee() {
    var done = marquee;
    marquee = null;
    marqueeBox.style.display = "none";
    if (!done.moved && !done.add) select(done.picked);
  }

  /** ⌘A: everything on the slide, wrappers giving way to what they hold. */
  function selectAll() {
    if (tool !== "select") return;
    finishEditing();
    if (nudgeTimer) commit();
    var found = [];
    walkContent(slide, function (el) {
      if (!arrangeable(el)) return false;
      found.push(el);
      return true;
    });
    selectMany(found);
  }

  /** Tab: the next element in the slide's order, inner ones too, or with -1 the one before. */
  function cycleSelection(step) {
    if (nudgeTimer) commit();
    var list = [];
    walkContent(slide, function (el) {
      if (arrangeable(el)) list.push(el);
      return false;
    });
    if (!list.length) return;
    var at = list.indexOf(selected);
    select(list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length]);
  }

  /**
   * Puts a copy of each selected element on top of the slide, `offset` slide pixels away and
   * looking as it does, and selects the copies. The caller saves.
   */
  function duplicateSelected(offset) {
    finishEditing();
    if (nudgeTimer) commit();
    selectMany(inDocumentOrder(allSelected()).map(function (el) {
      var header = clipHeader(el);
      var copy = cleanCopy(el);
      withDescendants(copy).forEach(function (node) {
        node.removeAttribute("id");
      });
      slide.appendChild(copy);
      placeFree(copy, header, { x: header.box.x + offset, y: header.box.y + offset });
      return copy;
    }));
  }

  /** ⌘D: duplicates the selection, offset so the copy shows. */
  function duplicate() {
    if (!selected) return;
    duplicateSelected(DROP_CASCADE);
    commit();
  }

  /** Pastes several copied elements, keeping how they lie to each other, centered where pastes go. */
  function pasteGroup(clip) {
    var boxes = clip.header.group.map(function (item) {
      return item.box && typeof item.box === "object" ? item.box : {};
    });
    var num = function (n) {
      return isFinite(n) ? n : 0;
    };
    var left = Math.min.apply(null, boxes.map(function (b) { return num(b.x); }));
    var top = Math.min.apply(null, boxes.map(function (b) { return num(b.y); }));
    var right = Math.max.apply(null, boxes.map(function (b) { return num(b.x) + num(b.w); }));
    var bottom = Math.max.apply(null, boxes.map(function (b) { return num(b.y) + num(b.h); }));
    var at = pastePoint();
    var center = slidePoint(at.x, at.y);
    var els = clip.els.map(function (source, i) {
      var el = document.importNode(source, true);
      withDescendants(el).forEach(function (node) {
        if (node.id && document.getElementById(node.id)) node.removeAttribute("id");
      });
      slide.appendChild(el);
      placeFree(el, clip.header.group[i], {
        x: center.x - (right - left) / 2 + num(boxes[i].x) - left,
        y: center.y - (bottom - top) / 2 + num(boxes[i].y) - top,
      });
      return el;
    });
    // The group shifts as one when a copy already sits at one of its spots.
    var shift = 0;
    var taken = function () {
      return els.some(function (el) {
        return spotTaken(el, shift, shift, els);
      });
    };
    for (var i = 0; i < 50 && taken(); i++) shift += DROP_CASCADE;
    els.forEach(function (el) {
      moveTo(el, shift, shift);
    });
    selectMany(els);
    commit();
  }

  function moveBy(el, dx, dy) {
    var at = offsetOf(el);
    moveTo(el, at.x + dx, at.y + dy);
  }

  /** Lines up several elements with their bounds, or one with the slide. */
  function alignSelection(to) {
    if (ALIGN_TO.indexOf(to) < 0) return;
    finishEditing();
    if (nudgeTimer) commit();
    var group = allSelected();
    if (!group.length) return;
    var area = group.length > 1 ? boundsOf(group) : { left: 0, top: 0, right: slideWidth(), bottom: slideHeight() };
    group.forEach(function (el) {
      var box = boxOf(el);
      var dx = to === "left" ? area.left - box.left : to === "right" ? area.right - box.right : to === "center" ? (area.left + area.right - box.left - box.right) / 2 : 0;
      var dy = to === "top" ? area.top - box.top : to === "bottom" ? area.bottom - box.bottom : to === "middle" ? (area.top + area.bottom - box.top - box.bottom) / 2 : 0;
      moveBy(el, dx, dy);
    });
    commit();
  }

  /** Evens out the gaps between three or more elements along an axis, the outer two staying put. */
  function distributeSelection(axis) {
    finishEditing();
    if (nudgeTimer) commit();
    var group = allSelected();
    if (group.length < 3) return;
    var across = axis === "h";
    var start = across ? "left" : "top";
    var end = across ? "right" : "bottom";
    var items = group.map(function (el) {
      return { el: el, box: boxOf(el) };
    }).sort(function (a, b) {
      return a.box[start] + a.box[end] - b.box[start] - b.box[end];
    });
    var used = items.reduce(function (sum, item) {
      return sum + item.box[end] - item.box[start];
    }, 0);
    var at = items[0].box[start];
    var gap = (items[items.length - 1].box[end] - at - used) / (items.length - 1);
    items.forEach(function (item) {
      var by = at - item.box[start];
      moveBy(item.el, across ? by : 0, across ? 0 : by);
      at += item.box[end] - item.box[start] + gap;
    });
    commit();
  }

  /** What the app shows for the selection's place and size; null with nothing selected. */
  function geometry() {
    var group = allSelected();
    if (!group.length) return null;
    var box = group.length > 1 ? boundsOf(group) : frameOf(group[0]);
    return {
      count: group.length,
      x: Math.round(box.left),
      y: Math.round(box.top),
      w: Math.round(box.right - box.left),
      h: Math.round(box.bottom - box.top),
      rotation: group.length > 1 ? null : angleOf(group[0]),
    };
  }

  function reportGeometry() {
    geometryFrame = 0;
    var now = geometry();
    var key = JSON.stringify(now);
    if (key === reportedGeometry) return;
    reportedGeometry = key;
    window.parent.postMessage({ type: "slop:edit-geometry", slide: slide.id, geometry: now }, "*");
  }

  function scheduleGeometry() {
    if (!geometryFrame) geometryFrame = window.requestAnimationFrame(reportGeometry);
  }

  /** Gives `el` the size (w, h; null keeps one) in slide pixels, its top left staying put. */
  function setSize(el, w, h) {
    var size = sizeOf(el);
    var scale = scaleOf(el);
    if (!size.w || !size.h) return;
    var sx = w === null ? scale.x : w / size.w;
    var sy = h === null ? scale.y : h / size.h;
    var shift = { x: (size.w * (sx - scale.x)) / 2, y: (size.h * (sy - scale.y)) / 2 };
    var resize = sizeMode === "resize";
    var offset = offsetOf(el);
    drag = {
      el: el,
      size: size,
      scale: scale,
      offset: offset,
      zoom: zoom(),
      vectors: resize && el.getAttribute(ADDED) === "drawing" ? vectorShapes(el) : null,
    };
    if (resize) {
      resizeTo(sx, sy, shift);
    } else {
      scaleTo(el, sx, sy);
      moveTo(el, offset.x + shift.x, offset.y + shift.y);
    }
    drag = null;
  }

  /** Applies typed numbers (see slop:edit-geometry at the top of this file). */
  function setGeometry(data) {
    finishEditing();
    if (nudgeTimer) commit();
    var given = function (n) {
      return typeof n === "number" && isFinite(n);
    };
    if (!geometry()) return;
    if (!extras.length) {
      if (given(data.w) || given(data.h)) setSize(selected, given(data.w) && data.w > 0 ? data.w : null, given(data.h) && data.h > 0 ? data.h : null);
      if (given(data.rotation)) rotateTo(selected, data.rotation);
    }
    var now = geometry();
    var dx = given(data.x) ? data.x - now.x : 0;
    var dy = given(data.y) ? data.y - now.y : 0;
    if (dx || dy) {
      allSelected().forEach(function (el) {
        moveBy(el, dx, dy);
      });
    }
    refit(selected);
    commit();
  }

  /** The lines to snap to on each axis: the slide's and other elements' edges and centers. */
  function snapTargets(moving) {
    var lines = { x: [], y: [] };
    var add = function (left, top, right, bottom) {
      [left, (left + right) / 2, right].forEach(function (at) {
        lines.x.push({ at: at, from: top, to: bottom });
      });
      [top, (top + bottom) / 2, bottom].forEach(function (at) {
        lines.y.push({ at: at, from: left, to: right });
      });
    };
    add(0, 0, slideWidth(), slideHeight());
    walkContent(slide, function (el) {
      var own = moving.some(function (other) {
        return other.contains(el);
      });
      if (own) return true;
      if (!arrangeable(el)) return false;
      var box = boxOf(el);
      if (box.right > box.left && box.bottom > box.top) add(box.left, box.top, box.right, box.bottom);
      return false;
    });
    return lines;
  }

  /** The nudge that brings the nearest of `edges` onto a line within `tolerance`, and the lines it hits. */
  function snapAxis(edges, lines, tolerance) {
    var by = null;
    edges.forEach(function (edge) {
      lines.forEach(function (line) {
        var d = line.at - edge;
        if (Math.abs(d) <= tolerance && (by === null || Math.abs(d) < Math.abs(by))) by = d;
      });
    });
    if (by === null) return { by: 0, hits: [] };
    return {
      by: by,
      hits: lines.filter(function (line) {
        return edges.some(function (edge) {
          return Math.abs(line.at - (edge + by)) < 0.5;
        });
      }),
    };
  }

  function drawGuides(xs, ys, box) {
    guides.textContent = "";
    var origin = slide.getBoundingClientRect();
    var k = zoom();
    var line = function (left, top, w, h) {
      var el = document.createElement("div");
      el.style.cssText = "left:" + left + "px;top:" + top + "px;width:" + w + "px;height:" + h + "px";
      guides.appendChild(el);
    };
    xs.forEach(function (hit) {
      var from = Math.min(hit.from, box.top);
      line(origin.left + hit.at * k, origin.top + from * k, 1, (Math.max(hit.to, box.bottom) - from) * k);
    });
    ys.forEach(function (hit) {
      var from = Math.min(hit.from, box.left);
      line(origin.left + from * k, origin.top + hit.at * k, (Math.max(hit.to, box.right) - from) * k, 1);
    });
  }

  function clearDragMarks() {
    guides.textContent = "";
    readout.style.display = "none";
  }

  /** The (dx, dy) in slide pixels a move ends up with once its bounds snapped, with guide lines. */
  function snapMove(dx, dy, event) {
    var box = drag.box;
    if (event.metaKey || event.ctrlKey || box.right <= box.left || box.bottom <= box.top) {
      guides.textContent = "";
      return { x: dx, y: dy };
    }
    var tolerance = SNAP_PX / drag.zoom;
    var sx = snapAxis([box.left + dx, (box.left + box.right) / 2 + dx, box.right + dx], drag.targets.x, tolerance);
    var sy = snapAxis([box.top + dy, (box.top + box.bottom) / 2 + dy, box.bottom + dy], drag.targets.y, tolerance);
    var x = dx + sx.by;
    var y = dy + sy.by;
    drawGuides(sx.hits, sy.hits, { left: box.left + x, top: box.top + y, right: box.right + x, bottom: box.bottom + y });
    return { x: x, y: y };
  }

  /** The screen distance a handle drag goes once the dragged edges snapped, with guide lines. */
  function snapResize(event) {
    var dx = event.clientX - drag.start.x;
    var dy = event.clientY - drag.start.y;
    if (!drag.box) {
      drag.box = frameOf(drag.el);
      drag.targets = snapTargets([drag.el]);
    }
    var box = drag.box;
    if (event.metaKey || event.ctrlKey || event.shiftKey || drag.angle % 360 || box.right <= box.left || box.bottom <= box.top) {
      guides.textContent = "";
      return { x: dx, y: dy };
    }
    var d = drag.dir;
    var z = drag.zoom;
    var tolerance = SNAP_PX / z;
    var edgeX = (d.x > 0 ? box.right : box.left) + dx / z;
    var edgeY = (d.y > 0 ? box.bottom : box.top) + dy / z;
    var none = { by: 0, hits: [] };
    var sx = d.x ? snapAxis([edgeX], drag.targets.x, tolerance) : none;
    var sy = d.y ? snapAxis([edgeY], drag.targets.y, tolerance) : none;
    drawGuides(sx.hits, sy.hits, {
      left: d.x < 0 ? edgeX + sx.by : box.left,
      top: d.y < 0 ? edgeY + sy.by : box.top,
      right: d.x > 0 ? edgeX + sx.by : box.right,
      bottom: d.y > 0 ? edgeY + sy.by : box.bottom,
    });
    return { x: dx + sx.by * z, y: dy + sy.by * z };
  }

  /** The first step of a move: the group to move, a copy of it with Alt, and what to snap to. */
  function startMove(event) {
    if (event.altKey) {
      duplicateSelected(0);
      drag.el = selected;
    }
    var group = allSelected();
    drag.group = group.map(function (el) {
      return { el: el, from: offsetOf(el) };
    });
    drag.box = boundsOf(group);
    drag.targets = snapTargets(group);
  }

  function moveDrag(event, dx, dy) {
    if (!drag.group) startMove(event);
    var by = snapMove(dx / drag.zoom, dy / drag.zoom, event);
    drag.group.forEach(function (item) {
      moveTo(item.el, item.from.x + by.x, item.from.y + by.y);
    });
    showReadout(event);
  }

  /** The position and size (or turn) next to the pointer while dragging. */
  function showReadout(event) {
    var now = geometry();
    if (!now || drag.mode === "tilt") return;
    readout.textContent =
      drag.mode === "rotate" ? now.rotation + "°"
      : drag.mode === "point" ? "X " + drag.at.x + "  Y " + drag.at.y
      : "X " + now.x + "  Y " + now.y + "  W " + now.w + "  H " + now.h;
    readout.style.cssText = "left:" + (event.clientX + 14) + "px;top:" + (event.clientY + 18) + "px";
  }

  /** Handles the app's messages for this section; true when `data` was one. */
  function arrangeMessage(data) {
    if (data.type === "slop:edit-duplicate") duplicate();
    else if (data.type === "slop:edit-select-all") selectAll();
    else if (data.type === "slop:edit-align") alignSelection(String(data.to));
    else if (data.type === "slop:edit-distribute") distributeSelection(String(data.axis));
    else if (data.type === "slop:edit-geometry") setGeometry(data);
    else return false;
    return true;
  }

  // Capture phase, so keys the editor handles never reach the player (which forwards keys
  // to the app for slide navigation).
  window.addEventListener(
    "keydown",
    function (event) {
      var mod = event.metaKey || event.ctrlKey;
      var letter = String(event.key).toLowerCase();
      if (editing) {
        var item = event.key === "Enter" || event.key === "Tab" ? caretItem() : null;
        if (mod && !event.altKey && !event.shiftKey && TOGGLES[letter]) {
          event.preventDefault();
          toggleStyle(TOGGLES[letter]);
        } else if (mod && event.shiftKey && letter === "v") {
          // The app reads the clipboard's text and answers with slop:edit-insert-text.
          event.preventDefault();
          editRange();
          window.parent.postMessage({ type: "slop:edit-paste-request", slide: slide.id, plain: true }, "*");
        } else if (event.key === "Escape" || (event.key === "Enter" && mod && !event.shiftKey)) {
          event.preventDefault();
          finishEditing();
        } else if (event.key === "Enter" && item && !event.shiftKey) {
          event.preventDefault();
          newItem(item);
        } else if (event.key === "Enter") {
          event.preventDefault();
          insertLineBreak();
        } else if (event.key === "Tab" && !mod) {
          // Focus stays in the text; in a list, Tab indents the item.
          event.preventDefault();
          if (item) changeText(editing, function () {
            if (event.shiftKey) outdent(item);
            else indent(item);
          });
          report();
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
      if (mod && !event.altKey && !event.shiftKey) {
        if (TOGGLES[letter] && selected && describe(selected).text) {
          if (nudgeTimer) commit();
          toggleStyle(TOGGLES[letter]);
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if ((letter === "c" || letter === "x") && selected) {
          copySelected(letter === "x");
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (letter === "a" || letter === "d") {
          if (letter === "a") selectAll();
          else duplicate();
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        // The app pastes: the player forwards the key. Nothing here takes a native paste.
        if (letter === "v") event.preventDefault();
      }
      if (event.key === "Tab" && !mod && tool === "select") {
        cycleSelection(event.shiftKey ? -1 : 1);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!selected) return;
      if (event.metaKey || event.ctrlKey) {
        // Undo, paste and other shortcuts go to the app, after any pending nudge is saved.
        if (nudgeTimer) commit();
        return;
      }
      var step = event.shiftKey ? 10 : 1;
      var nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      if (nudge) {
        allSelected().forEach(function (el) {
          moveBy(el, nudge[0], nudge[1]);
        });
        clearTimeout(nudgeTimer);
        nudgeTimer = setTimeout(commit, NUDGE_SAVE_MS);
      } else if (event.key === "Escape") {
        select(extras.length || selected.parentElement === slide ? null : selected.parentElement);
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
    if (arrangeMessage(data)) return;
    if (data.type === "slop:edit-select") {
      finishEditing();
      select(atPath(data.path));
      if (Array.isArray(data.also)) selectMany([selected].concat(data.also.map(atPath)));
      // Clearing the selection for a screenshot hides the wires too, until the next interaction.
      if (data.quiet) mark(wires, "data-quiet", true);
    } else if (data.type === "slop:edit-size-mode") {
      if (data.mode !== "resize" && data.mode !== "stretch") return;
      sizeMode = data.mode;
      ui.querySelectorAll('[data-handle="scale"]').forEach(function (handle) {
        handle.title = sizeMode === "resize"
          ? "Resize (Shift keeps the aspect ratio, Alt resizes from the center)"
          : "Stretch (Shift keeps the aspect ratio, Alt scales from the center, double-click resets)";
      });
    } else if (data.type === "slop:edit-tool") {
      toolStyle = data.style && typeof data.style === "object" ? data.style : {};
      if (data.tool !== tool) {
        cancelCreating();
        finishEditing();
        useTool(String(data.tool));
      }
    } else if (data.type === "slop:edit-style" && data.style && typeof data.style === "object") {
      if (editing) styleText(data.style);
      else applyToSelection(data.style);
    } else if (data.type === "slop:edit-list") {
      toggleList(String(data.list));
    } else if (data.type === "slop:edit-link" && (data.href === null || typeof data.href === "string")) {
      setLink(data.href);
    } else if (data.type === "slop:edit-finish") {
      finishEditing();
    } else if (data.type === "slop:edit-insert-text" && typeof data.text === "string") {
      if (editing) insertAtCaret(textFragment(data.text));
    } else if (data.type === "slop:edit-order") {
      finishEditing();
      forEachSelected(function () {
        restack(String(data.to));
      });
    } else if (data.type === "slop:edit-delete") {
      finishEditing();
      if (selected) removeSelected();
    } else if (data.type === "slop:edit-insert-images" && isFinite(data.x) && isFinite(data.y)) {
      insertImages(data.images, data.x, data.y);
    } else if (data.type === "slop:edit-copy") {
      copySelected(!!data.cut);
    } else if (data.type === "slop:edit-paste-images") {
      var at = pastePoint();
      insertImages(data.images, at.x, at.y);
    } else if (data.type === "slop:edit-paste") {
      pasteElement(data.html);
    } else if (data.type === "slop:edit-paste-text" && typeof data.text === "string") {
      pasteText(data.text, data.style);
    } else if (data.type === "slop:edit-replace-image" && typeof data.src === "string") {
      replaceImage(data.src);
    } else if (data.type === "slop:edit-background" && (data.color === null || typeof data.color === "string")) {
      setBackground(data.color);
    }
  });

  // ---- Shapes, styling and media: lines and arrows, cut-out shapes, the look of any element,
  // images, the slide's background, deck colors and the format painter.

  function isLine(name) {
    return name === "line" || name === "arrow";
  }

  /** `from` to `to` as strokes (point lists); an arrow's second stroke is its head, at `to`. */
  function lineStrokes(from, to, arrow, width) {
    var strokes = [[[from.x, from.y], [to.x, to.y]]];
    var head = arrow ? arrowHead(strokes[0], width) : null;
    if (head) strokes.push(head);
    return strokes;
  }

  function distance(a, b) {
    return Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2));
  }

  /**
   * The smooth curve through `points`, as Bézier segments [from, control, control, to]. It goes
   * through each point along the line between its neighbors, and each control point reaches a
   * third of the way along its segment, so points close together do not make it overshoot.
   */
  function curveThrough(points) {
    var last = points.length - 1;
    var along = function (i) {
      var a = points[Math.max(i - 1, 0)];
      var b = points[Math.min(i + 1, last)];
      var length = distance(a, b) || 1;
      return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    };
    return points.slice(1).map(function (to, i) {
      var from = points[i];
      var reach = distance(from, to) / 3;
      var start = along(i);
      var end = along(i + 1);
      return [from, [from[0] + start[0] * reach, from[1] + start[1] * reach], [to[0] - end[0] * reach, to[1] - end[1] * reach], to];
    });
  }

  /** The spot `t` of the way (0 to 1) along a Bézier segment. */
  function curveAt(segment, t) {
    var u = 1 - t;
    var weights = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [0, 1].map(function (axis) {
      return segment.reduce(function (sum, point, i) {
        return sum + point[axis] * weights[i];
      }, 0);
    });
  }

  /** An arrow's head at the end of the line through `points`, facing the way the line ends; null if it has no length. */
  function arrowHead(points, width) {
    var last = points.length - 1;
    var tip = points[last];
    var length = points.slice(1).reduce(function (sum, point, i) {
      return sum + distance(points[i], point);
    }, 0);
    if (!length) return null;
    var size = Math.min(Math.max(ARROW_HEAD_MIN, ARROW_HEAD_PER_WIDTH * width), length);
    var from = last > 1 ? curveThrough(points)[last - 1][2] : points[last - 1];
    var angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
    var barb = function (side) {
      var a = angle + Math.PI + side * ARROW_HEAD_ANGLE;
      return [Math.round(tip[0] + size * Math.cos(a)), Math.round(tip[1] + size * Math.sin(a))];
    };
    return [barb(1), tip, barb(-1)];
  }

  /** The path of a line through `points`, moved by (-dx, -dy): straight with two, else curved. */
  function lineData(points, arrow, width, dx, dy) {
    var local = function (list) {
      return list.map(function (p) {
        return [roundTenth(p[0] - dx), roundTenth(p[1] - dy)];
      });
    };
    var own = local(points);
    var data = pathData(own, 0, 0);
    if (own.length > 2) {
      data = "M" + own[0].join(" ") + curveThrough(own).map(function (segment) {
        return " C" + segment.slice(1).map(function (p) {
          return roundTenth(p[0]) + " " + roundTenth(p[1]);
        }).join(" ");
      }).join("");
    }
    var head = arrow ? arrowHead(points, width) : null;
    return head ? data + " " + pathData(local(head), 0, 0) : data;
  }

  /** What makes `el` a line: its path, points (in the viewBox), head and width. Null for anything else. */
  function lineOf(el) {
    if (!el || !el.getAttribute || !viewBoxOf(el)) return null;
    var vectors = vectorsOf(el);
    if (vectors.length !== 1 || vectors[0].tagName.toLowerCase() !== "path") return null;
    var parts = (vectors[0].getAttribute("d") || "").trim().match(LINE_PATH);
    if (!parts) return null;
    var numbers = parts[1].match(NUMBER).map(parseFloat);
    var step = parts[1].indexOf("C") >= 0 ? 6 : 2;
    var points = [numbers.slice(0, 2)];
    for (var i = step; i < numbers.length; i += step) points.push(numbers.slice(i, i + 2));
    // A tap of the freehand tool leaves a dot.
    if (points.length === 2 && !distance(points[0], points[1])) return null;
    return { path: vectors[0], points: points, arrow: !!parts[2], width: parseFloat(vectors[0].getAttribute("stroke-width")) || 0 };
  }

  /** `line`'s points in slide pixels, wherever turning and scaling `el` took them. */
  function slidePoints(el, line) {
    var box = viewBoxOf(el);
    var frame = frameOf(el);
    var kx = (frame.right - frame.left) / box[2];
    var ky = (frame.bottom - frame.top) / box[3];
    return line.points.map(function (p) {
      var at = turn((p[0] - box[0] - box[2] / 2) * kx, (p[1] - box[1] - box[3] / 2) * ky, angleOf(el));
      return [(frame.left + frame.right) / 2 + at.x, (frame.top + frame.bottom) / 2 + at.y];
    });
  }

  /** Redraws line `el` through `points` (in slide pixels), its box fitted around it, unturned. */
  function writeLine(el, points, arrow) {
    var path = vectorsOf(el)[0];
    var width = parseFloat(path.getAttribute("stroke-width")) || 0;
    var spots = points.slice();
    if (points.length > 2) {
      curveThrough(points).forEach(function (segment) {
        for (var i = 1; i < LINE_SAMPLES; i++) spots.push(curveAt(segment, i / LINE_SAMPLES));
      });
    }
    spots = spots.concat((arrow && arrowHead(points, width)) || []);
    var bound = function (axis, pick, round) {
      return round(pick.apply(null, spots.map(function (p) {
        return p[axis];
      })));
    };
    var pad = Math.ceil(width / 2);
    var left = bound(0, Math.min, Math.floor) - pad;
    var top = bound(1, Math.min, Math.floor) - pad;
    var w = Math.max(1, bound(0, Math.max, Math.ceil) + pad - left);
    var h = Math.max(1, bound(1, Math.max, Math.ceil) + pad - top);
    // Turning and scaling go around the center, so the box's unscaled corner is where it lays out.
    var frame = frameOf(el);
    var size = sizeOf(el);
    var computed = getComputedStyle(el);
    place(
      el,
      (parseFloat(computed.left) || 0) + left - ((frame.left + frame.right) / 2 - size.w / 2),
      (parseFloat(computed.top) || 0) + top - ((frame.top + frame.bottom) / 2 - size.h / 2),
      w,
      h,
    );
    el.setAttribute("viewBox", "0 0 " + w + " " + h);
    path.setAttribute("d", lineData(points, arrow, width, left, top));
    if (angleOf(el)) rotateTo(el, 0);
    var scale = scaleOf(el);
    if (scale.x !== 1 || scale.y !== 1) scaleTo(el, 1, 1);
  }

  /** Puts the handles on the selected line's points; false when no line is selected to show them. */
  function placePoints() {
    pointUi.textContent = "";
    var el = selected;
    var line = el && !editing && !extras.length && slide.contains(el) ? lineOf(el) : null;
    var tilt = line ? tiltOf(el) : null;
    // A tilted line keeps its box: its points are not where the handles would go.
    if (!line || tilt.x || tilt.y) return false;
    var origin = slide.getBoundingClientRect();
    var k = zoom();
    var points = slidePoints(el, line).map(function (p) {
      return [origin.left + p[0] * k, origin.top + p[1] * k];
    });
    var handle = function (kind, index, at, title) {
      var node = document.createElement("div");
      node.setAttribute("data-point", kind);
      node.setAttribute("data-index", String(index));
      node.title = title;
      node.style.left = at[0] + "px";
      node.style.top = at[1] + "px";
      pointUi.appendChild(node);
    };
    var dragging = drag && drag.mode === "point";
    if (!dragging) {
      curveThrough(points).forEach(function (segment, i) {
        handle("add", i + 1, curveAt(segment, 0.5), "Drag to bend the line here");
      });
    }
    points.forEach(function (p, i) {
      var end = i === 0 || i === points.length - 1;
      handle("point", i, p, "Drag to move (Shift snaps to 45°, ⌘ moves freely)" + (end ? "" : ", double-click to remove"));
    });
    return true;
  }

  pointUi.addEventListener("pointerdown", function (event) {
    var kind = event.target.getAttribute && event.target.getAttribute("data-point");
    var line = lineOf(selected);
    if (event.button !== 0 || !kind || !line) return;
    event.preventDefault();
    event.stopPropagation();
    if (nudgeTimer) commit();
    var index = Number(event.target.getAttribute("data-index"));
    var points = slidePoints(selected, line);
    var now = Date.now();
    var double = kind === "point" && index === lastPoint.index && now - lastPoint.at < DOUBLE_CLICK_MS;
    lastPoint = { index: kind === "point" && !double ? index : -1, at: now };
    if (double) {
      if (index > 0 && index < points.length - 1) {
        points.splice(index, 1);
        writeLine(selected, points, line.arrow);
        placeHandles();
        commit();
      }
      return;
    }
    drag = {
      mode: "point",
      el: selected,
      points: points,
      arrow: line.arrow,
      index: index,
      insert: kind === "add",
      x: event.clientX,
      y: event.clientY,
      zoom: zoom(),
      moved: false,
    };
    try {
      pointUi.setPointerCapture(event.pointerId);
    } catch (e) {
      // Synthetic events have no active pointer to capture.
    }
  });

  pointUi.addEventListener("dblclick", function (event) {
    event.stopPropagation();
  });

  /** Moves the dragged point of a line to the pointer; a new point goes in on the first move. */
  function pointTo(event) {
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.x) < DRAG_THRESHOLD && Math.abs(event.clientY - drag.y) < DRAG_THRESHOLD) return;
      drag.moved = true;
      lastPoint = { index: -1, at: 0 };
      hover(null);
      drag.targets = snapTargets([drag.el]);
      if (drag.insert) drag.points.splice(drag.index, 0, null);
    }
    var points = drag.points;
    var other = points[drag.index ? drag.index - 1 : 1];
    var at = slidePoint(event.clientX, event.clientY);
    guides.textContent = "";
    if (event.shiftKey) {
      at = snapLine({ x: other[0], y: other[1] }, at);
    } else if (!event.metaKey && !event.ctrlKey) {
      var tolerance = SNAP_PX / drag.zoom;
      var sx = snapAxis([at.x], drag.targets.x, tolerance);
      var sy = snapAxis([at.y], drag.targets.y, tolerance);
      at = { x: at.x + sx.by, y: at.y + sy.by };
      drawGuides(sx.hits, sy.hits, { left: at.x, top: at.y, right: at.x, bottom: at.y });
    }
    // Both ends on one spot would leave no line.
    if (points.length === 2 && at.x === other[0] && at.y === other[1]) return;
    points[drag.index] = [at.x, at.y];
    drag.at = at;
    writeLine(drag.el, points, drag.arrow);
    placeHandles();
    showReadout(event);
  }

  function strokesData(strokes, dx, dy) {
    return strokes.map(function (points) {
      return pathData(points, dx, dy);
    }).join(" ");
  }

  /** Redraws the line being added so it ends at `to`. */
  function drawLine(line, to) {
    var drawing = line.drawing;
    var width = parseFloat(drawing.path.getAttribute("stroke-width")) || BORDER_WIDTH;
    drawing.strokes = lineStrokes(line.at, to, line.tool === "arrow", width);
    drawing.path.setAttribute("d", strokesData(drawing.strokes, 0, 0));
  }

  /** `to`, turned around `from` to the nearest 45°. */
  function snapLine(from, to) {
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var length = Math.sqrt(dx * dx + dy * dy);
    var angle = (Math.round((Math.atan2(dy, dx) * 4) / Math.PI) * Math.PI) / 4;
    return { x: Math.round(from.x + length * Math.cos(angle)), y: Math.round(from.y + length * Math.sin(angle)) };
  }

  /** Cuts a box to a shape, which only its fill and text survive: not a border, nor a shadow. */
  function cutOut(el, shape) {
    el.style.setProperty("clip-path", shape.clip);
    el.style.border = "none";
    if (shape.padding) el.style.padding = shape.padding;
  }

  function isCutOut(el) {
    return /polygon/.test(getComputedStyle(el).getPropertyValue("clip-path") || "");
  }

  function isImage(el) {
    return !!el && /^img$/i.test(el.tagName);
  }

  /** The look `describe` reports beyond text, fill and border. */
  function lookOf(el, style) {
    var size = sizeOf(el);
    var svg = el.namespaceURI === SVG_NS;
    var clipped = isCutOut(el);
    var corner = style.getPropertyValue("border-radius") || "0";
    var radius = parseFloat(corner) || 0;
    if (/%/.test(corner)) radius = (radius / 100) * Math.min(size.w, size.h);
    var blur = (style.getPropertyValue(svg ? "filter" : "box-shadow") || "").match(SHADOW_LENGTHS);
    var image = isImage(el);
    var flips = el.style.transform || "";
    return {
      opacity: Math.round((parseFloat(style.opacity === "" ? "1" : style.opacity) || 0) * 100) / 100,
      shadow: blur && !clipped ? Math.round(parseFloat(blur[1])) : 0,
      radius: svg || clipped ? null : Math.round(radius),
      clipped: clipped,
      image: image,
      fit: image ? style.getPropertyValue("object-fit") || "fill" : null,
      fitPosition: image ? style.getPropertyValue("object-position") || "50% 50%" : null,
      alt: image ? el.getAttribute("alt") || "" : null,
      flipX: /scaleX\(-1\)/.test(flips),
      flipY: /scaleY\(-1\)/.test(flips),
    };
  }

  /** Sets a style inline; null drops it, or where the deck's styles set one, overrides it with `neutral`. */
  function setOwn(el, prop, value, neutral) {
    el.style.removeProperty(prop);
    var sheet = getComputedStyle(el).getPropertyValue(prop);
    var own = value === null && sheet && sheet !== neutral ? neutral : value;
    if (own !== null) el.style.setProperty(prop, own);
  }

  /** A shadow that blurs `blur` pixels and falls a third of that. */
  function shadowValue(blur) {
    return "0px " + Math.round(blur / 3) + "px " + blur + "px " + SHADOW_COLOR;
  }

  function setShadow(el, blur) {
    if (el.namespaceURI !== SVG_NS) {
      setOwn(el, "box-shadow", blur > 0 ? shadowValue(blur) : null, "none");
      return;
    }
    var others = (el.style.getPropertyValue("filter") || "").replace(SHADOW_FILTER, "");
    var filter = ((blur > 0 ? "drop-shadow(" + shadowValue(blur) + ") " : "") + others).trim();
    if (filter) el.style.setProperty("filter", filter);
    else el.style.removeProperty("filter");
  }

  /** Mirrors `el` with an inline `transform`, after any tilt and `!important` like it. */
  function flipTo(el, x, y) {
    var inline = el.style.transform || "";
    var tilt = inline.match(TILT);
    var rest = inline.replace(TILT, "").replace(/scale[XY]\(-1\)\s*/g, "").trim();
    var value = [tilt ? tilt[0].trim() : "", x ? "scaleX(-1)" : "", y ? "scaleY(-1)" : "", rest].filter(Boolean).join(" ");
    setInline(el, "transform", value || null, "important");
  }

  /** Gives an image's box a fixed size, for when what it shows no longer sets it. */
  function pinSize(el) {
    var computed = getComputedStyle(el);
    ["width", "height"].forEach(function (name) {
      if (/px$/.test(computed[name])) el.style[name] = computed[name];
    });
  }

  /** Applies the keys of `changes` that `lookOf` reports, to `el`. */
  function applyLook(el, changes) {
    var has = function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    };
    if (has("opacity") && isFinite(changes.opacity)) {
      var opacity = Math.round(Math.min(1, Math.max(MIN_OPACITY, changes.opacity)) * 100) / 100;
      setOwn(el, "opacity", opacity < 1 ? String(opacity) : null, "1");
    }
    var cut = isCutOut(el);
    if (has("shadow") && changes.shadow >= 0 && !cut) setShadow(el, Math.round(changes.shadow));
    if (has("radius") && changes.radius >= 0 && !cut && el.namespaceURI !== SVG_NS) {
      setOwn(el, "border-radius", changes.radius > 0 ? Math.round(changes.radius) + "px" : null, "0px");
    }
    if (!isImage(el)) return;
    if (has("fit") && /^(contain|cover|fill)$/.test(changes.fit)) {
      pinSize(el);
      el.style.setProperty("object-fit", changes.fit);
    }
    if (has("fitPosition") && /^\d+% \d+%$/.test(changes.fitPosition)) el.style.setProperty("object-position", changes.fitPosition);
    if (has("alt") && typeof changes.alt === "string") el.setAttribute("alt", changes.alt);
    if (has("flipX") || has("flipY")) {
      var now = lookOf(el, getComputedStyle(el));
      flipTo(el, has("flipX") ? !!changes.flipX : now.flipX, has("flipY") ? !!changes.flipY : now.flipY);
    }
  }

  /** Puts another `assets/…` file in the selected image, whose box stays as it is. */
  function replaceImage(src) {
    var el = selected;
    if (!isImage(el) || !slide.contains(el) || !/^assets\//.test(src)) return;
    pinSize(el);
    if (!el.style.getPropertyValue("object-fit")) el.style.setProperty("object-fit", "cover");
    el.removeAttribute("srcset");
    el.setAttribute("src", src);
    placeHandles();
    report();
    commit();
  }

  function reportBackground() {
    var color = toHex(getComputedStyle(slide).backgroundColor);
    window.parent.postMessage({ type: "slop:edit-background", slide: slide.id, color: color }, "*");
  }

  /** The slide's own background, over any image or gradient the deck gives it; null drops it. */
  function setBackground(color) {
    if (color !== null && !toHex(color)) return;
    if (color) {
      slide.style.setProperty("background-color", color);
      slide.style.setProperty("background-image", "none");
    } else {
      slide.style.removeProperty("background-color");
      slide.style.removeProperty("background-image");
    }
    if (!slide.getAttribute("style")) slide.removeAttribute("style");
    reportBackground();
    commit();
  }

  /** What the format painter takes from `el`, as changes for `applyStyle`: all, and for text. */
  function paintableStyle(el) {
    var now = describe(el);
    var shared = { opacity: now.opacity, shadow: now.shadow };
    if (now.radius !== null) shared.radius = now.radius;
    var paint = { fill: now.fill, stroke: now.stroke, strokeWidth: now.strokeWidth };
    var text = {};
    if (now.text) {
      PAINTED_TEXT.forEach(function (key) {
        text[key] = now[key];
      });
      text.fontFamily = getComputedStyle(el).fontFamily;
    }
    return { vector: now.vector, shared: shared, paint: paint, text: text };
  }

  /** Gives `el` the look the format painter took (fill and line only between likes), and puts it away. */
  function paintOnto(el) {
    var taken = painting;
    useTool("select", true);
    if (!el || !taken) return;
    var target = describe(el);
    var changes = {};
    [taken.shared, target.vector === taken.vector ? taken.paint : {}, target.text ? taken.text : {}].forEach(function (part) {
      Object.keys(part).forEach(function (key) {
        changes[key] = part[key];
      });
    });
    select(el);
    applyStyle(changes);
  }

  /** The colors in the deck's CSS variables, for the color popover's deck swatches. */
  function deckColors() {
    var names = [];
    var scoped = {};
    var visit = function (rules) {
      Array.prototype.forEach.call(rules || [], function (rule) {
        var props = rule.style || [];
        for (var i = 0; i < props.length; i++) {
          var name = props[i];
          if (!/^--/.test(name) || /^--slop-/.test(name) || names.indexOf(name) >= 0) continue;
          names.push(name);
          scoped[name] = props.getPropertyValue(name);
        }
        if (rule.cssRules) visit(rule.cssRules);
      });
    };
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      if (sheet.ownerNode === style) return;
      try {
        visit(sheet.cssRules);
      } catch (e) {
        // A stylesheet from another origin (a web font service) cannot be read.
      }
    });
    var probe = document.createElement("span");
    probe.setAttribute("data-slop-ui", "");
    document.body.appendChild(probe);
    var seen = {};
    var colors = [];
    names.forEach(function (name) {
      var value = String(getComputedStyle(slide).getPropertyValue(name) || scoped[name] || "").trim();
      probe.style.color = "";
      probe.style.color = value;
      var hex = value && probe.style.color ? toHex(getComputedStyle(probe).color) : null;
      if (!hex || seen[hex] || colors.length >= MAX_DECK_COLORS) return;
      seen[hex] = true;
      colors.push({ name: name.slice(2), value: hex });
    });
    document.body.removeChild(probe);
    return colors;
  }

  function reportColors() {
    window.parent.postMessage({ type: "slop:edit-colors", slide: slide.id, colors: deckColors() }, "*");
  }

  /** The font stacks the deck's styles name, by their first family, for the toolbar's font list. */
  function deckFonts() {
    var fonts = [];
    var seen = {};
    var add = function (stack) {
      var name = firstFamily(stack);
      if (!name || seen[name.toLowerCase()] || /^(inherit|initial|unset|revert|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system)$/i.test(name)) return;
      seen[name.toLowerCase()] = true;
      fonts.push({ name: name, stack: String(stack).trim() });
    };
    var visit = function (rules) {
      Array.prototype.forEach.call(rules || [], function (rule) {
        if (rule.style && rule.type !== 5 && rule.style.fontFamily) add(rule.style.fontFamily);
        if (rule.cssRules) visit(rule.cssRules);
      });
    };
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      if (sheet.ownerNode === style) return;
      try {
        visit(sheet.cssRules);
      } catch (e) {
        // A stylesheet from another origin (a web font service) cannot be read.
      }
    });
    if (document.fonts && document.fonts.forEach) {
      document.fonts.forEach(function (face) {
        add('"' + firstFamily(face.family) + '"');
      });
    }
    Array.prototype.forEach.call(slide.querySelectorAll("[style*='font-family']"), function (el) {
      add(el.style.fontFamily);
    });
    return fonts;
  }

  function reportFonts() {
    window.parent.postMessage({ type: "slop:edit-fonts", slide: slide.id, fonts: deckFonts() }, "*");
  }
  reportFonts();
  reportColors();
  reportBackground();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reportFonts);
})();
