  // ---- Handle drags: resizing, rotating and tilting, the slots in-flow elements leave, stretching
  // drawings and their paths, and the overflow wires.

  ui.addEventListener("pointerdown", function (event) {
    var kind = event.target.getAttribute && event.target.getAttribute("data-handle");
    if (event.button !== 0 || !kind || !selected || isLocked(selected)) return;
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
      spread: spreadOf(selected),
      zoom: zoom(),
      dir: { x: dir[0], y: dir[1] },
      resize: sizeMode === "resize",
      vectors: sizeMode === "resize" && selected.getAttribute(ADDED) === "drawing" ? vectorShapes(selected) : null,
      // A group's resize spreads what it holds.
      members: sizeMode === "resize" && isGroup(selected) ? memberBoxes(selected) : null,
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
    else if (kind === "adjust") {
      selected.removeAttribute(ADJUST_ATTR);
      paintFigure(selected, figurePaint(selected));
      placeHandles();
    } else scaleTo(selected, 1, 1);
    commit();
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

  /** Applies a handle drag to the pointer at `event`. */
  function transformTo(event) {
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
    if (drag.members && w && h) spreadMembers(drag.members, nw / w, nh / h);
    fitFigure(el);
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
    var hits = overflow.find(slide);
    drawOverflow(hits);
    var items = hits.map(overflow.describe);
    var key = JSON.stringify(items);
    if (key === reportedOverflow) return;
    reportedOverflow = key;
    window.parent.postMessage({ type: "slop:edit-overflow", slide: slide.id, items: items }, "*");
  }

  /** Re-checks for overflow once per frame, however many changes came in. */
  function scheduleOverflow() {
    if (!overflowFrame) overflowFrame = window.requestAnimationFrame(refreshOverflow);
  }

