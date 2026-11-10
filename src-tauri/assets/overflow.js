/* What runs past a slide or is cut off. Shared by the slide editor (assets/editor.js), which
   runs it in the stage's preview, and the agent's slide renders (assets/render.js), which run
   it in a hidden window. It never becomes part of a deck. */
window.__slopOverflow = (function () {
  // Marks an element the user added (a text box, shape or drawing); it stays in the markup.
  var ADDED = "data-added";
  var PLACEHOLDER = "data-resize-placeholder";
  var DELETED = "data-delete-placeholder";
  // Invisible layout slots the editor leaves behind; never selected or checked for overflow.
  var SLOTS = "[" + PLACEHOLDER + "], [" + DELETED + "]";
  var TOLERANCE = 2;

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

  /** Which of the slide's edges `rect` runs past, with by how many slide pixels. */
  function pastEdges(rect, bounds, k) {
    var past = [];
    var add = function (side, by) {
      by /= k;
      if (by > TOLERANCE) past.push({ side: side, by: Math.round(by) });
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

  /** How many screen pixels one pixel of `slide` takes up. */
  function zoom(slide) {
    var value = slide.getBoundingClientRect().width / slide.offsetWidth;
    return isFinite(value) && value > 0 ? value : 1;
  }

  /** Elements that run past `slide`'s edge or are cut off by their own box; the innermost ones. */
  function find(slide) {
    var bounds = slide.getBoundingClientRect();
    var k = zoom(slide);
    var hits = [];
    Array.prototype.forEach.call(slide.querySelectorAll("*"), function (el) {
      var svg = el.closest("svg");
      if ((svg && svg !== el) || el.closest(".notes, .narration, " + SLOTS)) return;
      var rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      var past = hasContent(el) && paints(el) ? pastEdges(rect, bounds, k) : [];
      var style = getComputedStyle(el);
      var clips = style.overflowX !== "visible" || style.overflowY !== "visible";
      var cut = clips && (el.scrollWidth > el.clientWidth + TOLERANCE || el.scrollHeight > el.clientHeight + TOLERANCE);
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

  function describe(hit) {
    var what = hit.past.map(function (p) {
      return "runs past the " + p.side + " edge by " + p.by + "px";
    });
    if (hit.cut) what.push("is cut off by its own box");
    return nameOf(hit.el) + " " + what.join(" and ");
  }

  return {
    ADDED: ADDED,
    PLACEHOLDER: PLACEHOLDER,
    DELETED: DELETED,
    SLOTS: SLOTS,
    paints: paints,
    paintsBox: paintsBox,
    find: find,
    nameOf: nameOf,
    describe: describe,
    zoom: zoom,
  };
})();
