  // ---- Shapes, styling and media: lines and arrows, cut-out shapes, the look of any element,
  // images, the slide's background, deck colors and the format painter.

  function isLine(name) {
    return name === "line" || name === "arrow" || name === "elbow" || name === "curve";
  }

  function distance(a, b) {
    return Math.sqrt(Math.pow(b[0] - a[0], 2) + Math.pow(b[1] - a[1], 2));
  }

  /**
   * The smooth curve through `points`, as Bézier segments [from, control, control, to]. It goes
   * through each point along the line between its neighbors, and each control point reaches a
   * third of the way along its segment, so points close together do not make it overshoot.
   */
  function curveThrough(points) {
    var last = points.length - 1;
    var along = function (i) {
      var a = points[Math.max(i - 1, 0)];
      var b = points[Math.min(i + 1, last)];
      var length = distance(a, b) || 1;
      return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    };
    return points.slice(1).map(function (to, i) {
      var from = points[i];
      var reach = distance(from, to) / 3;
      var start = along(i);
      var end = along(i + 1);
      return [from, [from[0] + start[0] * reach, from[1] + start[1] * reach], [to[0] - end[0] * reach, to[1] - end[1] * reach], to];
    });
  }

  /** The spot `t` of the way (0 to 1) along a Bézier segment. */
  function curveAt(segment, t) {
    var u = 1 - t;
    var weights = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [0, 1].map(function (axis) {
      return segment.reduce(function (sum, point, i) {
        return sum + point[axis] * weights[i];
      }, 0);
    });
  }

  // ---- Lines: a drawing with one stroked <path> through its points (`M L` when straight,
  // `M C C …` through them when curved) and a <path> of its own for each head, with
  // `data-head="start arrow"` or `"end triangle"` (see HEADS). A connector, `data-route="elbow"`
  // or `"curved"`, goes from end to end by straight stretches that turn at right angles, or by
  // one curve, leaving an element it is stuck to straight out of the side it is stuck to. Its
  // dashes are a `stroke-dasharray` on the stroke, never on the heads.

  /** The route of line `el`, or null for one straight or curved through its points. */
  function routeOf(el) {
    var route = el && el.getAttribute ? el.getAttribute(ROUTE_ATTR) : null;
    return route && ROUTES[route] ? route : null;
  }

  /** "end arrow" as { end, kind }, or null when it says nothing usable. */
  function parseHead(value) {
    var words = String(value || "").trim().split(/\s+/);
    return words.length === 2 && /^(start|end)$/.test(words[0]) && HEADS[words[1]] ? { end: words[0], kind: words[1] } : null;
  }

  /** How the stroke `vector` is dashed: "dashed", "dotted" or "solid". */
  function dashOf(vector) {
    var parts = String((vector && vector.getAttribute("stroke-dasharray")) || "").trim().split(/[\s,]+/).map(parseFloat);
    if (!parts.length || !isFinite(parts[0]) || parts.every(function (n) { return !n; })) return "solid";
    return parts[0] === 0 ? "dotted" : "dashed";
  }

  /**
   * Dashes the stroke `vector`, `width` wide: a dash of two widths and a gap of three (so with
   * round caps, three and two), or dots one width across, two apart.
   */
  function setDash(vector, dash, width) {
    var w = Math.max(1, Number(width) || 0);
    if (dash === "dashed") vector.setAttribute("stroke-dasharray", roundTenth(2 * w) + " " + roundTenth(3 * w));
    else if (dash === "dotted") vector.setAttribute("stroke-dasharray", "0 " + roundTenth(2 * w));
    else vector.removeAttribute("stroke-dasharray");
  }

  /** What makes `el` a line: its stroke, points (in the viewBox), heads, width and route. Null for anything else. */
  function lineOf(el) {
    if (!el || !el.getAttribute || !viewBoxOf(el)) return null;
    var vectors = vectorsOf(el);
    var strokes = vectors.filter(function (v) {
      return !v.hasAttribute(HEAD_ATTR);
    });
    if (strokes.length !== 1 || strokes[0].tagName.toLowerCase() !== "path" || vectors.length - strokes.length > 2) return null;
    var heads = { start: null, end: null };
    var headless = vectors.every(function (v) {
      if (!v.hasAttribute(HEAD_ATTR)) return true;
      var head = parseHead(v.getAttribute(HEAD_ATTR));
      if (!head || heads[head.end] || v.tagName.toLowerCase() !== "path") return false;
      heads[head.end] = head.kind;
      return true;
    });
    if (!headless) return null;
    var parts = (strokes[0].getAttribute("d") || "").trim().match(LINE_PATH);
    if (!parts) return null;
    if (parts[2]) {
      if (heads.start || heads.end) return null;
      heads.end = "arrow";
    }
    var route = routeOf(el);
    var numbers = parts[1].match(NUMBER).map(parseFloat);
    var curved = parts[1].indexOf("C") >= 0;
    var step = curved ? 6 : 2;
    var points = [numbers.slice(0, 2)];
    for (var i = step; i < numbers.length; i += step) points.push(numbers.slice(i, i + 2));
    // A freehand stroke goes through its points straight.
    if (!curved && points.length > 2 && !route) return null;
    // A connector's route follows from its ends.
    if (route) points = [points[0], points[points.length - 1]];
    // A tap of the freehand tool leaves a dot.
    if (points.length === 2 && !distance(points[0], points[1])) return null;
    return {
      path: strokes[0],
      points: points,
      heads: heads,
      route: route,
      dash: dashOf(strokes[0]),
      width: parseFloat(strokes[0].getAttribute("stroke-width")) || 0,
    };
  }

  /** The unit vector along the axis `v` mostly goes along. */
  function axisOf(v) {
    return Math.abs(v[0]) >= Math.abs(v[1]) ? [v[0] < 0 ? -1 : 1, 0] : [0, v[1] < 0 ? -1 : 1];
  }

  /**
   * The way a connector leaves each of its ends, as unit vectors pointing from the end into
   * the line, and whether that end is stuck (so it first goes `ELBOW_STUB` straight out). A
   * stuck end leaves its element out of the side it is stuck to, turned with the element; a
   * free one heads off toward the other end. `el` may be null, for ends stuck to nothing.
   */
  function endDirections(el, points) {
    var last = points.length - 1;
    return ENDS.map(function (end, n) {
      var tip = points[n ? last : 0];
      var other = points[n ? 0 : last];
      var target = el ? stuckTo(el, end) : null;
      if (!target) return { dir: axisOf([other[0] - tip[0], other[1] - tip[1]]), stuck: false };
      return { dir: sideOut(target, parseAnchor(el.getAttribute(end.at)).at), stuck: true };
    });
  }

  /** The way out of `el` through the side of its box closest to the spot `at` (fractions of its box), turned with it. */
  function sideOut(el, at) {
    var sides = [[at[0], [-1, 0]], [1 - at[0], [1, 0]], [at[1], [0, -1]], [1 - at[1], [0, 1]]].sort(function (a, b) {
      return a[0] - b[0];
    });
    var out = turn(sides[0][1][0], sides[0][1][1], angleOf(el));
    return [out.x, out.y];
  }

  /**
   * endDirections for line `el` while its end `n` is dragged to `points[n]`: free, or leaving
   * what `hit` (see stickTarget) would stick it to.
   */
  function draggedDirections(el, points, n, hit) {
    var dirs = endDirections(el, points);
    var last = points.length - 1;
    var tip = points[n ? last : 0];
    var other = points[n ? 0 : last];
    dirs[n] = hit
      ? { dir: sideOut(hit.el, anchorOf(hit.el, hit.at)), stuck: true }
      : { dir: axisOf([other[0] - tip[0], other[1] - tip[1]]), stuck: false };
    return dirs;
  }

  /** Drops points that repeat the one before or lie on the straight stretch through their neighbors. */
  function simplify(points) {
    var out = [];
    points.forEach(function (p) {
      var prev = out[out.length - 1];
      if (prev && Math.abs(prev[0] - p[0]) < 0.05 && Math.abs(prev[1] - p[1]) < 0.05) return;
      var before = out[out.length - 2];
      if (before && prev && ((Math.abs(before[0] - prev[0]) < 0.05 && Math.abs(prev[0] - p[0]) < 0.05) ||
          (Math.abs(before[1] - prev[1]) < 0.05 && Math.abs(prev[1] - p[1]) < 0.05))) {
        out[out.length - 1] = p;
        return;
      }
      out.push(p);
    });
    return out;
  }

  /**
   * An elbow connector from `s` to `e`: straight stretches that turn at right angles, leaving
   * each end the way `dirs` says (see endDirections), and a stub's length straight out of an
   * element first. Worked out for a start that leaves sideways; one that leaves up or down
   * swaps the axes there and back.
   */
  function elbowRoute(s, e, dirs) {
    var sideways = Math.abs(dirs[0].dir[0]) >= Math.abs(dirs[0].dir[1]);
    var swap = function (p) {
      return sideways ? [p[0], p[1]] : [p[1], p[0]];
    };
    var S = swap(s);
    var E = swap(e);
    var ds = swap(axisOf(dirs[0].dir));
    var de = swap(axisOf(dirs[1].dir));
    var a = [S[0] + ds[0] * (dirs[0].stuck ? ELBOW_STUB : 0), S[1]];
    var b = [E[0] + de[0] * (dirs[1].stuck ? ELBOW_STUB : 0), E[1] + de[1] * (dirs[1].stuck ? ELBOW_STUB : 0)];
    var go = ds[0];
    var turns;
    if (de[1] === 0) {
      if (de[0] === -go && (b[0] - a[0]) * go >= 0) {
        // Facing each other: across at half way.
        var mx = (a[0] + b[0]) / 2;
        turns = [[mx, a[1]], [mx, b[1]]];
      } else if (de[0] === go) {
        // Both out the same way: around the one further out.
        var x = go > 0 ? Math.max(a[0], b[0]) : Math.min(a[0], b[0]);
        turns = [[x, a[1]], [x, b[1]]];
      } else {
        // Facing away from each other: over at half height.
        var my = (a[1] + b[1]) / 2;
        turns = [[a[0], my], [b[0], my]];
      }
    } else if ((b[0] - a[0]) * go >= 0 && (a[1] - b[1]) * de[1] >= 0) {
      // One turn, where the start's way across meets the end's way up or down.
      turns = [[b[0], a[1]]];
    } else {
      var half = (a[1] + b[1]) / 2;
      turns = [[a[0], half], [b[0], half]];
    }
    return simplify([S, a].concat(turns, [b, E]).map(swap));
  }

  /** A curved connector's control points: out of each end the way `dirs` says, by 40% of the way between them. */
  function curvedControls(s, e, dirs) {
    var reach = Math.max(ELBOW_STUB, distance(s, e) * 0.4);
    return dirs.map(function (d, n) {
      var from = n ? e : s;
      return [from[0] + d.dir[0] * reach, from[1] + d.dir[1] * reach];
    });
  }

  /**
   * A head of `kind` at `tip`, for a line coming from `from`, `size` long: its points, whether it
   * closes, and whether it is filled. An arrow is two barbs, a triangle closes and fills them, a
   * bar crosses the end and a dot sits on it (`dot` its center and radius).
   */
  function headShape(kind, tip, from, size) {
    var angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
    var at = function (a, length) {
      return [Math.round(tip[0] + length * Math.cos(a)), Math.round(tip[1] + length * Math.sin(a))];
    };
    if (kind === "bar") return { points: [at(angle + Math.PI / 2, size / 2), at(angle - Math.PI / 2, size / 2)] };
    if (kind === "dot") return { dot: { at: tip, r: roundTenth(size / 3) }, filled: true };
    var barbs = [at(angle + Math.PI + ARROW_HEAD_ANGLE, size), tip, at(angle + Math.PI - ARROW_HEAD_ANGLE, size)];
    return kind === "triangle" ? { points: barbs, closed: true, filled: true } : { points: barbs };
  }

  /**
   * What a line through `points` (in any coordinates) draws: its stroke, as `poly` (straight
   * stretches through the points) or `curve` (Bézier segments), and as `track` (straight
   * stretches either way, close along a curve), and its `heads`, with the spots that reach
   * furthest, for the box around it. `dirs` (see endDirections) route a connector;
   * without them its ends head off toward each other.
   */
  function lineShape(points, heads, width, route, dirs) {
    var last = points.length - 1;
    var s = points[0];
    var e = points[last];
    var shape = { poly: null, curve: null, track: [], spots: [], heads: {} };
    var into;
    if (route) dirs = dirs || endDirections(null, [s, e]);
    if (route === "elbow") {
      shape.poly = elbowRoute(s, e, dirs);
    } else if (route === "curved") {
      var c = curvedControls(s, e, dirs);
      shape.curve = [[s, c[0], c[1], e]];
    } else if (last > 1) {
      shape.curve = curveThrough(points);
    } else {
      shape.poly = [s, e];
    }
    if (shape.poly) {
      shape.spots = shape.poly.slice();
      shape.track = shape.poly.slice();
      into = [shape.poly[1], shape.poly[shape.poly.length - 2]];
    } else {
      shape.spots = [s];
      shape.curve.forEach(function (segment) {
        for (var i = 1; i <= LINE_SAMPLES; i++) shape.spots.push(curveAt(segment, i / LINE_SAMPLES));
      });
      shape.track = shape.spots.slice();
      into = [shape.curve[0][1], shape.curve[shape.curve.length - 1][2]];
    }
    var length = shape.spots.slice(1).reduce(function (sum, p, i) {
      return sum + distance(shape.spots[i], p);
    }, 0);
    var size = Math.min(Math.max(ARROW_HEAD_MIN, ARROW_HEAD_PER_WIDTH * width), length);
    ENDS.forEach(function (end, n) {
      var kind = heads && heads[n ? "end" : "start"];
      var tip = n ? e : s;
      // A control point on the tip points the head along the stretch before it.
      var from = into[n];
      if (!distance(from, tip)) from = n ? shape.spots[shape.spots.length - 2] || s : shape.spots[1] || e;
      if (!kind || !size || !distance(from, tip)) return;
      var head = headShape(kind, tip, from, size);
      shape.heads[n ? "end" : "start"] = head;
      if (head.points) shape.spots = shape.spots.concat(head.points);
      else shape.spots.push([tip[0] - head.dot.r, tip[1] - head.dot.r], [tip[0] + head.dot.r, tip[1] + head.dot.r]);
    });
    return shape;
  }

  /** The path data of a head (see headShape), moved by (-dx, -dy). */
  function headData(head, dx, dy) {
    var r = function (n) {
      return roundTenth(n);
    };
    if (head.dot) {
      var x = head.dot.at[0] - dx;
      var y = head.dot.at[1] - dy;
      var rad = head.dot.r;
      return "M" + r(x - rad) + " " + r(y) + " A" + rad + " " + rad + " 0 1 0 " + r(x + rad) + " " + r(y) +
        " A" + rad + " " + rad + " 0 1 0 " + r(x - rad) + " " + r(y) + " Z";
    }
    return pathData(head.points.map(function (p) {
      return [r(p[0] - dx), r(p[1] - dy)];
    }), 0, 0) + (head.closed ? " Z" : "");
  }

  /**
   * Draws `shape` (see lineShape) into line `el`, moved by (-dx, -dy): the stroke into `path`,
   * and each head into a <path> of its own, which takes the stroke's color and width.
   */
  function drawLineShape(el, path, shape, dx, dy) {
    var local = function (p) {
      return roundTenth(p[0] - dx) + " " + roundTenth(p[1] - dy);
    };
    var data = shape.poly
      ? shape.poly.map(function (p, i) {
          return (i ? "L" : "M") + local(p);
        }).join(" ")
      : "M" + local(shape.curve[0][0]) + shape.curve.map(function (segment) {
          return " C" + segment.slice(1).map(local).join(" ");
        }).join("");
    path.setAttribute("d", data);
    var stroke = path.getAttribute("stroke") || BORDER_COLOR;
    ["start", "end"].forEach(function (end) {
      var head = shape.heads[end];
      var node = Array.prototype.find.call(el.querySelectorAll("[" + HEAD_ATTR + "]"), function (n) {
        var now = parseHead(n.getAttribute(HEAD_ATTR));
        return now && now.end === end;
      });
      if (!head) {
        if (node) node.parentNode.removeChild(node);
        return;
      }
      if (!node) {
        node = document.createElementNS(SVG_NS, "path");
        path.parentNode.insertBefore(node, end === "start" ? path.nextSibling : null);
      }
      var kind = head.dot ? "dot" : head.closed ? "triangle" : head.points.length === 2 ? "bar" : "arrow";
      node.setAttribute(HEAD_ATTR, end + " " + kind);
      node.setAttribute("d", headData(head, dx, dy));
      node.setAttribute("fill", head.filled ? stroke : "none");
      node.setAttribute("stroke", stroke);
      node.setAttribute("stroke-width", path.getAttribute("stroke-width") || String(BORDER_WIDTH));
      node.setAttribute("stroke-linecap", "round");
      node.setAttribute("stroke-linejoin", "round");
    });
  }

  /** `line`'s points in slide pixels, wherever turning and scaling `el` took them. */
  function slidePoints(el, line) {
    var box = viewBoxOf(el);
    var frame = frameOf(el);
    var kx = (frame.right - frame.left) / box[2];
    var ky = (frame.bottom - frame.top) / box[3];
    return line.points.map(function (p) {
      var at = turn((p[0] - box[0] - box[2] / 2) * kx, (p[1] - box[1] - box[3] / 2) * ky, angleOf(el));
      return [(frame.left + frame.right) / 2 + at.x, (frame.top + frame.bottom) / 2 + at.y];
    });
  }

  /** How far `p` is from the stretch from `a` to `b`. */
  function segmentDistance(p, a, b) {
    var dx = b[0] - a[0];
    var dy = b[1] - a[1];
    var length = dx * dx + dy * dy;
    var t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
    return distance(p, [a[0] + t * dx, a[1] + t * dy]);
  }

  /** How far `p` is from the straight stretches through `points`. */
  function polyDistance(p, points) {
    if (points.length === 1) return distance(p, points[0]);
    var best = Infinity;
    for (var i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(p, points[i - 1], points[i]));
    return best;
  }

  /**
   * Whether the pointer at (x, y) is on what line `el` draws: its stroke or a head, give or take
   * `LINE_HIT_SLOP` on screen. A tilted line is hit anywhere in its box, as it is framed by one.
   */
  function onLine(el, line, x, y) {
    var tilt = tiltOf(el);
    if (tilt.x || tilt.y) return true;
    var at = slidePoint(x, y);
    var p = [at.x, at.y];
    var points = slidePoints(el, line);
    var shape = lineShape(points, line.heads, line.width, line.route, line.route ? endDirections(el, points) : null);
    var scale = scaleOf(el);
    var reach = (line.width * Math.max(scale.x, scale.y)) / 2 + LINE_HIT_SLOP / (zoom() || 1);
    if (polyDistance(p, shape.track) <= reach) return true;
    return ["start", "end"].some(function (end) {
      var head = shape.heads[end];
      if (!head) return false;
      if (head.dot) return distance(p, head.dot.at) <= head.dot.r + reach;
      return polyDistance(p, head.closed ? head.points.concat([head.points[0]]) : head.points) <= reach;
    });
  }

  /**
   * Redraws line `el` through `points` (in slide pixels) with `heads`, its box fitted around it,
   * unturned. A `fresh` line, still being added, sits on the slide untransformed, so its box
   * goes right where the points are.
   */
  function writeLine(el, points, heads, fresh, dirs) {
    var path = vectorsOf(el).filter(function (v) {
      return !v.hasAttribute(HEAD_ATTR);
    })[0];
    var width = parseFloat(path.getAttribute("stroke-width")) || 0;
    var route = routeOf(el);
    if (route) points = [points[0], points[points.length - 1]];
    var shape = lineShape(points, heads, width, route, route ? dirs || endDirections(el, points) : null);
    var bound = function (axis, pick, round) {
      return round(pick.apply(null, shape.spots.map(function (p) {
        return p[axis];
      })));
    };
    var pad = Math.ceil(width / 2);
    var left = bound(0, Math.min, Math.floor) - pad;
    var top = bound(1, Math.min, Math.floor) - pad;
    var w = Math.max(1, bound(0, Math.max, Math.ceil) + pad - left);
    var h = Math.max(1, bound(1, Math.max, Math.ceil) + pad - top);
    if (fresh) {
      place(el, left, top, w, h);
    } else {
      // Turning and scaling go around the center, so the box's unscaled corner is where it lays out.
      var frame = frameOf(el);
      var size = sizeOf(el);
      var computed = getComputedStyle(el);
      place(
        el,
        (parseFloat(computed.left) || 0) + left - ((frame.left + frame.right) / 2 - size.w / 2),
        (parseFloat(computed.top) || 0) + top - ((frame.top + frame.bottom) / 2 - size.h / 2),
        w,
        h,
      );
    }
    el.setAttribute("viewBox", "0 0 " + w + " " + h);
    drawLineShape(el, path, shape, left, top);
    if (angleOf(el)) rotateTo(el, 0);
    var scale = scaleOf(el);
    if (scale.x !== 1 || scale.y !== 1) scaleTo(el, 1, 1);
  }

  /** Mirrors line `el` across the middle of its points, then sticks its ends to whatever they land on. */
  function flipLine(el, x, y) {
    var line = lineOf(el);
    if (!line || (!x && !y)) return;
    var points = slidePoints(el, line);
    var middle = function (axis) {
      var values = points.map(function (p) {
        return p[axis];
      });
      return Math.min.apply(null, values) + Math.max.apply(null, values);
    };
    var mx = middle(0);
    var my = middle(1);
    points = points.map(function (p) {
      return [roundTenth(x ? mx - p[0] : p[0]), roundTenth(y ? my - p[1] : p[1])];
    });
    ENDS.forEach(function (end) {
      unstick(el, end);
    });
    writeLine(el, points, line.heads);
    ENDS.forEach(function (end, n) {
      var hit = stickTarget(toPoint(points[n ? points.length - 1 : 0]), el);
      if (hit) stick(el, end, hit);
    });
    if (routeOf(el)) writeLine(el, points, line.heads);
  }

