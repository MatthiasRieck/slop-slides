  // ---- Handle drags: resizing, rotating and tilting, one element or several together, the slots
  // in-flow elements leave, stretching drawings and their paths, and the overflow wires.

  // Several elements resized together get no smaller than this share of the box they started in.
  var MIN_GROUP_SCALE = 0.02;

  ui.addEventListener("pointerdown", function (event) {
    var kind = event.target.getAttribute && event.target.getAttribute("data-handle");
    if (event.target.hasAttribute && event.target.hasAttribute("data-lock-mark")) {
      // Not a press on the slide: the click unlocks (see below), and nothing is picked or dragged.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.button !== 0 || !kind || !selected || !movable().length) return;
    event.preventDefault();
    event.stopPropagation();
    saveNudges();
    var dir = (event.target.getAttribute("data-dir") || "0 0").split(" ").map(Number);
    if (extras.length) {
      // Several elements: what each starts from is read on the first move (see holdMembers).
      drag = {
        mode: kind,
        multi: true,
        el: selected,
        start: { x: event.clientX, y: event.clientY },
        angle: 0,
        zoom: zoom(),
        dir: { x: dir[0], y: dir[1] },
        resize: sizeMode === "resize",
        moved: false,
      };
    } else {
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
        spread: spreadOf(selected),
        zoom: zoom(),
        dir: { x: dir[0], y: dir[1] },
        resize: sizeMode === "resize",
        moved: false,
      };
      if (drag.resize) holdContents(drag);
    }
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
    if (kind === "tilt") tiltTo(selected, 0, 0);
    else if (kind === "adjust") {
      selected.removeAttribute(ADJUST_ATTR);
      paintFigure(selected, figurePaint(selected));
      scheduleHandles();
    } else {
      // Each of several selected elements goes back upright, or to its own size, where it is.
      movable().forEach(function (el) {
        if (kind === "rotate") rotateTo(el, 0);
        else scaleTo(el, 1, 1);
      });
    }
    commit();
  });
  ui.addEventListener("click", function (event) {
    if (!event.target.hasAttribute || !event.target.hasAttribute("data-lock-mark")) return;
    event.stopPropagation();
    lockElements(allSelected(), false);
  });

  /** Turns the screen vector (x, y) by `degrees`. */
  function turn(x, y, degrees) {
    var a = (degrees * Math.PI) / 180;
    return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
  }

  /** Whether a resize keeps the aspect ratio: with Shift, or with the ratio locked, without it. */
  function keepsRatio(event) {
    return !!event.shiftKey !== keepRatio;
  }

  /**
   * The first move of a handle drag: the lines stuck to what it changes, which go with it, and
   * what to put back if it is called off; for several elements, what each starts from.
   */
  function startTransform() {
    var els = drag.multi ? movable() : [drag.el];
    drag.followers = linesFollowing(els, els);
    var lines = drag.followers.map(function (follower) {
      return follower.el;
    });
    keepForCancel(drag, els.concat(lines), true);
    if (drag.multi) holdMembers(els, lines);
  }

  /**
   * What a resize or a turn of several elements together starts from, read once for all its
   * pointer moves: the box around them (in slide pixels) and its middle on screen, each one's
   * place, size and turn, and what the box's sides snap to.
   */
  function holdMembers(els, lines) {
    var at = camera();
    var box = boundsOf(els);
    drag.box = box;
    drag.center = { x: at.left + ((box.left + box.right) / 2) * at.k, y: at.top + ((box.top + box.bottom) / 2) * at.k };
    drag.members = els.map(function (el) {
      var frame = frameOf(el);
      var member = {
        el: el,
        at: { x: (frame.left + frame.right) / 2, y: (frame.top + frame.bottom) / 2 },
        angle: angleOf(el),
        scale: scaleOf(el),
        offset: offsetOf(el),
        size: sizeOf(el),
        zoom: drag.zoom,
      };
      if (drag.resize && drag.mode === "scale") holdContents(member);
      return member;
    });
    drag.targets = snapTargets(els.concat(lines));
  }

  /**
   * Resizes several elements together: the box around them follows the dragged handle while its
   * opposite side stays put (or with `fromCenter`, its middle), and each element keeps its place
   * and its share of the box. `keepRatio` scales both ways alike. A turned element takes on
   * what the stretch makes of its own width and height.
   */
  function stretchGroup(dx, dy, keepRatio, fromCenter) {
    var d = drag.dir;
    var box = drag.box;
    var w = box.right - box.left;
    var h = box.bottom - box.top;
    var reach = fromCenter ? 2 : 1;
    var kx = d.x && w ? (w + (reach * d.x * dx) / drag.zoom) / w : 1;
    var ky = d.y && h ? (h + (reach * d.y * dy) / drag.zoom) / h : 1;
    if (keepRatio) kx = ky = !d.x ? ky : !d.y ? kx : Math.abs(kx - 1) > Math.abs(ky - 1) ? kx : ky;
    kx = Math.max(MIN_GROUP_SCALE, kx);
    ky = Math.max(MIN_GROUP_SCALE, ky);
    // What stays put: the side opposite the handle, or the middle.
    var ax = fromCenter || !d.x ? (box.left + box.right) / 2 : d.x > 0 ? box.left : box.right;
    var ay = fromCenter || !d.y ? (box.top + box.bottom) / 2 : d.y > 0 ? box.top : box.bottom;
    drag.members.forEach(function (m) {
      var a = (m.angle * Math.PI) / 180;
      var cos = Math.cos(a);
      var sin = Math.sin(a);
      var fw = Math.sqrt(kx * kx * cos * cos + ky * ky * sin * sin);
      var fh = Math.sqrt(kx * kx * sin * sin + ky * ky * cos * cos);
      var shift = { x: (m.at.x - ax) * (kx - 1), y: (m.at.y - ay) * (ky - 1) };
      if (drag.resize) {
        resizeTo(m, m.scale.x * fw, m.scale.y * fh, shift);
        return;
      }
      scaleTo(m.el, m.scale.x * fw, m.scale.y * fh);
      moveTo(m.el, m.offset.x + shift.x, m.offset.y + shift.y);
    });
    // The box they are in now, for the readout and the app (see movedGeometry).
    drag.shown = {
      left: ax + (box.left - ax) * kx,
      top: ay + (box.top - ay) * ky,
      right: ax + (box.right - ax) * kx,
      bottom: ay + (box.bottom - ay) * ky,
    };
  }

  /** Turns several elements together around the middle of the box around them, each by as much. */
  function turnGroup(event) {
    var c = drag.center;
    var start = Math.atan2(drag.start.y - c.y, drag.start.x - c.x);
    var degrees = ((Math.atan2(event.clientY - c.y, event.clientX - c.x) - start) * 180) / Math.PI;
    var by = wrapAngle(event.shiftKey ? Math.round(degrees / ROTATE_SNAP) * ROTATE_SNAP : degrees);
    var box = drag.box;
    var mid = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    drag.members.forEach(function (m) {
      var to = turn(m.at.x - mid.x, m.at.y - mid.y, by);
      moveTo(m.el, m.offset.x + mid.x + to.x - m.at.x, m.offset.y + mid.y + to.y - m.at.y);
      rotateTo(m.el, m.angle + by);
    });
    drag.turned = by;
  }

  /** Applies a handle drag to the pointer at `event`. */
  function transformTo(event) {
    if (drag.multi) {
      if (drag.mode === "rotate") {
        turnGroup(event);
        return;
      }
      var grown = snapResize(event);
      stretchGroup(grown.x, grown.y, keepsRatio(event), event.altKey);
      return;
    }
    if (drag.mode === "adjust") {
      adjustTo(event);
      return;
    }
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
    stretchTo(to.x, to.y, keepsRatio(event), event.altKey);
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
    var hx = (d.x * w * s0.x) / 2 + moved.x * drag.spread.x;
    var hy = (d.y * h * s0.y) / 2 + moved.y * drag.spread.y;
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
    var shift = turn(cx / drag.spread.x, cy / drag.spread.y, drag.angle);
    if (drag.resize) {
      resizeTo(drag, sx, sy, shift);
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
      ["id", MOVED, ADDED, DROPPED].concat(EDITOR_ATTRS, STUCK_ATTRS).forEach(function (name) { node.removeAttribute(name); });
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
  function reserveLayout(el, k) {
    var computed = getComputedStyle(el);
    if (/^(absolute|fixed)$/.test(computed.position) || placeholderOf(el)) return;
    var size = sizeOf(el);
    var center = centerOf(el);
    el.parentElement.insertBefore(slotFor(el, PLACEHOLDER), el.nextSibling);
    var pad = boxPadding(computed);
    el.style.position = "absolute";
    el.style.margin = "0px";
    el.style.left = el.style.top = "0px";
    el.style.right = el.style.bottom = "auto";
    el.style.width = Math.max(0, size.w - pad.x) + "px";
    el.style.height = Math.max(0, size.h - pad.y) + "px";
    // Locate it in its existing containing block, preserving its rotation, scale and translate.
    var placed = centerOf(el);
    el.style.left = (center.x - placed.x) / k + "px";
    el.style.top = (center.y - placed.y) / k + "px";
  }

  /** How much of a box with this computed style its `width` and `height` leave out: its padding and borders, unless they count in. */
  function boxPadding(computed) {
    if (computed.boxSizing === "border-box") return { x: 0, y: 0 };
    var px = function (name) { return parseFloat(computed[name]) || 0; };
    return {
      x: px("paddingLeft") + px("paddingRight") + px("borderLeftWidth") + px("borderRightWidth"),
      y: px("paddingTop") + px("paddingBottom") + px("borderTopWidth") + px("borderBottomWidth"),
    };
  }

  /**
   * Adds to `state` (what a resize starts from: its `el` and `size`) what the element holds that
   * a resize spreads with its box: a drawing's shapes, a group's members.
   */
  function holdContents(state) {
    var el = state.el;
    state.vectors = el.getAttribute(ADDED) === "drawing" ? vectorShapes(el, state.size) : null;
    state.members = isGroup(el) ? memberBoxes(el) : null;
  }

  /**
   * Changes the border box of `state.el` without scaling its contents or discarding an existing
   * scale. `state` is what the resize started from: the element's `size`, `scale`, `offset` and
   * the `zoom`, with its contents (see holdContents). The first step takes the element out of
   * the layout, reads what every step needs and writes what none of them changes (in between
   * the rest, so the styles keep their order); after it a step only writes the size.
   */
  function resizeTo(state, sx, sy, shift) {
    var el = state.el;
    var first = !state.sizing;
    if (first) {
      reserveLayout(el, state.zoom);
      var computed = getComputedStyle(el);
      state.sizing = {
        // A box that grows with its text keeps the height as its least.
        grows: el.getAttribute("data-autofit") === "grow",
        contentBox: computed.boxSizing !== "border-box",
        pad: boxPadding(computed),
        inline: computed.display === "inline",
        nowrap: computed.whiteSpace === "nowrap",
        figure: null,
      };
    }
    var sizing = state.sizing;
    // A figure's padding goes by its size: where it is not part of the box, each step counts the latest.
    if (sizing.figure && sizing.contentBox) sizing.pad = boxPadding(getComputedStyle(el));
    var w = state.size.w;
    var h = state.size.h;
    var nw = Math.max(1, Math.round(w * sx / state.scale.x * 1000) / 1000);
    var nh = Math.max(1, Math.round(h * sy / state.scale.y * 1000) / 1000);
    var height = Math.max(0, nh - sizing.pad.y) + "px";
    el.style.width = Math.max(0, nw - sizing.pad.x) + "px";
    if (first) el.style.minWidth = "0px";
    if (sizing.grows) {
      if (first) el.style.height = "auto";
      el.style.minHeight = height;
    } else {
      el.style.height = height;
      if (first) el.style.minHeight = "0px";
    }
    if (first) {
      el.style.maxWidth = "none";
      el.style.maxHeight = "none";
      el.style.flexShrink = "0";
      el.style.flexBasis = "auto";
      if (sizing.inline) el.style.display = "inline-block";
      if (sizing.nowrap) el.style.whiteSpace = "normal";
    }
    if (state.vectors && w && h) spreadVectors(state.vectors, nw / w, nh / h);
    if (state.members && w && h) spreadMembers(state.members, nw / w, nh / h);
    if (first) sizing.figure = resizedPaint(el);
    if (sizing.figure) fitFigureWith(el, sizing.figure);
    // Layout grows from the top left; translate compensates to keep the opposite handle fixed.
    moveTo(el, state.offset.x + shift.x - (nw - w) / 2, state.offset.y + shift.y - (nh - h) / 2);
  }

  /** The element's viewBox as [x, y, w, h], or null without a usable one. */
  function viewBoxOf(el) {
    var box = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(parseFloat);
    return box.length === 4 && box.every(isFinite) && box[2] > 0 && box[3] > 0 ? box : null;
  }

  /** A drawing's viewBox (or without one, its `size`) and its shapes' geometry, as they were when the stretch started. */
  function vectorShapes(el, size) {
    var vectors = vectorsOf(el);
    return {
      el: el,
      viewBox: viewBoxOf(el) || [0, 0, size.w, size.h],
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
    var box = shapes.viewBox;
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
    // A line's curve and heads are redrawn through its spread points, not spread with them.
    var line = lineOf(shapes.el);
    if (line) drawLineShape(shapes.el, line.path, lineShape(line.points, line.heads, line.width, line.route, null), 0, 0);
  }

  function roundTenth(n) {
    return Math.round(n * 10) / 10;
  }

  var NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
  // What each parameter of a path command is: X / Y a point's coordinate, x / y a length
  // along that axis, - anything else (an angle or a flag).
  var PATH_PARAMS = { M: "XY", L: "XY", T: "XY", C: "XY", S: "XY", Q: "XY", H: "X", V: "Y", A: "xy---XY", Z: "" };
  // A line's stroke (see "Lines"): straight, through points, curved, or an elbow connector's
  // straight stretches; earlier versions put an arrow's head in it too, as a last `M L L`.
  var PATH_POINT = "\\s*" + NUMBER.source + "[\\s,]+" + NUMBER.source + "\\s*";
  var LINE_PATH = new RegExp(
    "^\\s*(M" + PATH_POINT + "(?:(?:L" + PATH_POINT + ")+|(?:C" + PATH_POINT + PATH_POINT + PATH_POINT + ")+))" +
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

  /** Draws a wire around each element that overflows, where its box (kept in slide pixels) shows in the window now. */
  function drawOverflow() {
    var at = camera();
    var nodes = fitChildren(wires, overflowBoxes.length, function () {
      var wire = newDiv();
      wire.setAttribute("data-wire", "");
      return wire;
    });
    overflowBoxes.forEach(function (box, i) {
      var left = Math.max(at.left + box.left * at.k, 0);
      var top = Math.max(at.top + box.top * at.k, 0);
      var right = Math.min(at.left + box.right * at.k, window.innerWidth);
      var bottom = Math.min(at.top + box.bottom * at.k, window.innerHeight);
      nodes[i].style.cssText = "left:" + left + "px;top:" + top + "px;width:" + Math.max(0, right - left) + "px;height:" + Math.max(0, bottom - top) + "px";
    });
  }

  function refreshOverflow() {
    overflowFrame = 0;
    var hits = overflow.find(slide);
    var at = camera();
    overflowBoxes = hits.map(function (hit) {
      return {
        left: (hit.rect.left - at.left) / at.k,
        top: (hit.rect.top - at.top) / at.k,
        right: (hit.rect.right - at.left) / at.k,
        bottom: (hit.rect.bottom - at.top) / at.k,
      };
    });
    drawOverflow();
    var items = hits.map(overflow.describe);
    // Where each one is, so the app's list of them can select it (see { type: "slop:edit-select" }).
    var paths = hits.map(function (hit) {
      return pathOf(hit.el);
    });
    var key = JSON.stringify([items, paths]);
    if (key === reportedOverflow) return;
    reportedOverflow = key;
    tellApp({ type: "slop:edit-overflow", slide: slide.id, items: items, paths: paths });
  }

  /** Whether a drag, adding an element with a tool, or a marquee is under way: the pointer is down and has moved. */
  function gesturing() {
    return !!(drag && drag.moved) || !!(create && create.moved) || !!(marquee && marquee.moved);
  }

  /**
   * Re-checks what overflows and the slide's layers, which means measuring every element on the
   * slide: next frame, or while typing, once the typing pauses, so keystrokes do not wait for it,
   * or during a drag (or adding an element, or a marquee) once it ends, so pointer moves do not.
   */
  function scheduleSlideChecks() {
    clearTimeout(slideChecksTimer);
    slideChecksTimer = null;
    if (gesturing()) slideChecksDue = true;
    else if (editing) slideChecksTimer = setTimeout(typingPaused, TYPING_PAUSE_MS);
    else checkSlide();
  }

  /** The drag (or what else held the slide's checks back) ended: they run now if anything asked for them. */
  function resumeSlideChecks() {
    if (!slideChecksDue || gesturing()) return;
    slideChecksDue = false;
    scheduleSlideChecks();
  }

  /** The typing paused: a box that shrinks its text to fit is fitted to what was typed, and the slide checked. */
  function typingPaused() {
    if (refitDue && editing) {
      refitDue = false;
      refit(editing);
      layHandles();
    }
    checkSlide();
  }

  function checkSlide() {
    slideChecksTimer = null;
    scheduleOverflow();
    scheduleLayers();
  }

  /** Re-checks for overflow once per frame, however many changes came in. */
  function scheduleOverflow() {
    if (!overflowFrame) overflowFrame = window.requestAnimationFrame(refreshOverflow);
  }

