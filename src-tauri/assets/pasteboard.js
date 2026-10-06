/* SlopSlide pasteboard. The app adds it to the stage's slide preview, in view and edit mode (see
   src-tauri/src/protocol.rs); it is never part of deck.html or an export.

   The preview fills the whole stage area and the slide sits in its middle, at the size it has on
   the stage. The surroundings are an endless pasteboard: drag with the middle button (pressed
   mouse wheel), swipe on a trackpad or hold Space and drag to pan; turn the mouse wheel, pinch or
   Ctrl/⌘+scroll to zoom; 0 returns to the start. Without the slide editor, dragging with the
   primary button pans too. The slide's frame (outline and shadow) moves with it.
   The view is reported as { type: "slop:view", slide, x, y, k } (pan in px, zoom) and restored
   with { type: "slop:camera", x, y, k } or { type: "slop:camera", home: true }. The app also
   sends { type: "slop:canvas", color, accent }: the color of the panel around the slide and its
   accent color, which the editor uses to dim what lies outside the slide and mark edit mode.

   The slide editor (editor.js) runs after this and builds on window.slopPasteboard. */
(function () {
  var slide = document.querySelector(".deck > .slide.active");
  if (!slide || window.parent === window) return;

  var STAGE_W = 1920;
  var STAGE_H = 1080;
  var MIN_ZOOM = 0.1;
  var MAX_ZOOM = 8;
  var WHEEL_ZOOM = 0.005;
  var DRAG_THRESHOLD = 3;
  // Wheel events closer together than this belong to one gesture (a swipe and its momentum).
  var WHEEL_GESTURE_MS = 150;
  var editor = new URLSearchParams(location.search).has("edit");

  var deck = slide.parentElement;
  var root = document.documentElement;
  // The page is transparent around the slide, so keep whatever the deck painted behind it.
  if (getComputedStyle(deck).backgroundColor === "rgba(0, 0, 0, 0)") {
    var behind = [document.body, root]
      .map(function (el) {
        return getComputedStyle(el).backgroundColor;
      })
      .filter(function (color) {
        return color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent";
      })[0];
    deck.style.backgroundColor = behind || "#000";
  }
  var style = document.createElement("style");
  style.textContent =
    "html, body { background: transparent !important; }" +
    "[data-slop-frame] { position: fixed; z-index: 2147483645; pointer-events: none; box-sizing: border-box;" +
    " box-shadow: 0 20px 50px -24px rgba(0, 0, 0, 0.45); outline: 1px solid var(--slop-border, rgba(0, 0, 0, 0.1)); }";
  document.head.appendChild(style);

  // Outlines the slide's edge; the editor also dims everything outside it.
  var frame = document.createElement("div");
  frame.setAttribute("data-slop-frame", "");
  document.body.appendChild(frame);

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

  /** Where the slide's top-left corner sits when the view is not panned: it is centered. */
  function home() {
    return { x: Math.max(0, (window.innerWidth - STAGE_W) / 2), y: Math.max(0, (window.innerHeight - STAGE_H) / 2) };
  }

  /** Puts the slide (and its frame) where the view says. */
  function applyCamera() {
    var h = home();
    var x = h.x + cam.x;
    var y = h.y + cam.y;
    deck.style.transform = "translate(" + x + "px," + y + "px) scale(" + cam.k + ")";
    frame.style.cssText = "left:" + x + "px;top:" + y + "px;width:" + STAGE_W * cam.k + "px;height:" + STAGE_H * cam.k + "px";
    listeners.forEach(function (fn) {
      fn();
    });
    var key = [cam.x, cam.y, cam.k].join(",");
    if (key === reportedView) return;
    reportedView = key;
    window.parent.postMessage({ type: "slop:view", slide: slide.id, x: cam.x, y: cam.y, k: cam.k }, "*");
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

  // The middle button (pressing the mouse wheel) always pans, even while typing; Space+drag pans
  // unless typing. Without the editor, the primary button pans too, except on controls.
  document.addEventListener("pointerdown", function (event) {
    // A press always ends an earlier pan, even one whose release never arrived.
    pan = null;
    var primary = event.button === 0;
    if (event.button !== 1 && !(primary && spaceDown && !api.busy())) {
      if (!primary || editor || event.target.closest("a, button, input, select, textarea, video, audio, [contenteditable]")) return;
    }
    startPan(event);
    event.stopImmediatePropagation();
  });
  document.addEventListener("pointermove", function (event) {
    if (!pan) return;
    var dx = event.clientX - pan.x;
    var dy = event.clientY - pan.y;
    if (!pan.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    pan.moved = true;
    setCamera(pan.from.x + dx, pan.from.y + dy, cam.k);
    event.stopImmediatePropagation();
  });
  function endPan(event) {
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
   * pixel deltas, usually with some sideways motion.
   */
  function fromMouseWheel(event) {
    if (event.deltaMode !== 0) return true;
    if (event.deltaX) return false;
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

  // Capture phase, so the player never forwards these keys to the app.
  window.addEventListener(
    "keydown",
    function (event) {
      if (api.busy() || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== " " && event.key !== "0") return;
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

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data) return;
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
