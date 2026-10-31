/* SlopSlide pasteboard. The app adds it to the stage's slide preview, in view and edit mode (see
   src-tauri/src/protocol.rs); it is never part of deck.html or an export.

   The preview fills the whole stage area and the slide sits in its middle, at the size it has on
   the stage. The surroundings are an endless pasteboard: drag with the middle button (pressed
   mouse wheel), swipe on a trackpad or hold Space and drag to pan; turn the mouse wheel, pinch or
   Ctrl/⌘+scroll to zoom; 0 returns to the start. Without the slide editor, dragging with the
   primary button pans too, except from text, which it selects instead (even text under an
   invisible layer the deck spreads over the slide), and from links and other controls. The slide's frame (outline and shadow) moves with it.
   The view is reported as { type: "slop:view", slide, x, y, k } (pan in px, zoom) and restored
   with { type: "slop:camera", x, y, k } or { type: "slop:camera", home: true }. The app also
   sends { type: "slop:canvas", color, accent }: the color of the panel around the slide and its
   accent color, which the editor uses to dim what lies outside the slide and mark edit mode.
   A press on the preview while it lacks keyboard focus posts { type: "slop:focus" }, and the
   app focuses the preview.

   { type: "slop:search", query, matchCase, wholeWord, active } marks what the search in the app's
   toolbar finds on the slide, with the `active`th hit stronger. It reads the text as find.rs does,
   so both count the same hits. The marks are CSS highlights, which leave the slide's markup alone.

   The slide editor (editor.js) runs after this and builds on window.slopPasteboard.

   With ?show, the presenter plays the whole deck and this zooms and pans the slide being shown
   instead: the view starts with the slide fit to the window, as the player has it, and returns
   there whenever the show moves to another slide. Clicks and Space stay the player's, so only the
   middle button and trackpad swipes pan, and nothing is drawn around the slide. The view is
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
  var DRAG_THRESHOLD = 3;
  // Wheel events closer together than this belong to one gesture (a swipe and its momentum).
  var WHEEL_GESTURE_MS = 150;
  var editor = params.has("edit");

  var deck = slide.parentElement;
  var root = document.documentElement;
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
      " box-shadow: 0 20px 50px -24px rgba(0, 0, 0, 0.45); outline: 1px solid var(--slop-border, rgba(0, 0, 0, 0.1)); }";
    document.head.appendChild(style);
    frame = document.createElement("div");
    frame.setAttribute("data-slop-frame", "");
    document.body.appendChild(frame);
  }

  // The view: pan in px away from the slide being centered, and zoom.
  var cam = { x: 0, y: 0, k: 1 };
  var reportedView = "0,0,1";
  var spaceDown = false;
  var pan = null;
  var listeners = [];

  var api = {
    frame: frame,
    view: function () {
      return { x: cam.x, y: cam.y, k: cam.k };
    },
    startPan: startPan,
    /** Calls `fn` whenever the view moves. */
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

  /** Puts the slide (and its frame) where the view says. */
  function applyCamera() {
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
    // Lengths on a zoomed element are zoomed too, so the pan is given in unzoomed px.
    var z = Math.max(1, k);
    deck.style.zoom = String(z);
    deck.style.transform = "translate(" + x / z + "px," + y / z + "px)" + (k < 1 ? " scale(" + k + ")" : "");
    if (frame) frame.style.cssText = "left:" + x + "px;top:" + y + "px;width:" + STAGE_W * k + "px;height:" + STAGE_H * k + "px";
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

  function setCamera(x, y, k) {
    cam = { x: x, y: y, k: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k)) };
    applyCamera();
  }

  /** Zooms by `factor` keeping the slide point under the screen point (px, py) in place. */
  function zoomAt(px, py, factor) {
    var h = home();
    var k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.k * factor));
    var f = k / cam.k;
    setCamera(px - (px - h.x - cam.x) * f - h.x, py - (py - h.y - cam.y) * f - h.y, k);
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

  // The middle button (pressing the mouse wheel) always pans, even while typing; Space+drag pans
  // unless typing. Without the editor, the primary button pans too, except from text (to select
  // it, even under a layer the deck put over it) and controls; in a show it clicks through the
  // slides.
  document.addEventListener("pointerdown", function (event) {
    // A press always ends an earlier pan or selection, even one whose release never arrived.
    pan = null;
    endSelecting();
    var primary = event.button === 0;
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
    if (!pan.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    pan.moved = true;
    setCamera(pan.from.x + dx, pan.from.y + dy, cam.k);
    event.stopImmediatePropagation();
  });
  function endPan(event) {
    endSelecting();
    if (!pan) return;
    pan = null;
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

  // Pinching (reported as Ctrl+wheel) and the mouse wheel zoom the pasteboard around the pointer;
  // with a mouse, panning is the middle button. Swiping on a trackpad pans. A gesture is
  // classified by its first event, so a swipe never turns into a zoom halfway through.
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
      if (event.ctrlKey || event.metaKey || (wheelGesture.mouse && dy)) {
        zoomAt(event.clientX, event.clientY, Math.exp(-Math.max(-60, Math.min(60, dy)) * WHEEL_ZOOM));
      } else {
        setCamera(cam.x - dx, cam.y - dy, cam.k);
      }
    },
    { passive: false },
  );

  // Capture phase, so the player never forwards these keys to the app. In a show, Space advances.
  window.addEventListener(
    "keydown",
    function (event) {
      if (api.busy() || event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.key !== " " || show) && event.key !== "0") return;
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
      "::highlight(slop-search) { background-color: #fde047; color: #000; }" +
      "::highlight(slop-search-active) { background-color: #fb923c; color: #000; }";
    document.head.appendChild(marks);
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data) return;
    if (data.type === "slop:search") highlight(data);
    if (data.type === "slop:camera") {
      if (data.home) setCamera(0, 0, 1);
      else if ([data.x, data.y, data.k].every(Number.isFinite)) setCamera(data.x, data.y, data.k);
    } else if (data.type === "slop:canvas") {
      if (typeof data.color === "string") root.style.setProperty("--slop-canvas", data.color);
      if (typeof data.accent === "string") root.style.setProperty("--slop-accent", data.accent);
      if (typeof data.border === "string") root.style.setProperty("--slop-border", data.border);
    }
  });
})();
