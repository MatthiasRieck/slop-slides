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
  // Where the drag's readout goes (by the pointer, in the window's pixels), while one shows.
  var readoutAt = null;
  // The guide lines drawn, as one string, so a move that leaves them be draws nothing.
  var drawnGuides = "";
  // How close, in screen pixels (see onScreen), a dragged edge or center comes before it snaps.
  var SNAP_PX = 6;
  // How tall the ticks at the ends of an equal-spacing mark are, in screen pixels.
  var GAP_MARK = 9;
  // An element that holds others and covers this share of the slide is its background layer (see isBackground).
  var BACKGROUND_SHARE = 0.9;
  // Whether each element asked about is one, until the slide changes (see noteChange).
  var backgroundLayers = null;
  // The copies the last duplicate made and where their originals were, for ⌘D to go on from (see repeatOffset).
  var lastDuplicate = null;
  // Never part of the slide's visible content.
  var NOT_CONTENT = /^(script|style|template|link|meta|title)$/i;
  var ASIDES = ".notes, .narration, .slop-review, " + SLOTS;
  var ALIGN_TO = ["left", "center", "right", "top", "middle", "bottom"];

  style.textContent +=
    "[data-slop-multi], [data-slop-guides] { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; }" +
    "[data-slop-multi] > *, [data-slop-guides] > * { position: absolute; box-sizing: border-box; }" +
    // Each of several selected elements has a thin line of its own inside the frame around them all.
    "[data-slop-multi] > * { outline: " + px(1) + " solid var(--slop-accent); box-shadow: 0 0 0 " + px(2) + " " + HALO + "; }" +
    "[data-slop-guides] > * { background: var(--slop-guide); }" +
    // An equal-spacing mark: a line across the gap with a tick at each end.
    "[data-slop-guides] > [data-gap=x] { border: solid var(--slop-guide); border-width: 0 " + px(1) + ";" +
    " background: linear-gradient(var(--slop-guide), var(--slop-guide)) center / 100% " + px(1) + " no-repeat; }" +
    "[data-slop-guides] > [data-gap=y] { border: solid var(--slop-guide); border-width: " + px(1) + " 0;" +
    " background: linear-gradient(var(--slop-guide), var(--slop-guide)) center / " + px(1) + " 100% no-repeat; }" +
    "[data-slop-marquee], [data-slop-readout] { position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box; }" +
    "[data-slop-marquee] { border: " + px(1) + " solid var(--slop-accent); box-shadow: 0 0 0 " + px(1) + " " + HALO + ";" +
    " background: color-mix(in srgb, var(--slop-accent) 12%, transparent); }" +
    "[data-slop-readout] { padding: " + px(2) + " " + px(6) + "; border-radius: " + px(4) + "; background: var(--slop-overlay);" +
    " color: var(--slop-overlay-foreground); font: " + px(11) + "/1.4 system-ui, sans-serif; font-variant-numeric: tabular-nums; white-space: nowrap; }";

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

  /**
   * Selects just `list`, the first one primary; an element goes along with one that holds it.
   * With `soon` (a marquee growing with every pointer move), the handles and the report to the
   * app follow next frame.
   */
  function selectMany(list, soon) {
    var unique = list.filter(function (el, i) {
      return el && list.indexOf(el) === i && !list.some(function (other) {
        return other && other !== el && other.contains(el);
      });
    });
    if (unique.length === allSelected().length && unique.every(isSelected)) return;
    setSelection(unique[0] || null, unique.slice(1));
    if (soon) {
      scheduleHandles();
      scheduleReport();
    } else {
      placeHandles();
      report();
    }
  }

  /** Shift-click: takes `el` out of the selection, or adds it instead of what holds it or it holds. */
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

  /** Whether this press reaches under what is selected (see selectUnder): with ⌘ / Ctrl. On a Mac, Ctrl-click is a right click. */
  function reachesUnder(event) {
    return event.metaKey || (event.ctrlKey && !/Mac/.test(navigator.platform));
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
    restyled();
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
    restyled();
    commit();
  }

  function inDocumentOrder(list) {
    return list.slice().sort(function (a, b) {
      return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }

  /** Whether `el` is a wrapper the deck made around other elements, with no text of its own. */
  function holdsElements(el) {
    if (el.hasAttribute(ADDED) || el.hasAttribute(GROUP_ATTR)) return false;
    var ownText = Array.prototype.some.call(el.childNodes, function (node) {
      return node.nodeType === 3 && node.data.trim();
    });
    return !ownText && Array.prototype.some.call(el.children, function (child) {
      return selectable(child) === child;
    });
  }

  /** Whether `el` is only a see-through wrapper around other elements: no text or box of its own. */
  function isBackdrop(el) {
    return !paintsBox(getComputedStyle(el)) && holdsElements(el);
  }

  /**
   * Whether `el` is the slide's background layer: a wrapper around the slide's content that
   * covers (nearly) all of the slide, as a deck's layout with a background of its own does. It
   * is the ground the content lies on, not one more thing on the slide: a press on its empty
   * part is a press on the empty slide (it deselects, draws a marquee, opens the slide's menu),
   * and the marquee, ⌘A and Tab pass it by for what it holds. It is selected from the Layers
   * list, with ⌘ / Ctrl-click, or from the context menu, and then moves like anything else.
   */
  function isBackground(el) {
    if (!backgroundLayers) backgroundLayers = new WeakMap();
    if (backgroundLayers.has(el)) return backgroundLayers.get(el);
    var covers = false;
    if (holdsElements(el)) {
      var box = boxOf(el);
      var w = Math.min(box.right, slideWidth()) - Math.max(box.left, 0);
      var h = Math.min(box.bottom, slideHeight()) - Math.max(box.top, 0);
      covers = w > 0 && h > 0 && w * h >= BACKGROUND_SHARE * slideWidth() * slideHeight();
    }
    backgroundLayers.set(el, covers);
    return covers;
  }

  /** Whether `el` is a thing on the slide of its own, to select with others. */
  function arrangeable(el) {
    return selectable(el) === el && paints(el) && !isBackdrop(el) && !isBackground(el);
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
    var at = camera();
    return {
      left: (rect.left - at.left) / at.k,
      top: (rect.top - at.top) / at.k,
      right: (rect.right - at.left) / at.k,
      bottom: (rect.bottom - at.top) / at.k,
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
    var at = camera();
    var size = sizeOf(el);
    var scale = scaleOf(el);
    var w = size.w * scale.x;
    var h = size.h * scale.y;
    var left = (center.x - at.left) / at.k - w / 2;
    var top = (center.y - at.top) / at.k - h / 2;
    return { left: left, top: top, right: left + w, bottom: top + h };
  }

  /** A frame around each of several selected elements, turned with it; gives back where each is (see shownFrame). */
  function placeFrames() {
    var group = !extras.length || editing ? [] : allSelected();
    // Every element is measured before any frame is written, so the layout is worked out once.
    var shown = group.map(shownFrame);
    var nodes = fitChildren(frames, shown.length, newDiv);
    shown.forEach(function (at, i) {
      nodes[i].style.cssText = "left:" + (at.x - at.w / 2) + "px;top:" + (at.y - at.h / 2) + "px;width:" + at.w + "px;height:" + at.h + "px;transform:rotate(" + at.angle + "deg)";
    });
    return shown;
  }

  /**
   * Starts a marquee at the pointer, on the slide or on the pasteboard around it; `picked` is
   * what a click there selects, and with `add` the marquee adds to the selection.
   */
  function startMarquee(event, picked, add) {
    event.preventDefault();
    dropHover();
    var before = allSelected();
    marquee = { x: event.clientX, y: event.clientY, picked: picked, add: add, base: add ? before : [], before: before, moved: false, items: null };
    // A press on an empty spot lets go of the selection at once.
    if (!add && !picked) select(null);
    try {
      document.documentElement.setPointerCapture(event.pointerId);
    } catch (e) {
      // Synthetic events have no active pointer to capture.
    }
  }

  /**
   * What a marquee can select in `root`, measured once for all of its pointer moves: each
   * element that is not locked with its box in slide pixels (null when it is not one to select
   * on its own) and what it holds, which is looked at where the element is not selected whole.
   */
  function marqueeItems(root) {
    var items = [];
    walkContent(root, function (el) {
      if (!isLocked(el)) items.push({ el: el, box: arrangeable(el) ? boxOf(el) : null, inner: marqueeItems(el) });
      return true;
    });
    return items;
  }

  /**
   * The outermost elements of `items` (see marqueeItems) that `area`, in slide pixels, touches,
   * or with `enclosed` (Alt held), only those fully inside it.
   */
  function elementsIn(area, items, enclosed) {
    var found = [];
    items.forEach(function (item) {
      var box = item.box;
      var real = !!box && box.right > box.left && box.bottom > box.top;
      var hit = real && (enclosed
        ? box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom
        : box.left < area.right && box.right > area.left && box.top < area.bottom && box.bottom > area.top);
      if (hit) found.push(item.el);
      else found = found.concat(elementsIn(area, item.inner, enclosed));
    });
    return found;
  }

  function marqueeTo(event) {
    var dx = event.clientX - marquee.x;
    var dy = event.clientY - marquee.y;
    if (!marquee.moved && Math.abs(dx) < onScreen(DRAG_THRESHOLD) && Math.abs(dy) < onScreen(DRAG_THRESHOLD)) return;
    marquee.moved = true;
    lastDown = { el: null, at: 0 };
    var left = Math.min(marquee.x, event.clientX);
    var top = Math.min(marquee.y, event.clientY);
    var w = Math.abs(dx);
    var h = Math.abs(dy);
    marqueeBox.style.cssText = "left:" + left + "px;top:" + top + "px;width:" + w + "px;height:" + h + "px";
    if (!marquee.items) marquee.items = marqueeItems(slide);
    var at = camera();
    var x = (left - at.left) / at.k;
    var y = (top - at.top) / at.k;
    var area = { left: x, top: y, right: x + w / at.k, bottom: y + h / at.k };
    selectMany(marquee.base.concat(elementsIn(area, marquee.items, event.altKey)), true);
  }

  // A press ends a marquee whose release never arrived.
  window.addEventListener(
    "pointerdown",
    function () {
      if (marquee) finishMarquee();
    },
    true,
  );

  function finishMarquee() {
    var done = marquee;
    marquee = null;
    marqueeBox.style.display = "none";
    if (!done.moved && !done.add) select(done.picked);
    // What the marquee selected last shows right away, and the app is told.
    flushHandles();
    if (reportFrame) report();
  }

  /** ⌘A: everything on the slide, wrappers giving way to what they hold. */
  function selectAll() {
    if (tool !== "select") return;
    finishEditing();
    saveNudges();
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
    saveNudges();
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
   * Puts a copy of each selected element on top of the slide, (dx, dy) slide pixels away and
   * looking as it does, and selects the copies. The caller saves.
   */
  function duplicateSelected(dx, dy) {
    finishEditing();
    saveNudges();
    var from = [];
    var copies = inDocumentOrder(allSelected()).map(function (el) {
      var header = clipHeader(el);
      var copy = cleanCopy(el);
      slide.appendChild(copy);
      placeFree(copy, header, { x: header.box.x + dx, y: header.box.y + dy });
      from.push({ x: header.box.x, y: header.box.y });
      return copy;
    });
    restickCopies(copies, function () {
      return true;
    });
    selectMany(copies);
    lastDuplicate = { copies: copies, from: from };
  }

  /**
   * How far the copies of the last duplicate were moved from their originals, when they are still
   * what is selected: the next duplicate goes on by as much, so a row or a grid is one ⌘D per
   * copy. Null otherwise, and for copies that were not moved at all.
   */
  function repeatOffset() {
    var last = lastDuplicate;
    var group = inDocumentOrder(allSelected());
    var same = !!last && group.length === last.copies.length && group.every(function (el, i) {
      return el === last.copies[i];
    });
    if (!same) return null;
    var box = clipHeader(group[0]).box;
    var by = { x: box.x - last.from[0].x, y: box.y - last.from[0].y };
    return by.x || by.y ? by : null;
  }

  /**
   * ⌘D: duplicates the selection, offset so the copy shows; a copy made by ⌘D or Alt-drag and
   * moved since is copied on by as much again (see repeatOffset).
   */
  function duplicate() {
    if (!selected) return;
    var by = repeatOffset() || { x: DROP_CASCADE, y: DROP_CASCADE };
    duplicateSelected(by.x, by.y);
    commit();
  }

  /**
   * Pastes several copied elements, keeping how they lie to each other: where they were on the
   * slide they came from (a step away while an original still sits there), or with `at`, or
   * when they do not say where they were, centered on that point or where pastes go.
   */
  function pasteGroup(clip, at) {
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
    var inPlace = !at && clip.header.group.every(hasPlace);
    var corner = { x: left, y: top };
    if (!inPlace) {
      var point = at || pastePoint();
      var center = slidePoint(point.x, point.y);
      corner = { x: center.x - (right - left) / 2, y: center.y - (bottom - top) / 2 };
    }
    var els = clip.els.map(function (source) {
      return document.importNode(source, true);
    });
    restickCopies(els, idTaken);
    els.forEach(function (el, i) {
      slide.appendChild(el);
      placeFree(el, clip.header.group[i], { x: corner.x + num(boxes[i].x) - left, y: corner.y + num(boxes[i].y) - top });
    });
    // The group shifts as one when an original or a copy already sits at one of its spots.
    var beside = inPlace && els.some(function (el, i) {
      return originalInPlace(clip.header.group[i], el);
    });
    var shift = beside ? DROP_CASCADE : 0;
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
    saveNudges();
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
    saveNudges();
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
    saveNudges();
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
    return geometryOf(group.length > 1 ? boundsOf(group) : frameOf(group[0]), group.length, group.length > 1 ? null : angleOf(group[0]));
  }

  function geometryOf(box, count, rotation) {
    return {
      count: count,
      x: Math.round(box.left),
      y: Math.round(box.top),
      w: Math.round(box.right - box.left),
      h: Math.round(box.bottom - box.top),
      rotation: rotation,
    };
  }

  /**
   * The selection's geometry while it is dragged along: where it started (see setMoveGroup), moved
   * as far as the drag moved it, or the box several elements are resized to together (while they
   * are turned together, the box they started in), without measuring anything. Null when no such
   * drag is under way.
   */
  function movedGeometry() {
    if (drag && drag.multi && drag.members) return geometryOf(drag.shown || drag.box, drag.members.length, null);
    var from = drag && drag.mode === "move" && drag.by ? drag.frame : null;
    if (!from) return null;
    var box = { left: from.box.left + drag.by.x, top: from.box.top + drag.by.y, right: from.box.right + drag.by.x, bottom: from.box.bottom + drag.by.y };
    return geometryOf(box, from.count, from.rotation);
  }

  function reportGeometry() {
    geometryFrame = 0;
    var now = movedGeometry() || geometry();
    fillReadout(now);
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
    var offset = offsetOf(el);
    if (sizeMode === "resize") {
      var state = { el: el, size: size, scale: scale, offset: offset, zoom: zoom() };
      holdContents(state);
      resizeTo(state, sx, sy, shift);
    } else {
      scaleTo(el, sx, sy);
      moveTo(el, offset.x + shift.x, offset.y + shift.y);
    }
  }

  /** Applies typed numbers (see slop:edit-geometry in 00-header.js). */
  function setGeometry(data) {
    finishEditing();
    saveNudges();
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
    saveSoon(null);
  }

  /**
   * The lines to snap to on each axis (`x`, `y`): the slide's and other elements' edges and
   * centers, and those elements' boxes (`boxes`), which a move spaces evenly with (see snapGaps).
   */
  function snapTargets(moving) {
    var lines = { x: [], y: [], boxes: [] };
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
      if (box.right > box.left && box.bottom > box.top) {
        add(box.left, box.top, box.right, box.bottom);
        lines.boxes.push(box);
      }
      return false;
    });
    return lines;
  }

  /**
   * The nudge along an axis (`across` for left to right, else top to bottom) that spaces `box`
   * evenly with two of `others` level with it: halfway between two neighbours, or as far past
   * one as that one is from the next. Null when nothing like it is within `tolerance`; else
   * { by, marks }, the marks being the equal gaps, as { across, from, to, at } (`at` where on
   * the other axis they are drawn). All in slide pixels, from boxes measured when the move began.
   */
  function snapGaps(across, box, others, tolerance) {
    var start = across ? "left" : "top";
    var end = across ? "right" : "bottom";
    var lo = across ? "top" : "left";
    var hi = across ? "bottom" : "right";
    var size = box[end] - box[start];
    var row = others.filter(function (other) {
      return other[lo] < box[hi] && other[hi] > box[lo];
    }).sort(function (a, b) {
      return a[start] - b[start];
    });
    var best = null;
    var offer = function (at, a, b, gaps) {
      var by = at - box[start];
      if (Math.abs(by) > tolerance || (best && Math.abs(by) >= Math.abs(best.by))) return;
      // The marks go where all three are level, or failing that, by the middle of the moving box.
      var from = Math.max(box[lo], a[lo], b[lo]);
      var to = Math.min(box[hi], a[hi], b[hi]);
      var level = from < to ? (from + to) / 2 : (box[lo] + box[hi]) / 2;
      best = {
        by: by,
        marks: gaps(at).map(function (gap) {
          return { across: across, from: gap[0], to: gap[1], at: level };
        }),
      };
    };
    row.forEach(function (a, i) {
      row.slice(i + 1).forEach(function (b) {
        var gap = b[start] - a[end];
        // Two neighbours: nothing of the row lies between them.
        var apart = gap > 0 && !row.some(function (other) {
          return other !== a && other !== b && other[start] < b[start] && other[end] > a[end];
        });
        if (!apart) return;
        if (gap > size) {
          offer(a[end] + (gap - size) / 2, a, b, function (at) {
            return [[a[end], at], [at + size, b[start]]];
          });
        }
        offer(b[end] + gap, a, b, function (at) {
          return [[a[end], b[start]], [b[end], at]];
        });
        offer(a[start] - gap - size, a, b, function (at) {
          return [[at + size, a[start]], [a[end], b[start]]];
        });
      });
    });
    return best;
  }

  /**
   * What a moved box snaps to along one axis: the nearer of the line `edge` found (see snapAxis)
   * and the even spacing `gap` found (see snapGaps), with the guide lines and marks of whichever
   * hold where it ends up.
   */
  function nearerSnap(edge, gap) {
    if (!gap) return { by: edge.by, hits: edge.hits, marks: [] };
    var both = Math.abs(edge.by - gap.by) < 0.5;
    if (!edge.hits.length || Math.abs(gap.by) < Math.abs(edge.by)) return { by: gap.by, hits: both ? edge.hits : [], marks: gap.marks };
    return { by: edge.by, hits: edge.hits, marks: both ? gap.marks : [] };
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

  /**
   * Draws the guide lines a snap hit (`xs` upright, `ys` level), each reaching to `box`, and the
   * equal-spacing `marks` (see snapGaps), if any; nothing when they are drawn already.
   */
  function drawGuides(xs, ys, box, marks) {
    var at = camera();
    var thick = onScreen(1);
    var lines = [];
    var line = function (left, top, w, h, gap) {
      lines.push({ css: "left:" + left + "px;top:" + top + "px;width:" + w + "px;height:" + h + "px", gap: gap || "" });
    };
    xs.forEach(function (hit) {
      var from = Math.min(hit.from, box.top);
      line(at.left + hit.at * at.k, at.top + from * at.k, thick, (Math.max(hit.to, box.bottom) - from) * at.k);
    });
    ys.forEach(function (hit) {
      var from = Math.min(hit.from, box.left);
      line(at.left + from * at.k, at.top + hit.at * at.k, (Math.max(hit.to, box.right) - from) * at.k, thick);
    });
    var tick = onScreen(GAP_MARK);
    (marks || []).forEach(function (mark) {
      var from = (mark.across ? at.left : at.top) + mark.from * at.k;
      var level = (mark.across ? at.top : at.left) + mark.at * at.k - tick / 2;
      var length = (mark.to - mark.from) * at.k;
      if (mark.across) line(from, level, length, tick, "x");
      else line(level, from, tick, length, "y");
    });
    var key = lines.map(function (item) {
      return item.gap + item.css;
    }).join("|");
    if (key === drawnGuides) return;
    drawnGuides = key;
    var nodes = fitChildren(guides, lines.length, newDiv);
    lines.forEach(function (item, i) {
      nodes[i].style.cssText = item.css;
      if (item.gap) nodes[i].setAttribute("data-gap", item.gap);
      else if (nodes[i].hasAttribute("data-gap")) nodes[i].removeAttribute("data-gap");
    });
  }

  function clearGuides() {
    if (!drawnGuides) return;
    drawnGuides = "";
    fitChildren(guides, 0, newDiv);
  }

  function clearDragMarks() {
    clearGuides();
    readoutAt = null;
    readout.style.display = "none";
  }

  /**
   * Whether a drag snaps to the guides just now: as the toolbar's "Snap to guides" says, or with
   * ⌘ / Ctrl held, the opposite.
   */
  function snaps(event) {
    return snapping !== !!(event.metaKey || event.ctrlKey);
  }

  /** The (dx, dy) in slide pixels a move ends up with once its bounds snapped, with guide lines. */
  function snapMove(dx, dy, event) {
    var box = drag.box;
    if (!snaps(event) || box.right <= box.left || box.bottom <= box.top) {
      clearGuides();
      return { x: dx, y: dy };
    }
    var tolerance = onScreen(SNAP_PX) / drag.zoom;
    var moved = { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
    var sx = nearerSnap(
      snapAxis([moved.left, (moved.left + moved.right) / 2, moved.right], drag.targets.x, tolerance),
      snapGaps(true, moved, drag.targets.boxes, tolerance),
    );
    var sy = nearerSnap(
      snapAxis([moved.top, (moved.top + moved.bottom) / 2, moved.bottom], drag.targets.y, tolerance),
      snapGaps(false, moved, drag.targets.boxes, tolerance),
    );
    var x = dx + sx.by;
    var y = dy + sy.by;
    drawGuides(sx.hits, sy.hits, { left: box.left + x, top: box.top + y, right: box.right + x, bottom: box.bottom + y }, sx.marks.concat(sy.marks));
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
    if (!snaps(event) || keepsRatio(event) || drag.angle % 360 || box.right <= box.left || box.bottom <= box.top) {
      clearGuides();
      return { x: dx, y: dy };
    }
    var d = drag.dir;
    var z = drag.zoom;
    var tolerance = onScreen(SNAP_PX) / z;
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

  /** The first step of a move: what to put back if it is called off, and with Alt, a copy to drag in its place. */
  function startMove(event) {
    keepForCancel(drag, allSelected(), false);
    drag.copies = null;
    if (event.altKey) copyForMove(true);
    else setMoveGroup();
  }

  /**
   * Alt went down or up during a move: with it, the selection goes back where it was and a copy
   * of it is dragged on from there; without it, the copy goes and the selection itself is
   * dragged again.
   */
  function copyForMove(on) {
    if (on) {
      restoreKept(drag);
      drag.originals = allSelected();
      duplicateSelected(0, 0);
      drag.copies = allSelected();
    } else {
      drag.copies.forEach(function (copy) {
        if (copy.parentNode) copy.parentNode.removeChild(copy);
      });
      drag.copies = null;
      selectMany(drag.originals);
    }
    setMoveGroup();
  }

  /** What a move drags, resolved once for all its pointer moves: the selection, where it is, and what it snaps to. */
  function setMoveGroup() {
    drag.el = selected;
    var group = allSelected();
    drag.group = group.map(function (el) {
      return { el: el, from: offsetOf(el) };
    });
    drag.box = boundsOf(group);
    // What the readout and the app are told while it moves: this, moved along (see movedGeometry).
    drag.frame = {
      box: group.length > 1 ? drag.box : frameOf(group[0]),
      count: group.length,
      rotation: group.length > 1 ? null : angleOf(group[0]),
    };
    // A line dragged on its own lets go of what it is not dragged along with.
    var lines = group.filter(function (el) {
      ENDS.forEach(function (end) {
        var target = stuckTo(el, end);
        var along = target && group.some(function (other) {
          return other.contains(target);
        });
        if (!along) unstick(el, end);
      });
      return !!lineOf(el);
    });
    // The other lines stuck to the group follow it, so they are nothing to snap to.
    drag.followers = linesFollowing(group, lines);
    var stuck = drag.followers.filter(function (follower) {
      return follower.targets.some(function (target) {
        return target && group.some(function (el) {
          return el.contains(target);
        });
      });
    }).map(function (follower) {
      return follower.el;
    });
    keepForCancel(drag, drag.followers.map(function (follower) {
      return follower.el;
    }), true);
    drag.targets = snapTargets(group.concat(stuck));
  }

  function moveDrag(event, dx, dy) {
    if (!drag.group) startMove(event);
    else if (!!event.altKey !== !!drag.copies) copyForMove(!!event.altKey);
    drag.last = { x: event.clientX, y: event.clientY, dx: dx, dy: dy, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey };
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
    // How far the move went, as the translate rounds it to whole pixels.
    var first = drag.group[0];
    drag.by = { x: Math.round(first.from.x + by.x) - first.from.x, y: Math.round(first.from.y + by.y) - first.from.y };
    followStuck(drag.followers);
    showReadout(event);
  }

  // Alt pressed or let go in the middle of a move takes effect at once, wherever the pointer rests.
  ["keydown", "keyup"].forEach(function (type) {
    window.addEventListener(
      type,
      function (event) {
        var last = drag && drag.mode === "move" && drag.moved ? drag.last : null;
        if (event.key !== "Alt" || !last) return;
        moveDrag(
          { clientX: last.x, clientY: last.y, altKey: type === "keydown", shiftKey: last.shiftKey, metaKey: last.metaKey, ctrlKey: last.ctrlKey },
          last.dx,
          last.dy,
        );
      },
      true,
    );
  });

  /**
   * Shows the position and size (or turn) next to the pointer while dragging. It is filled in
   * with the geometry reported next frame (see fillReadout), so a pointer move measures nothing for it.
   */
  function showReadout(event) {
    if (drag.mode === "tilt" || drag.mode === "adjust") return;
    readoutAt = { x: event.clientX + onScreen(14), y: event.clientY + onScreen(18) };
    scheduleGeometry();
  }

  /** Fills in the drag's readout, when one shows, with the selection's geometry `now`. */
  function fillReadout(now) {
    if (!readoutAt || !drag || !now) return;
    readout.textContent =
      drag.mode === "rotate" ? (drag.multi ? drag.turned || 0 : now.rotation) + "°"
      : drag.mode === "point" ? "X " + drag.at.x + "  Y " + drag.at.y
      : "X " + now.x + "  Y " + now.y + "  W " + now.w + "  H " + now.h;
    readout.style.cssText = "left:" + readoutAt.x + "px;top:" + readoutAt.y + "px";
  }

  /**
   * The box a shape or text box being dragged out with a tool takes, in slide pixels, from the
   * press (`create.at`) to the slide point `at`: Shift makes it as wide as tall, Alt draws it out
   * from its center, and the corner being dragged snaps to the guides as a resize does (not with
   * Shift), which shows them, with its place and size by the pointer. What it snaps to is
   * measured once, on the first move, before the new element is there.
   */
  function createBox(event, at) {
    var from = create.at;
    var corner = { x: at.x, y: at.y };
    var hits = { x: [], y: [] };
    if (snaps(event) && !event.shiftKey) {
      if (!create.targets) create.targets = snapTargets([]);
      var tolerance = onScreen(SNAP_PX) / zoom();
      var sx = snapAxis([corner.x], create.targets.x, tolerance);
      var sy = snapAxis([corner.y], create.targets.y, tolerance);
      corner = { x: corner.x + sx.by, y: corner.y + sy.by };
      hits = { x: sx.hits, y: sy.hits };
    }
    var reach = event.altKey ? 2 : 1;
    var w = Math.round(Math.abs(corner.x - from.x) * reach);
    var h = Math.round(Math.abs(corner.y - from.y) * reach);
    if (event.shiftKey) w = h = Math.max(w, h);
    var x = event.altKey ? Math.round(from.x - w / 2) : corner.x < from.x ? from.x - w : from.x;
    var y = event.altKey ? Math.round(from.y - h / 2) : corner.y < from.y ? from.y - h : from.y;
    if (hits.x.length || hits.y.length) drawGuides(hits.x, hits.y, { left: x, top: y, right: x + w, bottom: y + h });
    else clearGuides();
    // A text box's height follows its text; only its width is dragged out.
    showCreateReadout(event, "X " + x + "  Y " + y + "  W " + w + (create.tool === "text" ? "" : "  H " + h));
    return { x: x, y: y, w: w, h: h };
  }

  /** Shows a line's length and angle (counterclockwise from pointing right) by the pointer while it is drawn from `from` to `to`. */
  function lineReadout(event, from, to) {
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var angle = Math.round((-Math.atan2(dy, dx) * 180) / Math.PI);
    showCreateReadout(event, "L " + Math.round(Math.hypot(dx, dy)) + "  " + (angle < 0 ? angle + 360 : angle) + "°");
  }

  // What the readout says while an element is added, until its next frame writes it.
  var createText = "";
  var createFrame = 0;

  /** Puts `text` in the readout by the pointer next frame, however many pointer moves come before it. */
  function showCreateReadout(event, text) {
    readoutAt = { x: event.clientX + onScreen(14), y: event.clientY + onScreen(18) };
    createText = text;
    if (createFrame) return;
    createFrame = window.requestAnimationFrame(function () {
      createFrame = 0;
      if (!create || !readoutAt) return;
      readout.textContent = createText;
      readout.style.cssText = "left:" + readoutAt.x + "px;top:" + readoutAt.y + "px";
    });
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

