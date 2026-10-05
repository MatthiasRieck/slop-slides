/* SlopSlide slide editor. The app adds it to the stage's slide preview in edit mode (see
   src-tauri/src/protocol.rs); it is never part of deck.html or an export.

   Click selects an element, drag (or arrow keys) moves it, double-click (or Enter) edits its
   text, Escape selects the parent, Delete removes it. Every change is posted to the app as
   the slide's new markup: { type: "slop:edit-commit", slide, markup, select }. */
(function () {
  var slide = document.querySelector(".deck > .slide.active");
  if (!slide || window.parent === window) return;

  // Attributes the editor adds while it works; stripped from the markup it saves.
  var EDITOR_ATTRS = ["contenteditable", "data-slop-selected", "data-slop-hover", "data-slop-editing"];
  var MOVED = "data-moved";
  var DRAG_THRESHOLD = 3;
  var DOUBLE_CLICK_MS = 400;
  var NUDGE_SAVE_MS = 500;

  var style = document.createElement("style");
  style.textContent =
    ".deck > .slide.active, .deck > .slide.active * { -webkit-user-select: none; user-select: none; }" +
    "[data-slop-hover] { outline: 3px dashed rgba(59, 130, 246, 0.7) !important; outline-offset: 4px; }" +
    "[data-slop-selected] { outline: 4px solid #3b82f6 !important; outline-offset: 4px; cursor: move !important; }" +
    ".deck > .slide.active [data-slop-editing], .deck > .slide.active [data-slop-editing] * {" +
    " -webkit-user-select: text; user-select: text; cursor: text !important; }";
  document.head.appendChild(style);

  var saved = serialize();
  var selected = null;
  var hovered = null;
  var editing = null;
  var drag = null;
  var nudgeTimer = null;
  var lastDown = { el: null, at: 0 };

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
    if (x === 0 && y === 0) {
      el.style.removeProperty("translate");
      if (!el.getAttribute("style")) el.removeAttribute("style");
      el.removeAttribute(MOVED);
    } else {
      el.style.translate = x + "px " + y + "px";
      el.setAttribute(MOVED, "");
    }
  }

  function startEditing(el, x, y) {
    if (!el || editing || /^(img|svg|video|canvas|iframe|hr|br)$/i.test(el.tagName)) return;
    if (!el.textContent.trim()) return;
    select(el);
    editing = el;
    el.setAttribute("contenteditable", "true");
    el.setAttribute("data-slop-editing", "");
    el.focus();
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
    editing.removeAttribute("contenteditable");
    editing.removeAttribute("data-slop-editing");
    editing = null;
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    commit();
  }

  function removeSelected() {
    var el = selected;
    select(null);
    el.parentElement.removeChild(el);
    commit();
  }

  document.addEventListener("pointerdown", function (event) {
    if (event.button !== 0) return;
    if (editing && editing.contains(event.target)) return;
    finishEditing();
    if (nudgeTimer) commit();
    var el = pickable(event.target, event.clientX, event.clientY);
    var now = Date.now();
    var double = el && el === lastDown.el && now - lastDown.at < DOUBLE_CLICK_MS;
    lastDown = { el: el, at: double ? 0 : now };
    select(el);
    if (!el) return;
    if (double) {
      startEditing(el, event.clientX, event.clientY);
      return;
    }
    event.preventDefault();
    var start = offsetOf(el);
    drag = { el: el, x: event.clientX, y: event.clientY, from: start, moved: false };
    if (el.setPointerCapture) {
      try {
        el.setPointerCapture(event.pointerId);
      } catch (e) {
        // Synthetic events have no active pointer to capture.
      }
    }
  });

  document.addEventListener("pointermove", function (event) {
    if (!drag) {
      hover(editing ? null : pickable(event.target, event.clientX, event.clientY));
      return;
    }
    var dx = event.clientX - drag.x;
    var dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    lastDown = { el: null, at: 0 };
    hover(null);
    moveTo(drag.el, drag.from.x + dx, drag.from.y + dy);
  });

  function endDrag() {
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
  // Clicking elsewhere in the app ends text editing, keeping the text.
  window.addEventListener("blur", finishEditing);
  document.addEventListener("dblclick", function (event) {
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
    }
  });
})();
