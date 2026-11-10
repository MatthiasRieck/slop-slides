  // ----- Selection and arrangement: several selected elements, the marquee, ⌘A and Tab, duplicates,
  // smart guides, align and distribute, and numeric geometry (see 00-header.js). -----

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
    "[data-slop-multi] > * { outline: 2px solid var(--slop-accent); }" +
    "[data-slop-guides] > * { background: var(--slop-guide); }" +
    "[data-slop-marquee], [data-slop-readout] { position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box; }" +
    "[data-slop-marquee] { border: 1px solid var(--slop-accent); background: color-mix(in srgb, var(--slop-accent) 12%, transparent); }" +
    "[data-slop-readout] { padding: 2px 6px; border-radius: 4px; background: var(--slop-overlay); color: var(--slop-overlay-foreground);" +
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

  /** Restyles the selection; a group's restyle goes to everything in it. */
  function applyToSelection(changes) {
    var targets = leavesOf(allSelected());
    if (targets.length === allSelected().length && targets.every(isSelected)) {
      forEachSelected(function () {
        applyStyle(changes);
      });
      return;
    }
    var primary = selected;
    var others = extras;
    batching = true;
    extras = [];
    targets.forEach(function (el) {
      selected = el;
      applyStyle(changes);
    });
    selected = primary;
    extras = others;
    batching = false;
    placeHandles();
    report();
    commit();
  }

  function inDocumentOrder(list) {
    return list.slice().sort(function (a, b) {
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  /** Whether `el` is only a see-through wrapper around other elements: no text or box of its own. */
  function isBackdrop(el) {
    if (el.hasAttribute(ADDED) || el.hasAttribute(GROUP_ATTR) || paintsBox(getComputedStyle(el))) return false;
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
    allSelected().forEach(function (el) {
      var at = shownFrame(el);
      var frame = document.createElement("div");
      frame.style.cssText = "left:" + (at.x - at.w / 2) + "px;top:" + (at.y - at.h / 2) + "px;width:" + at.w + "px;height:" + at.h + "px;transform:rotate(" + at.angle + "deg)";
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
      if (isLocked(el)) return true;
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
      if (isLocked(el)) return true;
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
      if (isLocked(el)) return true;
      if (arrangeable(el) && selectable(el) === el) list.push(el);
      // What a group holds is the group's, unless it was entered.
      return isGroup(el) && el !== enteredGroup;
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
    var copies = inDocumentOrder(allSelected()).map(function (el) {
      var header = clipHeader(el);
      var copy = cleanCopy(el);
      slide.appendChild(copy);
      placeFree(copy, header, { x: header.box.x + offset, y: header.box.y + offset });
      return copy;
    });
    restickCopies(copies, function () {
      return true;
    });
    selectMany(copies);
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
    var els = clip.els.map(function (source) {
      return document.importNode(source, true);
    });
    restickCopies(els, idTaken);
    els.forEach(function (el, i) {
      slide.appendChild(el);
      placeFree(el, clip.header.group[i], {
        x: center.x - (right - left) / 2 + num(boxes[i].x) - left,
        y: center.y - (bottom - top) / 2 + num(boxes[i].y) - top,
      });
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

  /**
   * Lines up the selection with the slide (each element on its own) or, with several and a
   * `target` of "selection", with their bounds. Without a target, one element goes by the
   * slide and several by their bounds.
   */
  function alignSelection(to, target) {
    if (ALIGN_TO.indexOf(to) < 0) return;
    finishEditing();
    if (nudgeTimer) commit();
    var group = movable();
    if (!group.length) return;
    var bySlide = target === "slide" || group.length === 1;
    var area = bySlide ? { left: 0, top: 0, right: slideWidth(), bottom: slideHeight() } : boundsOf(group);
    group.forEach(function (el) {
      var box = boxOf(el);
      var dx = to === "left" ? area.left - box.left : to === "right" ? area.right - box.right : to === "center" ? (area.left + area.right - box.left - box.right) / 2 : 0;
      var dy = to === "top" ? area.top - box.top : to === "bottom" ? area.bottom - box.bottom : to === "middle" ? (area.top + area.bottom - box.top - box.bottom) / 2 : 0;
      moveBy(el, dx, dy);
    });
    commit();
  }

  /** Gives the other selected elements the primary one's width ("w") or height ("h"). */
  function matchSize(axis) {
    if (axis !== "w" && axis !== "h") return;
    finishEditing();
    if (nudgeTimer) commit();
    if (!selected || !extras.length) return;
    var frame = frameOf(selected);
    var size = axis === "w" ? frame.right - frame.left : frame.bottom - frame.top;
    if (!(size > 0)) return;
    extras.forEach(function (el) {
      if (lineOf(el) || isLocked(el)) return;
      setSize(el, axis === "w" ? size : null, axis === "h" ? size : null);
      refit(el);
    });
    placeHandles();
    commit();
  }

  /** Evens out the gaps between three or more elements along an axis, the outer two staying put. */
  function distributeSelection(axis) {
    finishEditing();
    if (nudgeTimer) commit();
    var group = movable();
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
      members: resize && isGroup(el) ? memberBoxes(el) : null,
    };
    if (resize) {
      resizeTo(sx, sy, shift);
    } else {
      scaleTo(el, sx, sy);
      moveTo(el, offset.x + shift.x, offset.y + shift.y);
    }
    drag = null;
  }

  /** Applies typed numbers (see slop:edit-geometry in 00-header.js). */
  function setGeometry(data) {
    finishEditing();
    if (nudgeTimer) commit();
    var given = function (n) {
      return typeof n === "number" && isFinite(n);
    };
    if (!geometry() || !movable().length) return;
    if (!extras.length) {
      var w = given(data.w) && data.w > 0 ? data.w : null;
      var h = given(data.h) && data.h > 0 ? data.h : null;
      // With the ratio locked, a typed width or height brings the other along.
      var before = geometry();
      if (keepRatio && (w === null) !== (h === null) && before.w > 0 && before.h > 0) {
        if (w === null) w = (h * before.w) / before.h;
        else h = (w * before.h) / before.w;
      }
      if (w !== null || h !== null) setSize(selected, w, h);
      if (given(data.rotation)) rotateTo(selected, data.rotation);
    }
    var now = geometry();
    var dx = given(data.x) ? data.x - now.x : 0;
    var dy = given(data.y) ? data.y - now.y : 0;
    if (dx || dy) {
      movable().forEach(function (el) {
        moveBy(el, dx, dy);
      });
    }
    refit(selected);
    commit();
  }

  /** Tilts the selection a step further, or flat again (see slop:edit-tilt in 00-header.js). */
  function stepTilt(data) {
    finishEditing();
    var group = allSelected();
    if (!group.length) return;
    group.forEach(function (el) {
      var now = tiltOf(el);
      if (!data.reset) tiltTo(el, now.x + (Number(data.x) || 0), now.y + (Number(data.y) || 0));
      else if (now.x || now.y) tiltTo(el, 0, 0);
    });
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(commit, NUDGE_SAVE_MS);
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
      drag.box = TILT.test(drag.el.style.transform || "") ? boxOf(drag.el) : frameOf(drag.el);
      drag.targets = snapTargets([drag.el]);
    }
    var box = drag.box;
    if (event.metaKey || event.ctrlKey || keepsRatio(event) || drag.angle % 360 || box.right <= box.left || box.bottom <= box.top) {
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
    // Lines stuck to the group move with it, so they are nothing to snap to.
    var stuck = Array.prototype.filter.call(slide.querySelectorAll("[data-from], [data-to]"), function (line) {
      return ENDS.some(function (end) {
        var target = stuckTo(line, end);
        return target && group.some(function (el) {
          return el.contains(target);
        });
      });
    });
    drag.targets = snapTargets(group.concat(stuck));
    // A line dragged on its own lets go of what it is not dragged along with.
    drag.lines = group.filter(function (el) {
      ENDS.forEach(function (end) {
        var target = stuckTo(el, end);
        var along = target && group.some(function (other) {
          return other.contains(target);
        });
        if (!along) unstick(el, end);
      });
      return !!lineOf(el);
    });
  }

  function moveDrag(event, dx, dy) {
    if (!drag.group) startMove(event);
    // Shift keeps a move straight across or straight up and down, whichever it mostly goes.
    var across = Math.abs(dx) >= Math.abs(dy);
    if (event.shiftKey) {
      if (across) dy = 0;
      else dx = 0;
    }
    var by = snapMove(dx / drag.zoom, dy / drag.zoom, event);
    if (event.shiftKey) by = across ? { x: by.x, y: 0 } : { x: 0, y: by.y };
    drag.group.forEach(function (item) {
      moveTo(item.el, item.from.x + by.x, item.from.y + by.y);
    });
    followLines(drag.lines);
    showReadout(event);
  }

  /** The position and size (or turn) next to the pointer while dragging. */
  function showReadout(event) {
    var now = geometry();
    if (!now || drag.mode === "tilt" || drag.mode === "adjust") return;
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
    else if (data.type === "slop:edit-align") alignSelection(String(data.to), data.target);
    else if (data.type === "slop:edit-match") matchSize(String(data.axis));
    else if (data.type === "slop:edit-distribute") distributeSelection(String(data.axis));
    else if (data.type === "slop:edit-geometry") setGeometry(data);
    else if (data.type === "slop:edit-tilt") stepTilt(data);
    else return false;
    return true;
  }

