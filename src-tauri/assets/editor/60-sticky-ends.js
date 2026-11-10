  // ---- Sticky ends: a line's end dropped on an element goes wherever that element goes.

  /** The end of a line at point `index` of `count`, or null for a point in between. */
  function endAt(index, count) {
    return index === 0 ? ENDS[0] : index === count - 1 ? ENDS[1] : null;
  }

  /** What `line`'s `end` is stuck to on this slide (a copied slide may repeat ids), or null. */
  function stuckTo(line, end) {
    var id = line.getAttribute(end.attr);
    var target = id ? Array.prototype.find.call(slide.querySelectorAll("[id]"), function (el) {
      return el.id === id;
    }) : null;
    return target && !target.contains(line) ? target : null;
  }

  function unstick(line, end) {
    line.removeAttribute(end.attr);
    line.removeAttribute(end.at);
  }

  /** `el`'s box before it is turned, as its center, size and turn, in slide pixels. */
  function anchorFrame(el) {
    var frame = frameOf(el);
    return {
      x: (frame.left + frame.right) / 2,
      y: (frame.top + frame.bottom) / 2,
      w: frame.right - frame.left,
      h: frame.bottom - frame.top,
      angle: angleOf(el),
    };
  }

  /** The spot `at` ([x, y] as fractions of its box, in its turned frame) on `el`, in slide pixels. */
  function anchorPoint(el, at) {
    var f = anchorFrame(el);
    var off = turn((at[0] - 0.5) * f.w, (at[1] - 0.5) * f.h, f.angle);
    return [roundTenth(f.x + off.x), roundTenth(f.y + off.y)];
  }

  /** Where slide point `p` lies on `el`'s box, as fractions of it, kept on the box. */
  function anchorOf(el, p) {
    var f = anchorFrame(el);
    var local = turn(p.x - f.x, p.y - f.y, -f.angle);
    var keep = function (n) {
      return Math.min(1, Math.max(0, n));
    };
    return [keep(local.x / f.w + 0.5), keep(local.y / f.h + 0.5)];
  }

  /** "25% 100%" (or "25% 100% edge") as fractions and whether it is on the edge; the box's center when it says nothing usable. */
  function parseAnchor(value) {
    var words = String(value || "").trim().split(/\s+/);
    var edge = words.length === 3 && words[2] === "edge";
    var parts = words.slice(0, edge ? 2 : 3).map(function (part) {
      return /^-?[\d.]+%$/.test(part) ? parseFloat(part) / 100 : NaN;
    });
    return parts.length === 2 && parts.every(isFinite) ? { at: parts, edge: edge } : { at: [0.5, 0.5], edge: false };
  }

  function formatAnchor(at, edge) {
    return at.map(function (n) {
      return Math.round(n * 10000) / 100 + "%";
    }).join(" ") + (edge ? " edge" : "");
  }

  // Spots along each quarter of a rounded corner or ellipse, and the most along an SVG shape.
  var ARC_SAMPLES = 12;
  var VECTOR_SAMPLES = 240;
  // Screen pixels from an element's outline within which an end sticks to its edge.
  var EDGE_PX = 10;

  /**
   * `el`'s outline as rings of [x, y] fractions of its box before it is turned: each closed
   * (an area) or open (a stroke of a drawing). Its `clip-path`, else its SVG shapes, else its
   * box with its rounded corners.
   */
  function outlineOf(el) {
    var size = sizeOf(el);
    var w = size.w || 1;
    var h = size.h || 1;
    return figureOutline(el) || clipOutline(el, w, h) || vectorOutline(el) || cornerOutline(el, w, h);
  }

  /** A figure's outline (see FIGURES), mirrored as it is drawn; null for anything else. */
  function figureOutline(el) {
    var kind = figureOf(el);
    if (!kind) return null;
    var paint = figurePaint(el);
    var size = figureSize(el);
    var parts = FIGURES[kind].path(size.w, size.h, adjustOf(el)).match(/[MLQCZ]|-?[\d.]+/g);
    var ring = [];
    var at = [0, 0];
    var command = null;
    var num = function (n) {
      return parseFloat(parts[i + n]);
    };
    for (var i = 0; i < parts.length; ) {
      if (/^[MLQCZ]$/.test(parts[i])) command = parts[i++];
      if (command === "Z") break;
      if (command === "Q" || command === "C") {
        var controls = command === "Q" ? [[num(0), num(1)]] : [[num(0), num(1)], [num(2), num(3)]];
        var to = command === "Q" ? [num(2), num(3)] : [num(4), num(5)];
        var all = [at].concat(controls, [to]);
        i += command === "Q" ? 4 : 6;
        for (var k = 1; k <= ARC_SAMPLES; k++) {
          ring.push(command === "C" ? curveAt(all, k / ARC_SAMPLES) : quadAt(all, k / ARC_SAMPLES));
        }
        at = to;
      } else {
        at = [num(0), num(1)];
        i += 2;
        ring.push(at);
      }
    }
    return [{
      closed: true,
      points: ring.map(function (p) {
        var x = p[0] / size.w;
        var y = p[1] / size.h;
        return [paint.flipX ? 1 - x : x, paint.flipY ? 1 - y : y];
      }),
    }];
  }

  /** The spot `t` of the way along a quadratic Bézier [from, control, to]. */
  function quadAt(q, t) {
    var u = 1 - t;
    return [u * u * q[0][0] + 2 * u * t * q[1][0] + t * t * q[2][0], u * u * q[0][1] + 2 * u * t * q[1][1] + t * t * q[2][1]];
  }

  /** A CSS length ("12px", "25%" of `base`), or NaN. */
  function cssLength(value, base) {
    var m = String(value || "").trim().match(/^(-?[\d.]+)(px|%)?$/);
    if (!m) return NaN;
    var n = parseFloat(m[1]);
    return m[2] === "%" ? (n / 100) * base : m[2] === "px" || n === 0 ? n : NaN;
  }

  /** Spots around the ellipse at (cx, cy) with radii (rx, ry), in fractions of a w × h box. */
  function ellipseRing(cx, cy, rx, ry, w, h) {
    var ring = [];
    for (var i = 0; i < ARC_SAMPLES * 4; i++) {
      var a = (i / (ARC_SAMPLES * 4)) * 2 * Math.PI;
      ring.push([(cx + rx * Math.cos(a)) / w, (cy + ry * Math.sin(a)) / h]);
    }
    return ring;
  }

  /** The outline a `clip-path` polygon(), circle(), ellipse() or inset() cuts; null for none or what it cannot read. */
  function clipOutline(el, w, h) {
    var clip = (el.style.getPropertyValue("clip-path") || getComputedStyle(el).getPropertyValue("clip-path") || "").trim();
    var m = clip.match(/^(polygon|circle|ellipse|inset)\((.*)\)/);
    if (!m) return null;
    var args = m[2].trim();
    var ring = null;
    if (m[1] === "polygon") {
      ring = args.replace(/^(nonzero|evenodd)\s*,/, "").split(",").map(function (pair) {
        var xy = pair.trim().split(/\s+/);
        return [cssLength(xy[0], w) / w, cssLength(xy[1], h) / h];
      });
      if (ring.length < 3) return null;
    } else if (m[1] === "inset") {
      var sides = args.split(/\s+round\s+/)[0].trim().split(/\s+/);
      // One to four values, as for margins: top, right, bottom, left.
      var side = function (i) {
        return sides[i] || sides[i === 3 ? 1 : 0] || sides[0];
      };
      var t = cssLength(side(0), h);
      var r = cssLength(side(1), w);
      var b = cssLength(side(2), h);
      var l = cssLength(side(3), w);
      ring = [[l / w, t / h], [1 - r / w, t / h], [1 - r / w, 1 - b / h], [l / w, 1 - b / h]];
    } else {
      var parts = args.split(/\s+at\s+/);
      var center = (parts[1] || "50% 50%").trim().split(/\s+/);
      var cx = cssLength(center[0], w);
      var cy = cssLength(center[1] || "50%", h);
      var radii = parts[0].trim() ? parts[0].trim().split(/\s+/) : [];
      var radius = function (value, base, near, far) {
        return !value || value === "closest-side" ? near : value === "farthest-side" ? far : cssLength(value, base);
      };
      var rx;
      var ry;
      if (m[1] === "circle") {
        var near = Math.min(cx, cy, w - cx, h - cy);
        var far = Math.max(cx, cy, w - cx, h - cy);
        rx = ry = radius(radii[0], Math.sqrt((w * w + h * h) / 2), near, far);
      } else {
        rx = radius(radii[0], w, Math.min(cx, w - cx), Math.max(cx, w - cx));
        ry = radius(radii[1], h, Math.min(cy, h - cy), Math.max(cy, h - cy));
      }
      if (!(rx > 0 && ry > 0)) return null;
      ring = ellipseRing(cx, cy, rx, ry, w, h);
    }
    var ok = ring.every(function (p) {
      return isFinite(p[0]) && isFinite(p[1]);
    });
    return ok ? [{ points: ring, closed: true }] : null;
  }

  /**
   * The corners of an SVG path made only of straight stretches (M, L, H, V, Z), as rings of
   * [x, y] closed or not; null when it curves.
   */
  function straightPath(d) {
    var parts = String(d || "").match(/[a-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
    var rings = [];
    var ring = null;
    var x = 0;
    var y = 0;
    var command = null;
    for (var i = 0; i < parts.length; ) {
      if (/^[a-z]$/i.test(parts[i])) command = parts[i++];
      if (!command || !/^[mlhvz]$/i.test(command)) return null;
      var relative = command === command.toLowerCase();
      var c = command.toUpperCase();
      if (c === "Z") {
        if (ring) {
          ring.closed = true;
          x = ring.points[0][0];
          y = ring.points[0][1];
        }
        ring = null;
        continue;
      }
      var a = parseFloat(parts[i++]);
      var b = c === "H" || c === "V" ? 0 : parseFloat(parts[i++]);
      if (!isFinite(a) || !isFinite(b)) return null;
      if (c === "H") x = relative ? x + a : a;
      else if (c === "V") y = relative ? y + a : a;
      else {
        x = relative ? x + a : a;
        y = relative ? y + b : b;
      }
      if (c === "M" || !ring) {
        ring = { points: [], closed: false };
        rings.push(ring);
        // After an M, more pairs are lines.
        if (c === "M") command = relative ? "l" : "L";
      }
      ring.points.push([x, y]);
    }
    return rings;
  }

  /** The rings an SVG shape outlines, in its own user space; null when it cannot tell. */
  function shapeRings(shape) {
    var tag = shape.tagName.toLowerCase();
    var n = function (name) {
      return parseFloat(shape.getAttribute(name)) || 0;
    };
    if (tag === "rect") {
      var x = n("x");
      var y = n("y");
      return n("width") > 0 && n("height") > 0
        ? [{ points: [[x, y], [x + n("width"), y], [x + n("width"), y + n("height")], [x, y + n("height")]], closed: true }]
        : null;
    }
    if (tag === "circle" || tag === "ellipse") {
      var rx = tag === "circle" ? n("r") : n("rx");
      var ry = tag === "circle" ? n("r") : n("ry");
      return rx > 0 && ry > 0 ? [{ points: ellipseRing(n("cx"), n("cy"), rx, ry, 1, 1), closed: true }] : null;
    }
    if (tag === "line") return [{ points: [[n("x1"), n("y1")], [n("x2"), n("y2")]], closed: false }];
    if (tag === "polygon" || tag === "polyline") {
      var numbers = (shape.getAttribute("points") || "").match(NUMBER) || [];
      var points = [];
      for (var i = 0; i + 1 < numbers.length; i += 2) points.push([parseFloat(numbers[i]), parseFloat(numbers[i + 1])]);
      return points.length > 1 ? [{ points: points, closed: tag === "polygon" }] : null;
    }
    var straight = straightPath(shape.getAttribute("d"));
    if (straight) return straight;
    // A curve: followed along its length.
    if (typeof shape.getTotalLength !== "function" || typeof shape.getPointAtLength !== "function") return null;
    var length;
    try {
      length = shape.getTotalLength();
    } catch (e) {
      return null;
    }
    if (!(length > 0)) return null;
    var count = Math.min(VECTOR_SAMPLES, Math.max(ARC_SAMPLES, Math.ceil(length / 4)));
    var ring = [];
    for (var k = 0; k <= count; k++) {
      var p = shape.getPointAtLength((k / count) * length);
      ring.push([p.x, p.y]);
    }
    return [{ points: ring, closed: /z\s*$/i.test(shape.getAttribute("d") || "") }];
  }

  /** The outline of an SVG's shapes, as fractions of its viewBox; null when it has none to follow. */
  function vectorOutline(el) {
    if (el.namespaceURI !== SVG_NS) return null;
    var box = viewBoxOf(el);
    if (!box) {
      var size = sizeOf(el);
      box = [0, 0, size.w || 1, size.h || 1];
    }
    var rings = [];
    Array.prototype.forEach.call(el.querySelectorAll("path, line, polyline, polygon, rect, circle, ellipse"), function (shape) {
      var own = shapeRings(shape);
      if (!own) return;
      // Its own transforms and those of the groups it is in, up to the SVG.
      var matrices = [];
      for (var node = shape; node && node !== el; node = node.parentNode) {
        var list = node.transform && node.transform.baseVal;
        var matrix = list && list.numberOfItems ? list.consolidate().matrix : null;
        if (matrix) matrices.push(matrix);
      }
      // A filled shape is an area, even when its outline is left open.
      var fill = shape.getAttribute("fill") || getComputedStyle(shape).getPropertyValue("fill");
      var filled = !!fill && fill !== "none" && shape.tagName.toLowerCase() !== "line";
      own.forEach(function (ring) {
        rings.push({
          closed: ring.closed || (filled && ring.points.length > 2),
          points: ring.points.map(function (p) {
            var x = p[0];
            var y = p[1];
            matrices.forEach(function (m) {
              var nx = m.a * x + m.c * y + m.e;
              y = m.b * x + m.d * y + m.f;
              x = nx;
            });
            return [(x - box[0]) / box[2], (y - box[1]) / box[3]];
          }),
        });
      });
    });
    return rings.length ? rings : null;
  }

  /** `el`'s box with its rounded corners, as CSS rounds them (scaled down when they would overlap). */
  function cornerOutline(el, w, h) {
    var style = getComputedStyle(el);
    var names = ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"];
    var values = names.map(function (name) {
      return (style.getPropertyValue(name) || el.style.getPropertyValue(name) || "").trim();
    });
    // No rounding there may only mean the shorthand was not taken apart.
    if (values.every(function (v) {
      return !parseFloat(v);
    })) {
      // Only the shorthand: "a b c d / e f g h".
      var short = (style.getPropertyValue("border-radius") || el.style.getPropertyValue("border-radius") || "").split("/");
      var expand = function (text) {
        var v = String(text || "").trim().split(/\s+/).filter(Boolean);
        if (!v.length) return null;
        return [v[0], v[1] || v[0], v[2] || v[0], v[3] || v[1] || v[0]];
      };
      var horizontal = expand(short[0]) || ["0", "0", "0", "0"];
      var vertical = expand(short[1]) || horizontal;
      values = horizontal.map(function (x, i) {
        return x + " " + vertical[i];
      });
    }
    var radii = values.map(function (value) {
      var parts = value.split(/\s+/);
      var rx = cssLength(parts[0] || "0", w);
      var ry = cssLength(parts[1] || parts[0] || "0", h);
      return [rx > 0 ? rx : 0, ry > 0 ? ry : 0];
    });
    var scale = Math.min(
      1,
      w / (radii[0][0] + radii[1][0] || 1),
      w / (radii[3][0] + radii[2][0] || 1),
      h / (radii[0][1] + radii[3][1] || 1),
      h / (radii[1][1] + radii[2][1] || 1),
    );
    // Each corner: the corner of the box, and which way its rounding's center lies from it.
    var corners = [[0, 0, 1, 1], [w, 0, -1, 1], [w, h, -1, -1], [0, h, 1, -1]];
    var ring = [];
    corners.forEach(function (c, i) {
      var rx = radii[i][0] * scale;
      var ry = radii[i][1] * scale;
      if (!(rx > 0 && ry > 0)) {
        ring.push([c[0] / w, c[1] / h]);
        return;
      }
      var cx = c[0] + c[2] * rx;
      var cy = c[1] + c[3] * ry;
      // A quarter around, clockwise from the side before the corner to the one after it.
      var start = Math.PI + (i * Math.PI) / 2;
      for (var k = 0; k <= ARC_SAMPLES; k++) {
        var a = start + (k / ARC_SAMPLES) * (Math.PI / 2);
        ring.push([(cx + rx * Math.cos(a)) / w, (cy + ry * Math.sin(a)) / h]);
      }
    });
    return [{ points: ring, closed: true }];
  }

  /** `el`'s outline in slide pixels, as rings of [x, y] that are closed or not. */
  function slideOutline(el) {
    var f = anchorFrame(el);
    return outlineOf(el).map(function (ring) {
      return {
        closed: ring.closed,
        points: ring.points.map(function (p) {
          var off = turn((p[0] - 0.5) * f.w, (p[1] - 0.5) * f.h, f.angle);
          return [f.x + off.x, f.y + off.y];
        }),
      };
    });
  }

  /** Each stretch of the rings, as [from, to]. */
  function stretchesOf(rings) {
    var all = [];
    rings.forEach(function (ring) {
      var pts = ring.points;
      for (var i = 0; i + 1 < pts.length; i++) all.push([pts[i], pts[i + 1]]);
      if (ring.closed && pts.length > 2) all.push([pts[pts.length - 1], pts[0]]);
    });
    return all;
  }

  /** The spot on the rings nearest slide point `p`, and how far it is. */
  function nearestOnOutline(rings, p) {
    var best = { point: null, distance: Infinity };
    stretchesOf(rings).forEach(function (s) {
      var dx = s[1][0] - s[0][0];
      var dy = s[1][1] - s[0][1];
      var length = dx * dx + dy * dy;
      var t = length ? Math.min(1, Math.max(0, ((p.x - s[0][0]) * dx + (p.y - s[0][1]) * dy) / length)) : 0;
      var q = [s[0][0] + t * dx, s[0][1] + t * dy];
      var d = Math.sqrt(Math.pow(p.x - q[0], 2) + Math.pow(p.y - q[1], 2));
      if (d < best.distance) best = { point: q, distance: d };
    });
    return best;
  }

  /** Whether slide point `p` is inside the closed rings (even-odd, as holes would be). */
  function insideOutline(rings, p) {
    var inside = false;
    rings.forEach(function (ring) {
      if (!ring.closed) return;
      var pts = ring.points;
      for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        var a = pts[i];
        var b = pts[j];
        if (a[1] > p.y !== b[1] > p.y && p.x < ((b[0] - a[0]) * (p.y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      }
    });
    return inside;
  }

  /** Where the way from slide point `from` to `to` first meets the rings, as [x, y]; null if it does not. */
  function firstCrossing(rings, from, to) {
    var rx = to[0] - from[0];
    var ry = to[1] - from[1];
    var best = null;
    var first = Infinity;
    stretchesOf(rings).forEach(function (s) {
      var sx = s[1][0] - s[0][0];
      var sy = s[1][1] - s[0][1];
      var cross = rx * sy - ry * sx;
      if (!cross) return;
      var qx = s[0][0] - from[0];
      var qy = s[0][1] - from[1];
      var t = (qx * sy - qy * sx) / cross;
      var u = (qx * ry - qy * rx) / cross;
      if (t >= 0 && t <= 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6 && t < first) {
        first = t;
        best = [from[0] + t * rx, from[1] + t * ry];
      }
    });
    return best;
  }

  /**
   * Where an end stuck to the edge of `el` at slide point `spot` goes, its line coming from
   * slide point `from`: where the way toward the spot first meets the outline, so the line still
   * points at the spot. From inside the element, or when the way misses it, the outline's spot
   * nearest the spot.
   */
  function edgePoint(el, from, spot) {
    var rings = slideOutline(el);
    var p = { x: spot[0], y: spot[1] };
    var hit = null;
    if (from && distance(from, spot) > 0 && !insideOutline(rings, { x: from[0], y: from[1] })) hit = firstCrossing(rings, from, spot);
    if (!hit) hit = nearestOnOutline(rings, p).point || spot;
    return [roundTenth(hit[0]), roundTenth(hit[1])];
  }

  /**
   * What an end at slide point `p` sticks to: the smallest element it is on, or close to the
   * outline of. Never `line` itself, what holds it, or another line. `edge` says it is close to
   * the outline, then `at` is the spot on it; otherwise `at` is `p`.
   */
  function stickTarget(p, line) {
    var tolerance = EDGE_PX / zoom();
    var best = null;
    var area = Infinity;
    walkContent(slide, function (el) {
      if (el === line || el.contains(line) || !arrangeable(el) || lineOf(el)) return false;
      var f = anchorFrame(el);
      if (!(f.w > 0 && f.h > 0)) return false;
      var local = turn(p.x - f.x, p.y - f.y, -f.angle);
      if (Math.abs(local.x) > f.w / 2 + tolerance || Math.abs(local.y) > f.h / 2 + tolerance) return false;
      var rings = slideOutline(el);
      var near = nearestOnOutline(rings, p);
      var edge = near.distance <= tolerance;
      var closed = rings.some(function (ring) {
        return ring.closed;
      });
      var on = closed ? insideOutline(rings, p) : Math.abs(local.x) <= f.w / 2 && Math.abs(local.y) <= f.h / 2;
      if (!edge && !on) return false;
      if (f.w * f.h < area) {
        best = { el: el, edge: edge, at: edge ? { x: roundTenth(near.point[0]), y: roundTenth(near.point[1]) } : p };
        area = f.w * f.h;
      }
      return false;
    });
    // Close to one of its connection sites, the end goes right onto it, a spot like one inside it.
    var site = best && connectionSites(best.el).filter(function (q) {
      return distance(q, [p.x, p.y]) <= tolerance * SITE_REACH;
    }).sort(function (a, b) {
      return distance(a, [p.x, p.y]) - distance(b, [p.x, p.y]);
    })[0];
    if (site) best = { el: best.el, edge: false, site: true, at: toPoint(site) };
    return best;
  }

  // How much further than its outline a connection site pulls an end in.
  var SITE_REACH = 1.6;

  /**
   * Where lines connect to `el`, in slide pixels: the middle of each side of its box, turned
   * with it, or of its outline where the shape (an ellipse, a triangle) does not reach the side.
   */
  function connectionSites(el) {
    var rings = slideOutline(el);
    return [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]].map(function (at) {
      var p = anchorPoint(el, at);
      var near = nearestOnOutline(rings, toPoint(p)).point || p;
      return [roundTenth(near[0]), roundTenth(near[1])];
    });
  }

  function toPoint(xy) {
    return { x: xy[0], y: xy[1] };
  }

  /** Shows what an end would stick to: the element's box, or its outline and the spot on it for its edge. */
  function previewStick(hit) {
    hover(hit && !hit.edge ? hit.el : null);
    edgeUi.textContent = "";
    if (!hit) return;
    var origin = slide.getBoundingClientRect();
    var k = zoom();
    var screen = function (p) {
      return roundTenth(origin.left + p[0] * k) + " " + roundTenth(origin.top + p[1] * k);
    };
    // Its connection sites, the one the end is on filled.
    connectionSites(hit.el).forEach(function (q) {
      var dot = document.createElementNS(SVG_NS, "circle");
      var at = screen(q).split(" ");
      dot.setAttribute("data-site", hit.site && q[0] === hit.at.x && q[1] === hit.at.y ? "on" : "");
      dot.setAttribute("cx", at[0]);
      dot.setAttribute("cy", at[1]);
      dot.setAttribute("r", "4");
      edgeUi.appendChild(dot);
    });
    if (!hit.edge) return;
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", slideOutline(hit.el).map(function (ring) {
      return ring.points.map(function (p, i) {
        return (i ? "L" : "M") + screen(p);
      }).join(" ") + (ring.closed ? " Z" : "");
    }).join(" "));
    edgeUi.appendChild(path);
    var dot = document.createElementNS(SVG_NS, "circle");
    var at = screen([hit.at.x, hit.at.y]).split(" ");
    dot.setAttribute("cx", at[0]);
    dot.setAttribute("cy", at[1]);
    dot.setAttribute("r", "5");
    edgeUi.appendChild(dot);
  }

  /** An id no element has, nor any of `taken`. */
  function freshId(taken) {
    for (var n = 1; ; n++) {
      var id = "el-" + n;
      if (!document.getElementById(id) && !(taken && taken[id])) return id;
    }
  }

  /** Sticks `line`'s `end` to what `hit` (from `stickTarget`) found, giving the element an id if it has none. */
  function stick(line, end, hit) {
    var target = hit.el;
    if (!target.id) target.id = freshId();
    line.setAttribute(end.attr, target.id);
    line.setAttribute(end.at, formatAnchor(anchorOf(target, hit.at), hit.edge));
  }

  var following = false;
  /** Moves the stuck ends of every line, but those in `skip`, to where their elements are now. */
  function followLines(skip) {
    if (following) return;
    following = true;
    Array.prototype.forEach.call(slide.querySelectorAll("[data-from], [data-to]"), function (el) {
      if (skip.indexOf(el) >= 0) return;
      var line = lineOf(el);
      var tilt = line ? tiltOf(el) : null;
      if (!line || tilt.x || tilt.y) return;
      var points = slidePoints(el, line);
      var changed = false;
      var spots = ENDS.map(function (end) {
        if (!el.hasAttribute(end.attr)) return null;
        var target = stuckTo(el, end);
        if (!target) {
          unstick(el, end);
          return null;
        }
        var f = anchorFrame(target);
        // A hidden element keeps its lines where they are.
        if (!(f.w > 0 && f.h > 0)) return null;
        var anchor = parseAnchor(el.getAttribute(end.at));
        return { target: target, edge: anchor.edge, at: anchorPoint(target, anchor.at) };
      });
      ENDS.forEach(function (end, n) {
        var spot = spots[n];
        if (!spot) return;
        var i = end.first ? 0 : points.length - 1;
        var to = spot.at;
        if (spot.edge && !line.route) {
          // The line comes toward the spot from the point before the end: on a straight line,
          // the other end, or the spot that end is stuck to.
          var other = spots[1 - n];
          var from = points.length === 2 && other ? other.at : points[end.first ? 1 : points.length - 2];
          to = edgePoint(spot.target, from, spot.at);
        }
        if (Math.abs(points[i][0] - to[0]) > 0.5 || Math.abs(points[i][1] - to[1]) > 0.5) {
          points[i] = to;
          changed = true;
        }
      });
      // Both ends on one spot would leave no line.
      if (changed && (points.length > 2 || distance(points[0], points[1]) > 0)) writeLine(el, points, line.heads);
    });
    following = false;
  }

  /**
   * Keeps the ends of copied lines stuck only within the copies `els`: to the copy of what the
   * original was stuck to (which gets an id of its own), or else to nothing. Ids for which
   * `drop` says so are removed, so ids stay unique.
   */
  function restickCopies(els, drop) {
    var nodes = [];
    els.forEach(function (el) {
      nodes = nodes.concat(withDescendants(el));
    });
    var copied = {};
    nodes.forEach(function (node) {
      if (node.id) copied[node.id] = node;
    });
    nodes.forEach(function (node) {
      if (node.id && drop(node)) node.removeAttribute("id");
    });
    var given = {};
    nodes.forEach(function (node) {
      ENDS.forEach(function (end) {
        var id = node.getAttribute(end.attr);
        if (id === null) return;
        var target = copied[id];
        if (!target || target === node) {
          unstick(node, end);
          return;
        }
        if (!target.id) {
          target.id = freshId(given);
          given[target.id] = true;
        }
        node.setAttribute(end.attr, target.id);
      });
    });
  }

  function idTaken(node) {
    return !!document.getElementById(node.id);
  }

  /** Puts the handles on the selected line's points; false when no line is selected to show them. */
  function placePoints() {
    pointUi.textContent = "";
    var el = selected;
    var line = el && !editing && !extras.length && slide.contains(el) && !isLocked(el) ? lineOf(el) : null;
    var tilt = line ? tiltOf(el) : null;
    // A tilted line keeps its box: its points are not where the handles would go.
    if (!line || tilt.x || tilt.y) return false;
    var origin = slide.getBoundingClientRect();
    var k = zoom();
    var points = slidePoints(el, line).map(function (p) {
      return [origin.left + p[0] * k, origin.top + p[1] * k];
    });
    var handle = function (kind, index, at, title) {
      var node = document.createElement("div");
      node.setAttribute("data-point", kind);
      node.setAttribute("data-index", String(index));
      node.title = title;
      node.style.left = at[0] + "px";
      node.style.top = at[1] + "px";
      pointUi.appendChild(node);
    };
    var dragging = drag && drag.mode === "point";
    // A connector routes itself between its ends.
    if (!dragging && !line.route) {
      curveThrough(points).forEach(function (segment, i) {
        handle("add", i + 1, curveAt(segment, 0.5), "Drag to bend the line here");
      });
    }
    points.forEach(function (p, i) {
      var end = endAt(i, points.length);
      handle("point", i, p, "Drag to move (Shift snaps to 45°, ⌘ moves freely)" + (end ? ", drop on an element to stick to it" : ", double-click to remove"));
      if (end && el.hasAttribute(end.attr)) pointUi.lastChild.setAttribute("data-bound", "");
    });
    return true;
  }

  pointUi.addEventListener("pointerdown", function (event) {
    var kind = event.target.getAttribute && event.target.getAttribute("data-point");
    var line = lineOf(selected);
    if (event.button !== 0 || !kind || !line) return;
    event.preventDefault();
    event.stopPropagation();
    if (nudgeTimer) commit();
    var index = Number(event.target.getAttribute("data-index"));
    var points = slidePoints(selected, line);
    var now = Date.now();
    var double = kind === "point" && index === lastPoint.index && now - lastPoint.at < DOUBLE_CLICK_MS;
    lastPoint = { index: kind === "point" && !double ? index : -1, at: now };
    if (double) {
      if (index > 0 && index < points.length - 1) {
        points.splice(index, 1);
        writeLine(selected, points, line.heads);
        placeHandles();
        commit();
      }
      return;
    }
    drag = {
      mode: "point",
      el: selected,
      points: points,
      heads: line.heads,
      index: index,
      insert: kind === "add",
      x: event.clientX,
      y: event.clientY,
      zoom: zoom(),
      moved: false,
    };
    try {
      pointUi.setPointerCapture(event.pointerId);
    } catch (e) {
      // Synthetic events have no active pointer to capture.
    }
  });

  pointUi.addEventListener("dblclick", function (event) {
    event.stopPropagation();
  });

  /** Moves the dragged point of a line to the pointer; a new point goes in on the first move. */
  function pointTo(event) {
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.x) < DRAG_THRESHOLD && Math.abs(event.clientY - drag.y) < DRAG_THRESHOLD) return;
      drag.moved = true;
      lastPoint = { index: -1, at: 0 };
      hover(null);
      drag.targets = snapTargets([drag.el]);
      if (drag.insert) drag.points.splice(drag.index, 0, null);
    }
    var points = drag.points;
    var other = points[drag.index ? drag.index - 1 : 1];
    var at = slidePoint(event.clientX, event.clientY);
    guides.textContent = "";
    if (event.shiftKey) {
      at = snapLine({ x: other[0], y: other[1] }, at);
    } else if (!event.metaKey && !event.ctrlKey) {
      var tolerance = SNAP_PX / drag.zoom;
      var sx = snapAxis([at.x], drag.targets.x, tolerance);
      var sy = snapAxis([at.y], drag.targets.y, tolerance);
      at = { x: at.x + sx.by, y: at.y + sy.by };
      drawGuides(sx.hits, sy.hits, { left: at.x, top: at.y, right: at.x, bottom: at.y });
    }
    var hit = null;
    if (!drag.insert && endAt(drag.index, points.length)) {
      hit = event.metaKey || event.ctrlKey ? null : stickTarget(at, drag.el);
      if (hit && (hit.edge || hit.site) && !event.shiftKey) at = endSpot(hit, other, drag.el);
    }
    // Both ends on one spot would leave no line.
    if (points.length === 2 && at.x === other[0] && at.y === other[1]) return;
    points[drag.index] = [at.x, at.y];
    drag.at = at;
    if (!drag.insert && endAt(drag.index, points.length)) {
      drag.stick = hit;
      previewStick(hit);
    }
    var end = !drag.insert && endAt(drag.index, points.length);
    var dirs = end && routeOf(drag.el) ? draggedDirections(drag.el, points, end.first ? 0 : 1, hit) : null;
    writeLine(drag.el, points, drag.heads, false, dirs);
    placeHandles();
    showReadout(event);
  }

  /** Redraws the line being added so it ends at `to`, where `hit` (see stickTarget) may stick it. */
  function drawLine(line, to, hit) {
    line.points = [[line.at.x, line.at.y], [to.x, to.y]];
    var start = routeOf(line.el) ? stickTarget(line.at, line.el) : null;
    var dirs = routeOf(line.el) ? draggedDirections(line.el, line.points, 1, hit || null) : null;
    if (start) dirs[0] = { dir: sideOut(start.el, anchorOf(start.el, start.at)), stuck: true };
    writeLine(line.el, line.points, line.heads, true, dirs);
  }

  /**
   * Where an end that `hit` (see stickTarget) found close to an element's outline goes: a
   * line's end where the line toward the spot from `from` first meets the outline, a
   * connector's on the spot itself, as it leaves the element straight out of it. On a
   * connection site, any end goes right onto it.
   */
  function endSpot(hit, from, line) {
    return hit.site || routeOf(line) ? { x: hit.at.x, y: hit.at.y } : toPoint(edgePoint(hit.el, from, [hit.at.x, hit.at.y]));
  }

  /** `to`, turned around `from` to the nearest 45°. */
  function snapLine(from, to) {
    var dx = to.x - from.x;
    var dy = to.y - from.y;
    var length = Math.sqrt(dx * dx + dy * dy);
    var angle = (Math.round((Math.atan2(dy, dx) * 4) / Math.PI) * Math.PI) / 4;
    return { x: Math.round(from.x + length * Math.cos(angle)), y: Math.round(from.y + length * Math.sin(angle)) };
  }

