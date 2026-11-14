/* SlopSlide pasteboard. The app adds it to the stage's slide preview, in view and edit mode (see
   src-tauri/src/protocol.rs); it is never part of deck.html or an export.

   The preview fills the whole stage area and the slide sits in its middle, at the size it has on
   the stage. The surroundings are an endless pasteboard: drag with the middle button (pressed
   mouse wheel), swipe on a trackpad or hold Space and drag to pan; pinch or Ctrl/⌘+scroll to
   zoom, or press Ctrl/⌘ with + or -; 0, with Ctrl/⌘ or without, returns to the start, and ⇧0
   shows the slide at its real size (100%). The mouse wheel scrolls up and down (with Shift,
   sideways), as far as the zoomed-in slide reaches past the view: with the whole slide in view
   it moves nothing. Without the slide editor, dragging with the
   primary button pans too, except from text, which it selects instead (even text under an
   invisible layer the deck spreads over the slide), and from links and other controls. The slide's frame (outline and shadow) moves with it.
   The view is reported as { type: "slop:view", slide, x, y, k } (pan in px, zoom) and restored
   with { type: "slop:camera", x, y, k } or { type: "slop:camera", home: true }. The app's zoom
   buttons send { type: "slop:camera", zoomBy: factor } and { type: "slop:camera", zoomTo: k },
   which zoom around the middle of the view, keeping what is there in place;
   { type: "slop:camera", actual: true } shows the slide at its real size there, and
   { type: "slop:camera", box: { x, y, w, h } } zooms to fit that box of the slide (in slide pixels)
   in the view and centers it (⇧2 in the editor, for the selection: `frameBox(box)`). The app shows the
   preview scaled to fit the stage and says by how much with { type: "slop:fit", scale }: what is
   drawn over the slide (its frame, the editor's handles and guides) and how far a press may
   wander before it is a drag are kept at their size on screen with it (`ui()`, and `--slop-ui`
   for CSS: this window's pixels per screen pixel). The app also
   sends { type: "slop:canvas", color, accent, ... }: the color of the panel around the slide and
   the palette's colors (src/index.css) as `--slop-*`, for what the preview and the editor draw.
   A press on the preview while it lacks keyboard focus posts { type: "slop:focus" }, and the
   app focuses the preview. Every press posts { type: "slop:press" }: it never reaches the app's
   window, but whatever is open there (a menu, a popover) closes on a press outside it, which this
   is. While something is open there, the app says so with { type: "slop:layer", open }, and
   Escape pressed here goes to the app as { type: "slop:dismiss" }, to close that first, instead
   of to the editor or the player.

   { type: "slop:search", query, matchCase, wholeWord, active } marks what the search in the app's
   toolbar finds on the slide, with the `active`th hit stronger. It reads the text as find.rs does,
   so both count the same hits. The marks are CSS highlights, which leave the slide's markup alone.

   { type: "slop:comment-tool", on } turns picking elements for a comment on and off: the element
   under the pointer is outlined, and a click on it reports { type: "slop:comment-pick", slide, x,
   y, target }, with the point in fractions of the slide; target is null on the slide's background.
   { type: "slop:comment-at", x, y } has the element at that point of this window picked the same
   way, tool or no tool (the editor's menu adds a comment where it was opened); a point off the
   slide counts as the nearest one on it.
   Without the editor, a double-click on the slide posts { type: "slop:edit-ask", slide }: the app
   then opens the slide for editing.
   { type: "slop:comment-locate", comments } gives the comments on the slide, as { id, x, y, target
   }. Each is looked up on the slide, then and whenever an animation ends, and the app gets where
   their pins go as { type: "slop:comment-spots", slide, spots: [{ id, x, y, found }] }.

   The slide editor (assets/editor/) runs after this and builds on window.slopPasteboard, which
   also tells it where the slide is on screen (`origin()`, `scale()`), so it need not measure.

   A wheel turn, a pinch and a drag move the view once a frame, however many events a frame
   brings. While such a gesture lasts, the slide keeps the zoom it is laid out at and is scaled
   the rest of the way, which costs no layout; once it ends, the slide is laid out at the zoom it
   reached, in the same place. Keys, the app's buttons and a restored view move it at once.

   With ?show, the presenter plays the whole deck and this zooms and pans the slide being shown
   instead: the view starts with the slide fit to the window, as the player has it, and returns
   there whenever the show moves to another slide. The slide is never smaller than that, and
   always covers the place it has there: it zooms in from the fit, and pans only as far as it is
   zoomed in, so a hand resting on the trackpad moves nothing in front of the audience. Clicks
   and Space stay the player's, so only the middle button and trackpad swipes pan, and nothing is
   drawn around the slide. 0 fits the slide again, unless it is a digit of the slide number being
   typed (the player says: `window.slopPlayer.typing()`). The view is
   reported as { type: "slop:zoom", x, y, k }: the transform (translate, then scale around the
   top-left corner) that puts what is drawn over the fitted slide onto the zoomed one. */
(function () {
  var slide = document.querySelector(".deck > .slide.active");
  if (!slide || window.parent === window) return;
  var params = new URLSearchParams(location.search);
  var show = params.has("show");

  var MIN_ZOOM = 0.1;
  var MAX_ZOOM = 8;
  var WHEEL_ZOOM = 0.005;
  // How far a press may move, in screen pixels, before it drags.
  var DRAG_THRESHOLD = 3;
  // Wheel events closer together than this belong to one gesture (a swipe and its momentum).
  var WHEEL_GESTURE_MS = 150;
  var editor = params.has("edit");

  var deck = slide.parentElement;
  var root = document.documentElement;
  // What { type: "slop:canvas" } can carry, and the variable each one sets.
  var PALETTE = {
    accent: "--slop-accent",
    border: "--slop-border",
    danger: "--slop-danger",
    guide: "--slop-guide",
    handle: "--slop-handle",
    handleForeground: "--slop-handle-foreground",
    overlay: "--slop-overlay",
    overlayForeground: "--slop-overlay-foreground",
    scrim: "--slop-scrim",
    search: "--slop-search",
    searchActive: "--slop-search-active",
  };
  // The stage's size in slide pixels: the deck's slide size.
  var STAGE_W = deck.offsetWidth || 1920;
  var STAGE_H = deck.offsetHeight || 1080;
  // The page is transparent around the slide, so keep whatever the deck painted behind it.
  if (!show && getComputedStyle(deck).backgroundColor === "rgba(0, 0, 0, 0)") {
    var behind = [document.body, root]
      .map(function (el) {
        return getComputedStyle(el).backgroundColor;
      })
      .filter(function (color) {
        return color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent";
      })[0];
    deck.style.backgroundColor = behind || "#000";
  }
  // Outlines the slide's edge; the editor also dims everything outside it. A show has none.
  var frame = null;
  if (!show) {
    var style = document.createElement("style");
    style.textContent =
      "html, body { background: transparent !important; }" +
      "[data-slop-frame] { position: fixed; z-index: 2147483645; pointer-events: none; box-sizing: border-box;" +
      " box-shadow: 0 20px 50px -24px var(--slop-scrim); outline: calc(1px * var(--slop-ui, 1)) solid var(--slop-border); }";
    document.head.appendChild(style);
    frame = document.createElement("div");
    frame.setAttribute("data-slop-frame", "");
    document.body.appendChild(frame);
  }

  // The view: pan in px away from the slide being centered, and zoom.
  var cam = { x: 0, y: 0, k: 1 };
  // Where the view last put the slide on screen: its top-left corner and its scale. The view may
  // be a frame ahead of it during a gesture.
  var placed = { x: 0, y: 0, k: 1 };
  // The zoom the deck is laid out at, once it is placed; a gesture leaves it as it is.
  var laidOut = 0;
  // A wheel turn, a pinch or a drag is moving the view.
  var gesture = false;
  var cameraFrame = 0;
  var settleTimer = 0;
  // Where and at which scale the frame's box was last written.
  var frameBox = null;
  var reportedView = "0,0,1";
  var spaceDown = false;
  var pan = null;
  var listeners = [];
  // How many of this window's pixels one screen pixel takes (see { type: "slop:fit" }).
  var ui = 1;

  var api = {
    frame: frame,
    view: function () {
      return { x: cam.x, y: cam.y, k: cam.k };
    },
    /** How many screen pixels one pixel of the slide takes up right now. */
    scale: function () {
      return placed.k;
    },
    /** Where the slide's top-left corner is on screen right now, as { x, y }. */
    origin: function () {
      return { x: placed.x, y: placed.y };
    },
    /** How many of this window's pixels one screen pixel takes: what is drawn at a size on screen is this much larger here. */
    ui: function () {
      return ui;
    },
    startPan: startPan,
    /** Zooms to fit `box` ({ x, y, w, h } in slide pixels) in the view, centered. */
    frameBox: zoomToBox,
    /** Moves the slide now if a gesture's move still waits for its frame. */
    flush: function () {
      if (cameraFrame) applyCamera();
    },
    /** Calls `fn` whenever the view moves, or the size the preview shows at changes. */
    onChange: function (fn) {
      listeners.push(fn);
    },
    /** Whether keys and Space+drag belong to something else, like text being edited. */
    busy: function () {
      return false;
    },
  };
  window.slopPasteboard = api;

  /**
   * Where the slide's top-left corner sits when the view is not panned, and its scale: centered
   * at full size, or in a show fit to the window like the player has it.
   */
  function home() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    var s = show ? Math.min(w / STAGE_W, h / STAGE_H) : 1;
    var x = (w - STAGE_W * s) / 2;
    var y = (h - STAGE_H * s) / 2;
    return show ? { x: x, y: y, s: s } : { x: Math.max(0, x), y: Math.max(0, y), s: 1 };
  }

  /**
   * Puts the frame where the slide is. Writing its box repaints its shadows, so a gesture that
   * leaves the scale alone (a pan) moves the box as it is instead.
   */
  function placeFrame(x, y, k) {
    if (!frame) return;
    if (gesture && frameBox && frameBox.k === k) {
      frame.style.transform = "translate(" + (x - frameBox.x) + "px," + (y - frameBox.y) + "px)";
      return;
    }
    frameBox = { x: x, y: y, k: k };
    frame.style.left = x + "px";
    frame.style.top = y + "px";
    frame.style.width = STAGE_W * k + "px";
    frame.style.height = STAGE_H * k + "px";
    frame.style.transform = "";
  }

  /** Puts the slide (and its frame) where the view says. */
  function applyCamera() {
    if (cameraFrame) window.cancelAnimationFrame(cameraFrame);
    cameraFrame = 0;
    var h = home();
    var x = h.x + cam.x;
    var y = h.y + cam.y;
    var k = h.s * cam.k;
    // Magnified with `zoom`, not `scale()`: WebKit lays the slide out at the zoomed size and
    // paints all of it sharp, while under a scale it keeps the slide's own layers (backdrop
    // filters, say) at the size they were first painted and stretches them, blurring their text.
    // Shrunk with `scale()`, though: laid out at a fraction of its size, text no longer measures
    // in proportion (tiny fonts round their glyphs and hit the minimum font size), so lines wrap
    // differently and the slide overflows; shrinking what was painted at full size stays sharp.
    // That is how the slide rests. A new zoom lays out the whole slide again, though, so a gesture
    // keeps the zoom it began with and scales the rest of the way, until it ends (see `settle`).
    // Lengths on a zoomed element are zoomed too, so the pan is given in unzoomed px.
    var z = gesture ? laidOut : Math.max(1, k);
    if (z !== laidOut) {
      laidOut = z;
      deck.style.zoom = String(z);
    }
    deck.style.transform = "translate(" + x / z + "px," + y / z + "px)" + (k === z ? "" : " scale(" + k / z + ")");
    placeFrame(x, y, k);
    placed = { x: x, y: y, k: k };
    listeners.forEach(function (fn) {
      fn();
    });
    // In a show, what is drawn over the fitted slide scales around the window's top-left corner.
    var view = show
      ? { type: "slop:zoom", x: cam.x + h.x * (1 - cam.k), y: cam.y + h.y * (1 - cam.k), k: cam.k }
      : { type: "slop:view", slide: slide.id, x: cam.x, y: cam.y, k: cam.k };
    var key = [view.x, view.y, view.k].join(",");
    if (key === reportedView) return;
    reportedView = key;
    window.parent.postMessage(view, "*");
  }

  /** Takes the size the app shows the preview at: what keeps its size on screen follows. */
  function setUi(value) {
    if (value === ui) return;
    ui = value;
    root.style.setProperty("--slop-ui", String(ui));
    listeners.forEach(function (fn) {
      fn();
    });
  }

  function clampZoom(k) {
    // A show never shows the slide smaller than fit to the window.
    return Math.min(MAX_ZOOM, Math.max(show ? 1 : MIN_ZOOM, k));
  }

  /**
   * The view (x, y, k) as it may be. In a show the slide always covers the place it has when fit
   * to the window: it is panned only as far as it is zoomed in, and not at all at the fit.
   */
  function bounded(x, y, k) {
    k = clampZoom(k);
    if (!show) return { x: x, y: y, k: k };
    var h = home();
    var within = function (pan, size) {
      return Math.min(0, Math.max(size * h.s * (1 - k), pan));
    };
    return { x: within(x, STAGE_W), y: within(y, STAGE_H), k: k };
  }

  /** Has the compositor move the slide and its frame, or no longer. */
  function promote(on) {
    [deck, frame].forEach(function (el) {
      if (!el) return;
      if (on) el.style.setProperty("will-change", "transform");
      else el.style.removeProperty("will-change");
    });
  }

  /**
   * Ends a gesture, if one is on, and puts the slide where the view says: laid out at the zoom
   * it reached, so sharp again, and in the same place.
   */
  function settle() {
    clearTimeout(settleTimer);
    if (gesture) promote(false);
    gesture = false;
    applyCamera();
  }

  /** Moves the view at once, as keys, the app's buttons and a restored view do. */
  function setCamera(x, y, k) {
    cam = bounded(x, y, k);
    settle();
  }

  /**
   * Moves the view as part of a gesture: the slide follows on the next frame, once for all the
   * events that frame brings.
   */
  function moveCamera(x, y, k) {
    cam = bounded(x, y, k);
    if (!gesture) promote(true);
    gesture = true;
    if (!cameraFrame) cameraFrame = window.requestAnimationFrame(applyCamera);
  }

  /** The view zoomed by `factor` with the slide point under the screen point (px, py) kept in place. */
  function zoomedAt(px, py, factor) {
    var h = home();
    var k = clampZoom(cam.k * factor);
    var f = k / cam.k;
    return { x: px - (px - h.x - cam.x) * f - h.x, y: py - (py - h.y - cam.y) * f - h.y, k: k };
  }

  /** Zooms by `factor` around the middle of the view, as the zoom buttons and keys do. */
  function zoomBy(factor) {
    var to = zoomedAt(window.innerWidth / 2, window.innerHeight / 2, factor);
    setCamera(to.x, to.y, to.k);
  }

  // How much one press of a zoom key or button zooms.
  var ZOOM_STEP = 1.25;
  // Room kept around a box zoomed to (see zoomToBox), and between the view's edge and the slide a
  // mouse wheel scrolls to, in screen pixels.
  var VIEW_MARGIN = 48;

  /** Shows the slide at its real size, one of its pixels to one on screen, around the middle of the view. */
  function zoomToActual() {
    if (!show) zoomBy(ui / cam.k);
  }

  /** Zooms to fit `box` ({ x, y, w, h } in slide pixels) in the view with some room, and centers it. */
  function zoomToBox(box) {
    if (show || !box || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) return;
    var h = home();
    var room = 2 * VIEW_MARGIN * ui;
    var w = Math.max(1, box.w);
    var tall = Math.max(1, box.h);
    var k = clampZoom(Math.min((window.innerWidth - room) / w, (window.innerHeight - room) / tall) / h.s);
    var s = h.s * k;
    setCamera(window.innerWidth / 2 - h.x - (box.x + w / 2) * s, window.innerHeight / 2 - h.y - (box.y + tall / 2) * s, k);
  }

  /**
   * Where a mouse wheel may scroll the view to along one axis, from `pan` by `by`: only as far as
   * the slide (`size` at the view's zoom, its edge at `offset` unpanned) reaches past the view
   * (`view`), and a margin more, and not at all when it fits. A view panned further by other means
   * stays where it is.
   */
  function scrolledTo(pan, by, size, offset, view) {
    var margin = VIEW_MARGIN * ui;
    if (size <= view + 1) return pan;
    var low = Math.min(view - margin - size - offset, pan);
    var high = Math.max(margin - offset, pan);
    return Math.min(high, Math.max(low, pan + by));
  }

  function setPanning(on) {
    spaceDown = on;
    root.style.cursor = on ? "grab" : "";
  }
  applyCamera();
  // Registered after the player's, which fits the slide to the window on resize.
  window.addEventListener("resize", applyCamera);

  // Each slide of a show starts fit to the window.
  if (show) {
    new MutationObserver(function () {
      var active = deck.querySelector(":scope > .slide.active");
      if (!active || active === slide) return;
      slide = active;
      pan = null;
      setCamera(0, 0, 1);
    }).observe(deck, { subtree: true, attributes: true, attributeFilter: ["class"] });
  }

  /** Drags the view along with the pointer. */
  function startPan(event) {
    event.preventDefault();
    pan = { x: event.clientX, y: event.clientY, from: { x: cam.x, y: cam.y }, moved: false };
    root.style.cursor = "grabbing";
    if (event.target.setPointerCapture) {
      try {
        event.target.setPointerCapture(event.pointerId);
      } catch (e) {
        // Synthetic events have no active pointer to capture.
      }
    }
  }

  /** The caret position nearest the screen point (x, y), as { node, offset }, if any. */
  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      var position = document.caretPositionFromPoint(x, y);
      return position && { node: position.offsetNode, offset: position.offset };
    }
    if (document.caretRangeFromPoint) {
      var range = document.caretRangeFromPoint(x, y);
      return range && { node: range.startContainer, offset: range.startOffset };
    }
    return null;
  }

  /**
   * Whether the caret at (x, y) sits by a character drawn under that point, not merely inside a
   * text box: padding, gaps between lines and the space past a line's end don't count.
   */
  function onGlyph(caret, x, y) {
    if (!caret || caret.node.nodeType !== 3 || !caret.node.data.trim()) return false;
    var node = caret.node;
    // The caret sits between two characters; the point may be over either of them.
    var range = document.createRange();
    for (var i = Math.max(0, caret.offset - 1); i < Math.min(node.data.length, caret.offset + 1); i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      var rects = range.getClientRects();
      for (var j = 0; j < rects.length; j++) {
        var r = rects[j];
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
    }
    return false;
  }

  /**
   * The text under the screen point (x, y): { caret, covers }, where covers are the elements on
   * top of it, like an invisible layer a deck spreads over the slide to react to hovering. Each
   * one found is taken out of hit testing (pointer-events: none) until restore(covers). Null when
   * no character lies under the point.
   */
  function textAt(x, y) {
    if (!document.caretPositionFromPoint && !document.caretRangeFromPoint) return null;
    var covers = [];
    for (var tries = 0; tries < 20; tries++) {
      var caret = caretAt(x, y);
      if (onGlyph(caret, x, y)) return { caret: caret, covers: covers };
      var el = document.elementFromPoint(x, y);
      // Down to the slide itself: nothing but the slide's background is left.
      if (!el || !slide.contains(el) || el === slide) break;
      covers.push({ el: el, value: el.style.getPropertyValue("pointer-events"), priority: el.style.getPropertyPriority("pointer-events") });
      el.style.setProperty("pointer-events", "none", "important");
    }
    restore(covers);
    return null;
  }

  function restore(covers) {
    covers.forEach(function (cover) {
      if (cover.value) cover.el.style.setProperty("pointer-events", cover.value, cover.priority);
      else cover.el.style.removeProperty("pointer-events");
    });
  }

  // Selecting text that lies under a covering layer, which the browser can't do on its own:
  // { anchor, covers }, with the covers out of the way until the button is released.
  var selecting = null;

  function endSelecting() {
    if (!selecting) return;
    restore(selecting.covers);
    selecting = null;
  }

  // Whatever is open in the app closes on a press outside it, which a press here is.
  window.addEventListener(
    "pointerdown",
    function () {
      window.parent.postMessage({ type: "slop:press" }, "*");
    },
    true,
  );

  // Something is open in the app over the preview (see { type: "slop:layer" }): Escape closes
  // that first. Capture phase, and before the editor adds its keys, so nothing here acts on it.
  var layerOpen = false;
  window.addEventListener(
    "keydown",
    function (event) {
      if (!layerOpen || event.key !== "Escape" || event.isComposing) return;
      window.parent.postMessage({ type: "slop:dismiss" }, "*");
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  // Panning and the editor cancel the press, so it never moves keyboard focus here by itself and
  // keys would stay with whatever had it in the app (the chat composer, say). The app focuses
  // this preview instead, so the arrow keys change slides after a click on the slide.
  if (!show) {
    window.addEventListener(
      "pointerdown",
      function () {
        if (!document.hasFocus()) window.parent.postMessage({ type: "slop:focus" }, "*");
      },
      true,
    );
  }

  // Comments are pinned to the element under them, and find it again after the slide changes.
  var commenting = false;
  var commentList = [];
  // Outlines the element a click would comment on.
  var commentHover = null;
  var LABEL_LENGTH = 80;
  var NOT_COMMENTED = "script, style, template, .notes, .narration, [data-slop-frame]";

  /** Child-index path from the slide to `el`. */
  function commentPath(el) {
    var path = [];
    for (var node = el; node !== slide; node = node.parentElement) {
      path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    return path;
  }

  /** The start of `el`'s text, or what describes a picture; empty for neither. */
  function commentLabel(el) {
    var text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) text = el.getAttribute("alt") || el.getAttribute("aria-label") || el.getAttribute("src") || "";
    return text.slice(0, LABEL_LENGTH);
  }

  /** Whether `el` shows something of its own, unlike a layout box or an invisible cover. */
  function showsSomething(el) {
    if (/^(img|svg|video|canvas|picture|iframe|object|embed)$/i.test(el.tagName)) return true;
    var own = Array.prototype.some.call(el.childNodes, function (node) {
      return node.nodeType === 3 && node.data.trim();
    });
    if (own) return true;
    var style = getComputedStyle(el);
    var clear = style.backgroundColor === "transparent" || /^rgba\(.*,\s*0\)$/.test(style.backgroundColor);
    return !clear || style.backgroundImage !== "none" || parseFloat(style.borderTopWidth) > 0;
  }

  /** The element a comment at the screen point (x, y) would be on; null for the slide itself. */
  function commentableAt(x, y) {
    var stack = document.elementsFromPoint(x, y).filter(function (el) {
      return slide.contains(el) && el !== slide && !el.closest(NOT_COMMENTED);
    });
    return stack.filter(showsSomething)[0] || stack[0] || null;
  }

  /** The element `target` was made on: where it was if it still looks the same, else by its looks. */
  function findTarget(target) {
    var el = slide;
    for (var i = 0; i < target.path.length && el; i++) el = el.children[target.path[i]];
    var same = function (candidate) {
      return candidate.tagName.toLowerCase() === target.tag && commentLabel(candidate) === target.label;
    };
    if (el && el !== slide && same(el)) return el;
    // Without a label, the tag alone says too little to go by.
    if (!target.label) return el && el !== slide && el.tagName.toLowerCase() === target.tag ? el : null;
    return Array.prototype.filter.call(slide.querySelectorAll(target.tag), same)[0] || null;
  }

  function reportCommentSpots() {
    if (!commentList.length) return;
    var box = slide.getBoundingClientRect();
    var spots = commentList.map(function (comment) {
      var target = comment.target;
      var el = target && findTarget(target);
      if (!el) return { id: comment.id, x: comment.x, y: comment.y, found: !target };
      var rect = el.getBoundingClientRect();
      return {
        id: comment.id,
        x: (rect.left + target.at[0] * rect.width - box.left) / box.width,
        y: (rect.top + target.at[1] * rect.height - box.top) / box.height,
        found: true,
      };
    });
    window.parent.postMessage({ type: "slop:comment-spots", slide: slide.id, spots: spots }, "*");
  }

  function setCommenting(on) {
    commenting = !!on;
    root.toggleAttribute("data-slop-commenting", commenting);
    if (!commentHover) {
      commentHover = document.createElement("div");
      commentHover.setAttribute("data-slop-comment-hover", "");
      document.body.appendChild(commentHover);
    }
    commentHover.style.display = "none";
  }

  function hoverComment(x, y) {
    var el = commentableAt(x, y);
    commentHover.style.display = el ? "block" : "none";
    if (!el) return;
    var rect = el.getBoundingClientRect();
    commentHover.style.left = rect.left + "px";
    commentHover.style.top = rect.top + "px";
    commentHover.style.width = rect.width + "px";
    commentHover.style.height = rect.height + "px";
  }

  /** Picks what is at (x, y) for a comment, taking a point off the slide as the nearest one on it. */
  function commentAt(x, y) {
    var box = slide.getBoundingClientRect();
    pickComment(Math.min(box.right, Math.max(box.left, x)), Math.min(box.bottom, Math.max(box.top, y)));
  }

  function pickComment(x, y) {
    var box = slide.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return;
    var el = commentableAt(x, y);
    var rect = el && el.getBoundingClientRect();
    window.parent.postMessage(
      {
        type: "slop:comment-pick",
        slide: slide.id,
        x: (x - box.left) / box.width,
        y: (y - box.top) / box.height,
        target: el && {
          path: commentPath(el),
          tag: el.tagName.toLowerCase(),
          label: commentLabel(el),
          at: [(x - rect.left) / (rect.width || 1), (y - rect.top) / (rect.height || 1)],
        },
      },
      "*",
    );
  }

  if (!show) {
    slide.addEventListener("animationend", reportCommentSpots);
    slide.addEventListener("transitionend", reportCommentSpots);
    // A comment takes the click, so links and controls on the slide stay put.
    document.addEventListener(
      "click",
      function (event) {
        if (!commenting) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    );
    // The slide is only shown: a double-click on it asks the app for its editor.
    if (!editor) {
      document.addEventListener("dblclick", function (event) {
        if (commenting || event.button !== 0) return;
        if (event.target.closest("a, button, input, select, textarea, video, audio")) return;
        window.parent.postMessage({ type: "slop:edit-ask", slide: slide.id }, "*");
      });
    }
  }

  // The middle button (pressing the mouse wheel) always pans, even while typing; Space+drag pans
  // unless typing. Without the editor, the primary button pans too, except from text (to select
  // it, even under a layer the deck put over it) and controls; in a show it clicks through the
  // slides.
  document.addEventListener("pointerdown", function (event) {
    // A press always ends an earlier pan or selection, even one whose release never arrived.
    if (pan && gesture) settle();
    pan = null;
    endSelecting();
    var primary = event.button === 0;
    if (commenting && primary && !spaceDown) {
      event.preventDefault();
      event.stopImmediatePropagation();
      pickComment(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 1 && !(primary && spaceDown && !api.busy())) {
      if (!primary || editor || show) return;
      if (event.target.closest("a, button, input, select, textarea, video, audio, [contenteditable]")) return;
      var text = textAt(event.clientX, event.clientY);
      if (text && !text.covers.length) return;
      if (text) {
        event.preventDefault();
        selecting = { anchor: text.caret, covers: text.covers };
        window.getSelection().collapse(text.caret.node, text.caret.offset);
        event.stopImmediatePropagation();
        return;
      }
      // A click away from the text deselects it, which the browser no longer does once panning
      // takes the press.
      window.getSelection().removeAllRanges();
    }
    startPan(event);
    event.stopImmediatePropagation();
  });
  document.addEventListener("pointermove", function (event) {
    if (commenting && !pan) hoverComment(event.clientX, event.clientY);
    if (selecting) {
      var caret = caretAt(event.clientX, event.clientY);
      if (caret && slide.contains(caret.node)) {
        window.getSelection().setBaseAndExtent(selecting.anchor.node, selecting.anchor.offset, caret.node, caret.offset);
      }
      event.stopImmediatePropagation();
      return;
    }
    if (!pan) return;
    var dx = event.clientX - pan.x;
    var dy = event.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) < DRAG_THRESHOLD * ui && Math.abs(dy) < DRAG_THRESHOLD * ui) return;
    pan.moved = true;
    moveCamera(pan.from.x + dx, pan.from.y + dy, cam.k);
    event.stopImmediatePropagation();
  });
  function endPan(event) {
    endSelecting();
    if (!pan) return;
    pan = null;
    if (gesture) settle();
    root.style.cursor = spaceDown ? "grab" : "";
    event.stopImmediatePropagation();
  }
  document.addEventListener("pointerup", endPan);
  document.addEventListener("pointercancel", endPan);
  // Otherwise a middle click may paste (Linux) or open the autoscroll cursor.
  document.addEventListener("auxclick", function (event) {
    if (event.button === 1) event.preventDefault();
  });

  /**
   * Whether a wheel event comes from a notched mouse wheel rather than a trackpad. Browsers don't
   * say, so this goes by what the event looks like: a mouse wheel scrolls in whole notches (lines,
   * or wheelDelta in steps of 120) and only vertically, while a trackpad sends a stream of
   * pixel deltas, usually with some sideways motion. WebKit (the macOS app) reports a notch as an
   * accelerated fraction of a 40px line, like 4.000244px, with a wheelDelta that is no multiple of
   * 120; trackpad deltas are whole pixels.
   */
  function fromMouseWheel(event) {
    if (event.deltaMode !== 0) return true;
    if (event.deltaX) return false;
    if (event.deltaY % 1 !== 0) return true;
    var ticks = event.wheelDeltaY;
    return typeof ticks === "number" && ticks !== 0 && ticks % 120 === 0;
  }
  var wheelGesture = { at: -Infinity, mouse: false };

  // Pinching (reported as Ctrl+wheel) and Ctrl/⌘+scroll zoom the pasteboard around the pointer.
  // Swiping on a trackpad pans. The mouse wheel scrolls (see scrolledTo), sideways with Shift;
  // in a show it zooms, as nothing there scrolls. A gesture is classified by its first event, so
  // a swipe never turns into a zoom halfway through. It ends when no event has come for as long
  // as tells two gestures apart.
  window.addEventListener(
    "wheel",
    function (event) {
      event.preventDefault();
      var unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      var dx = event.deltaX * unit;
      var dy = event.deltaY * unit;
      var now = event.timeStamp || Date.now();
      if (now - wheelGesture.at > WHEEL_GESTURE_MS) wheelGesture.mouse = fromMouseWheel(event);
      wheelGesture.at = now;
      if (event.ctrlKey || event.metaKey || (show && wheelGesture.mouse && dy)) {
        var to = zoomedAt(event.clientX, event.clientY, Math.exp(-Math.max(-60, Math.min(60, dy)) * WHEEL_ZOOM));
        moveCamera(to.x, to.y, to.k);
      } else if (wheelGesture.mouse) {
        // WebKit reports a notch as a fraction of a line (see fromMouseWheel): a line it is. The
        // distance is meant on screen, where the app may show the preview smaller (see `ui`).
        var notch = (event.deltaMode === 0 && Math.abs(dx || dy) < 16 && (dx || dy) % 1 !== 0 ? 10 : 1) * ui;
        var across = event.shiftKey && !dx ? dy : dx;
        var down = event.shiftKey && !dx ? 0 : dy;
        var h = home();
        var k = h.s * cam.k;
        moveCamera(
          scrolledTo(cam.x, -across * notch, STAGE_W * k, h.x, window.innerWidth),
          scrolledTo(cam.y, -down * notch, STAGE_H * k, h.y, window.innerHeight),
          cam.k,
        );
      } else {
        moveCamera(cam.x - dx, cam.y - dy, cam.k);
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, WHEEL_GESTURE_MS);
    },
    { passive: false },
  );

  // Ctrl/⌘ with + (or =, the same key unshifted), - and 0 zoom in, out and back to the start,
  // also while text is edited: with the modifier they are no text. Capture phase, so neither the
  // player forwards them to the app nor the webview zooms the whole page.
  window.addEventListener(
    "keydown",
    function (event) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      var key = event.key;
      if (key === "=" || key === "+") zoomBy(ZOOM_STEP);
      else if (key === "-" || key === "_") zoomBy(1 / ZOOM_STEP);
      else if (key === "0") setCamera(0, 0, 1);
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  // Capture phase, so the player never forwards these keys to the app. In a show, Space advances,
  // and 0 is a digit of the slide number being typed when the slide is already fitted or the
  // player says a number is being typed.
  window.addEventListener(
    "keydown",
    function (event) {
      if (api.busy() || event.metaKey || event.ctrlKey || event.altKey) return;
      // ⇧0, by its place on the keyboard (where Shift types the 0 itself, it is the 0): the slide at its real size.
      if (!show && event.shiftKey && event.key !== "0" && (event.code === "Digit0" || (!event.code && event.key === ")"))) {
        zoomToActual();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if ((event.key !== " " || show) && event.key !== "0") return;
      var typing = window.slopPlayer && window.slopPlayer.typing();
      if (event.key === "0" && show && (typing || (cam.x === 0 && cam.y === 0 && cam.k === 1))) return;
      if (event.key === "0") setCamera(0, 0, 1);
      else setPanning(true);
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener(
    "keyup",
    function (event) {
      if (event.key !== " " || !spaceDown) return;
      setPanning(false);
      event.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener("blur", function () {
    if (spaceDown) setPanning(false);
  });

  // What find.rs doesn't count as text on a slide.
  var NOT_TEXT = "script, style, textarea, title, template, [data-resize-placeholder], [data-delete-placeholder]";

  /** The characters of `text` as find.rs compares them, each with where it starts and ends. */
  function readText(text, exact) {
    var chars = [];
    var at = 0;
    Array.from(text).forEach(function (c) {
      var end = at + c.length;
      var last = chars[chars.length - 1];
      if (/[ \t\n\f\r]/.test(c)) {
        if (last && last.space) last.end = end;
        else chars.push({ c: " ", raw: " ", space: true, start: at, end: end });
      } else {
        chars.push({ c: fold(c, exact), raw: c, space: false, start: at, end: end });
      }
      at = end;
    });
    return chars;
  }

  function fold(c, exact) {
    var lower = c.toLowerCase();
    return exact || Array.from(lower).length !== 1 ? c : lower;
  }

  function isWord(c) {
    return !!c && /[\p{Alphabetic}\p{N}_]/u.test(c.raw);
  }

  /** Ranges of the text on the slide that `query` matches, in reading order. */
  function searchHits(query, matchCase, wholeWord) {
    var needle = readText(query, matchCase).map(function (c) {
      return c.c;
    });
    var hits = [];
    if (!needle.length) return hits;
    var walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement.closest(NOT_TEXT)) continue;
      var chars = readText(node.data, matchCase);
      for (var i = 0; i + needle.length <= chars.length; i++) {
        var end = i + needle.length;
        var same = needle.every(function (c, k) {
          return chars[i + k].c === c;
        });
        if (!same || (wholeWord && (isWord(chars[i - 1]) || isWord(chars[end])))) continue;
        var range = document.createRange();
        range.setStart(node, chars[i].start);
        range.setEnd(node, chars[end - 1].end);
        hits.push(range);
        i = end - 1;
      }
    }
    return hits;
  }

  var searchMarks = null;

  function highlight(data) {
    // Older WebKits have no CSS highlights: the slide shows no marks, and the search still works.
    if (typeof Highlight === "undefined" || !CSS.highlights) return;
    if (!searchMarks) {
      searchMarks = { all: new Highlight(), strong: new Highlight() };
      CSS.highlights.set("slop-search", searchMarks.all);
      CSS.highlights.set("slop-search-active", searchMarks.strong);
    }
    // Refilled, never replaced: WebKit keeps painting a highlight that another one replaced.
    searchMarks.all.clear();
    searchMarks.strong.clear();
    var hits = data.query ? searchHits(String(data.query), !!data.matchCase, !!data.wholeWord) : [];
    hits.forEach(function (hit, i) {
      (i === data.active ? searchMarks.strong : searchMarks.all).add(hit);
    });
  }

  if (!show) {
    var marks = document.createElement("style");
    marks.textContent =
      // Until the app sends its palette.
      ":root { --slop-canvas: #f5f5f5; --slop-accent: oklch(0.488 0.217 264); --slop-border: #e5e5e5; --slop-danger: #e7000b;" +
      " --slop-guide: #ec4899; --slop-handle: #fff; --slop-handle-foreground: #000; --slop-overlay: rgb(23 23 23 / 85%);" +
      " --slop-overlay-foreground: #fff; --slop-scrim: rgb(0 0 0 / 50%); --slop-search: #fde047; --slop-search-active: #fb923c;" +
      " --slop-ui: 1; }" +
      "::highlight(slop-search) { background-color: var(--slop-search); color: var(--slop-handle-foreground); }" +
      "::highlight(slop-search-active) { background-color: var(--slop-search-active); color: var(--slop-handle-foreground); }" +
      "html[data-slop-commenting], html[data-slop-commenting] * { cursor: crosshair !important; user-select: none !important; -webkit-user-select: none !important; }" +
      "[data-slop-comment-hover] { position: fixed; z-index: 2147483646; pointer-events: none; box-sizing: border-box; border-radius: 2px;" +
      " outline: 2px solid var(--slop-accent); background: color-mix(in srgb, var(--slop-accent) 12%, transparent); }";
    document.head.appendChild(marks);
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data) return;
    if (data.type === "slop:layer") layerOpen = !!data.open;
    if (data.type === "slop:search") highlight(data);
    if (data.type === "slop:comment-tool" && !show) setCommenting(data.on);
    if (data.type === "slop:comment-at" && !show && [data.x, data.y].every(Number.isFinite)) commentAt(data.x, data.y);
    if (data.type === "slop:comment-locate" && Array.isArray(data.comments)) {
      commentList = data.comments;
      reportCommentSpots();
    }
    if (data.type === "slop:camera") {
      if (data.home) setCamera(0, 0, 1);
      else if (Number.isFinite(data.zoomBy) && data.zoomBy > 0) zoomBy(data.zoomBy);
      else if (Number.isFinite(data.zoomTo) && data.zoomTo > 0) zoomBy(data.zoomTo / cam.k);
      else if (data.actual) zoomToActual();
      else if (data.box && typeof data.box === "object") zoomToBox(data.box);
      else if ([data.x, data.y, data.k].every(Number.isFinite)) setCamera(data.x, data.y, data.k);
    } else if (data.type === "slop:fit") {
      if (Number.isFinite(data.scale) && data.scale > 0) setUi(1 / data.scale);
    } else if (data.type === "slop:canvas") {
      if (typeof data.color === "string") root.style.setProperty("--slop-canvas", data.color);
      Object.keys(PALETTE).forEach(function (key) {
        if (typeof data[key] === "string") root.style.setProperty(PALETTE[key], data[key]);
      });
    }
  });
})();
