  // ----- Groups, locks and layers (see 00-header.js). -----

  /** Whether `el` is a group the user made: a box around the elements it holds, which go together. */
  function isGroup(el) {
    return !!el && el.nodeType === 1 && el.hasAttribute(GROUP_ATTR);
  }

  /** Whether `el` is locked, or sits in something locked: it cannot be picked, moved or deleted. */
  function isLocked(el) {
    var lock = el && el.nodeType === 1 ? el.closest("[" + LOCK_ATTR + "]") : null;
    return !!lock && slide.contains(lock) && lock !== slide;
  }

  /** The selected elements that may move or go: not the locked ones. */
  function movable() {
    return allSelected().filter(function (el) {
      return !isLocked(el);
    });
  }

  /** What a group holds that shows, in order: its members. */
  function membersOf(group) {
    return Array.prototype.filter.call(group.children, function (el) {
      return !NOT_CONTENT.test(el.tagName);
    });
  }

  /** The elements a restyle of `list` goes to: each one, or for a group, everything in it. */
  function leavesOf(list) {
    var out = [];
    list.forEach(function (el) {
      if (isGroup(el)) out = out.concat(leavesOf(membersOf(el)));
      else out.push(el);
    });
    return out;
  }

  /**
   * Gives `el` a fixed box at (left, top), w × h (its border box), positioned in what holds it,
   * and drops the translate that moved it: its place is all in left and top now.
   */
  function freeBox(el, left, top, w, h) {
    var pad = boxPadding(getComputedStyle(el));
    el.style.position = "absolute";
    el.style.margin = "0px";
    el.style.left = roundTenth(left) + "px";
    el.style.top = roundTenth(top) + "px";
    el.style.right = el.style.bottom = "auto";
    el.style.width = roundTenth(Math.max(0, w - pad.x)) + "px";
    if (el.getAttribute("data-autofit") !== "grow") el.style.height = roundTenth(Math.max(0, h - pad.y)) + "px";
    el.style.flex = "none";
    moveTo(el, 0, 0);
  }

  /**
   * ⌘G: puts the selected elements in a group at the slide's top level, on top where the last of
   * them was: a box around them all, which they keep their places and looks in. One that was
   * in the layout leaves its placeholder behind, so the layout stays put.
   */
  function groupSelection() {
    finishEditing();
    saveNudges();
    var members = inDocumentOrder(movable());
    if (members.length < 2) return;
    var bounds = boundsOf(members);
    var places = members.map(function (el) {
      var f = frameOf(el);
      var size = sizeOf(el);
      return { el: el, x: (f.left + f.right) / 2, y: (f.top + f.bottom) / 2, w: size.w, h: size.h };
    });
    var group = document.createElement("div");
    group.setAttribute(GROUP_ATTR, "");
    group.setAttribute(
      "style",
      "position: absolute; left: " + roundTenth(bounds.left) + "px; top: " + roundTenth(bounds.top) + "px; width: " +
        roundTenth(bounds.right - bounds.left) + "px; height: " + roundTenth(bounds.bottom - bounds.top) + "px; margin: 0px;",
    );
    var last = members[members.length - 1];
    while (last.parentElement !== slide) last = last.parentElement;
    slide.insertBefore(group, last.nextSibling);
    places.forEach(function (p) {
      var el = p.el;
      if (!/^(absolute|fixed)$/.test(getComputedStyle(el).position) && !placeholderOf(el)) {
        el.parentElement.insertBefore(slotFor(el, PLACEHOLDER), el.nextSibling);
      }
      group.appendChild(el);
      freeBox(el, p.x - bounds.left - p.w / 2, p.y - bounds.top - p.h / 2, p.w, p.h);
    });
    select(group);
    commit();
  }

  /** ⇧⌘G: takes the selected groups apart, their elements staying where they show, turned and scaled as they look. */
  function ungroupSelection() {
    finishEditing();
    saveNudges();
    var freed = [];
    movable().filter(isGroup).forEach(function (group) {
      var angle = angleOf(group);
      var scale = scaleOf(group);
      var at = camera();
      var places = membersOf(group).map(function (el) {
        var center = centerOf(el);
        return { el: el, x: (center.x - at.left) / at.k, y: (center.y - at.top) / at.k, size: sizeOf(el), scale: scaleOf(el) };
      });
      places.forEach(function (p) {
        var el = p.el;
        slide.insertBefore(el, group);
        el.style.left = roundTenth(p.x - p.size.w / 2) + "px";
        el.style.top = roundTenth(p.y - p.size.h / 2) + "px";
        moveTo(el, 0, 0);
        if (angle) rotateTo(el, angleOf(el) + angle);
        if (scale.x !== 1 || scale.y !== 1) scaleTo(el, p.scale.x * scale.x, p.scale.y * scale.y);
        freed.push(el);
      });
      group.parentNode.removeChild(group);
    });
    if (!freed.length) return;
    enteredGroup = null;
    selectMany(freed);
    commit();
  }

  /** The boxes of what `group` holds, as they are when its resize starts, and of what its groups hold. */
  function memberBoxes(group) {
    return membersOf(group).map(function (el) {
      var computed = getComputedStyle(el);
      var box = { el: el, left: parseFloat(computed.left) || 0, top: parseFloat(computed.top) || 0, size: sizeOf(el), offset: offsetOf(el) };
      holdContents(box);
      return box;
    });
  }

  /**
   * Spreads what a group holds by kx × ky with its box: their places and sizes, not their text or
   * line widths. The first step gives each a fixed box in its group and reads what every step
   * needs; after it a step only writes its place and size.
   */
  function spreadMembers(boxes, kx, ky) {
    boxes.forEach(function (b) {
      var el = b.el;
      var w = b.size.w * kx;
      var h = b.size.h * ky;
      var first = !b.pad;
      if (first) {
        freeBox(el, b.left, b.top, b.size.w, b.size.h);
        var computed = getComputedStyle(el);
        b.pad = boxPadding(computed);
        b.contentBox = computed.boxSizing !== "border-box";
        b.grows = el.getAttribute("data-autofit") === "grow";
      }
      // As in resizeTo: a figure's padding goes by its size.
      if (b.figure && b.contentBox) b.pad = boxPadding(getComputedStyle(el));
      el.style.left = roundTenth(b.left * kx) + "px";
      el.style.top = roundTenth(b.top * ky) + "px";
      el.style.width = roundTenth(Math.max(0, w - b.pad.x)) + "px";
      if (!b.grows) el.style.height = roundTenth(Math.max(0, h - b.pad.y)) + "px";
      moveTo(el, b.offset.x * kx, b.offset.y * ky);
      if (b.vectors && b.size.w && b.size.h) spreadVectors(b.vectors, kx, ky);
      if (b.members) spreadMembers(b.members, kx, ky);
      if (first) b.figure = resizedPaint(el);
      if (b.figure) scheduleFigure(el, b.figure);
    });
  }

  /** Locks or unlocks `list` (with nothing given, the selection). */
  function lockElements(list, on) {
    finishEditing();
    saveNudges();
    list.forEach(function (el) {
      mark(el, LOCK_ATTR, !!on);
    });
    placeHandles();
    report();
    commit();
  }

  // ---- The layer list: what is on the slide, the top-most first, for the app's Layers panel.

  var reportedLayers = null;
  var layersFrame = 0;
  var TAG_NAMES = {
    p: "Paragraph", ul: "List", ol: "List", li: "List", img: "Image", picture: "Image", video: "Video", canvas: "Canvas",
    table: "Table", figure: "Figure", blockquote: "Quote", span: "Text", a: "Link", button: "Button", iframe: "Embed",
  };
  var FIGURE_NAMES = {
    "block-arrow": "Block arrow",
    "double-arrow": "Double arrow",
    bubble: "Speech bubble",
  };

  /** What the Layers panel calls `el`: its kind, and the start of its text. */
  function layerName(el) {
    var text = String(el.textContent || "").replace(/\s+/g, " ").trim();
    var clip = function (kind) {
      return text ? kind + ": " + (text.length > 32 ? text.slice(0, 31) + "…" : text) : kind;
    };
    if (isGroup(el)) return "Group of " + membersOf(el).length;
    var figure = figureOf(el);
    if (figure) return clip(FIGURE_NAMES[figure] || figure.charAt(0).toUpperCase() + figure.slice(1));
    var line = lineOf(el);
    if (line) return line.route ? "Connector" : line.heads.start || line.heads.end ? "Arrow" : "Line";
    if (el.getAttribute("data-outline")) return el.getAttribute("data-outline") === "brace" ? "Brace" : "Bracket";
    if (el.getAttribute(ADDED) === "drawing") return "Drawing";
    if (isImage(el)) return el.getAttribute("alt") ? "Image: " + el.getAttribute("alt") : "Image";
    if (el.getAttribute(ADDED) === "shape") return clip("Shape");
    if (el.getAttribute(ADDED) === "text") return clip("Text");
    var tag = el.tagName.toLowerCase();
    var kind = /^h[1-6]$/.test(tag) ? "Heading" : TAG_NAMES[tag] || (el.namespaceURI === SVG_NS ? "Drawing" : "Box");
    return clip(kind);
  }

  /**
   * `list` in the order it paints, the top-most last: by z-index (positioned elements above the
   * others, as with no z-index at all), then in the slide's order.
   */
  function paintOrder(list) {
    return inDocumentOrder(list).map(function (el, i) {
      var style = getComputedStyle(el);
      var z = parseInt(style.zIndex, 10);
      return { el: el, i: i, z: style.position && style.position !== "static" ? (isNaN(z) ? 0 : z) : STATIC_Z };
    }).sort(function (a, b) {
      return a.z - b.z || a.i - b.i;
    }).map(function (o) {
      return o.el;
    });
  }

  /** The layers `el` is listed among (see layers): what its group holds, or the slide's top-level ones. */
  function layerPeers(el) {
    var group = el.parentElement && isGroup(el.parentElement) ? el.parentElement : null;
    if (group) return membersOf(group).filter(paints);
    var top = [];
    walkContent(slide, function (other) {
      if (!arrangeable(other)) return false;
      top.push(other);
      return true;
    });
    return top.indexOf(el) >= 0 ? top : [el];
  }

  /** The slide's layers, the top-most first: what can be selected on it, and in a group what it holds. */
  function layers() {
    var rows = [];
    var add = function (list, depth) {
      paintOrder(list).reverse().forEach(function (el) {
        rows.push({
          path: pathOf(el),
          name: layerName(el),
          group: isGroup(el),
          locked: el.hasAttribute(LOCK_ATTR),
          held: !el.hasAttribute(LOCK_ATTR) && isLocked(el),
          selected: isSelected(el),
          depth: depth,
        });
        if (isGroup(el)) add(membersOf(el).filter(function (m) {
          return paints(m);
        }), depth + 1);
      });
    };
    var top = [];
    walkContent(slide, function (el) {
      if (!arrangeable(el)) return false;
      top.push(el);
      return true;
    });
    add(top, 0);
    return rows;
  }

  function reportLayers() {
    layersFrame = 0;
    var now = layers();
    var key = JSON.stringify(now);
    if (key === reportedLayers) return;
    reportedLayers = key;
    window.parent.postMessage({ type: "slop:edit-layers", slide: slide.id, layers: now }, "*");
  }

  function scheduleLayers() {
    if (!layersFrame) layersFrame = window.requestAnimationFrame(reportLayers);
  }
  scheduleLayers();

  /** Handles the app's messages for this section; true when `data` was one. */
  function groupMessage(data) {
    var target = Array.isArray(data.path) ? atPath(data.path) : null;
    if (data.type === "slop:edit-group") groupSelection();
    else if (data.type === "slop:edit-ungroup") ungroupSelection();
    else if (data.type === "slop:edit-lock") lockElements(target ? [target] : allSelected(), !!data.locked);
    else return false;
    return true;
  }

