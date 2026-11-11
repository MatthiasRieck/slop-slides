/* SlopSlide PowerPoint export helper (src-tauri/src/pptx/export.rs). The app runs it in the hidden
   window that exports a deck; it never becomes part of a deck. Each step answers by navigating
   to /.pptx-signal?<answer>, which the app catches and cancels.

   It reads each shown slide as rendered into a scene of what PowerPoint has natively: boxes
   (fills with alpha, gradients, borders, outer shadows), text, images and, for an SVG, freeform
   shapes and lines. Backdrop blur has no counterpart and is dropped; whatever else PowerPoint
   cannot draw (canvas, filters, masks, 3D, pseudo-element art, an SVG that uses any of these)
   becomes a "shot", a picture the app captures with `isolate`. */
(function () {
  // WebView2 finishes canceled signal navigations too, which runs this again: keep the scene
  // and shots of the export under way, and do not report ready twice.
  if (window.__slopPptx) return;

  var root = document.documentElement;
  var CHUNK = 24000;

  // Tests answer through __slopPptxSignal; jsdom cannot navigate.
  var signal =
    window.__slopPptxSignal ||
    function (answer) {
      location.assign(location.origin + "/.pptx-signal?" + answer);
    };

  var css = [
    'html[data-slop-pptx] *, html[data-slop-pptx] *::before, html[data-slop-pptx] *::after { visibility: hidden !important; }',
    'html[data-slop-pptx] .slide.active { visibility: visible !important; }',
    'html[data-slop-pptx] .slide.active:not([data-slop-pptx-shot]) { background: transparent !important; }',
    'html[data-slop-pptx][data-slop-pptx-paper], html[data-slop-pptx][data-slop-pptx-paper] body, html[data-slop-pptx][data-slop-pptx-paper] .deck, html[data-slop-pptx][data-slop-pptx-paper] .slide.active:not([data-slop-pptx-shot]) {',
    '  background: var(--slop-pptx-paper) !important;',
    '}',
    /* Under the html[…] prefix, to outrank the rule hiding everything. */
    'html[data-slop-pptx] [data-slop-pptx-shot="all"], html[data-slop-pptx] [data-slop-pptx-shot="all"] *,',
    'html[data-slop-pptx] [data-slop-pptx-shot="all"]::before, html[data-slop-pptx] [data-slop-pptx-shot="all"]::after,',
    'html[data-slop-pptx] [data-slop-pptx-shot="all"] *::before, html[data-slop-pptx] [data-slop-pptx-shot="all"] *::after { visibility: visible !important; }',
    'html[data-slop-pptx] [data-slop-pptx-shot="decor"], html[data-slop-pptx] [data-slop-pptx-shot="decor"]::before,',
    'html[data-slop-pptx] [data-slop-pptx-shot="decor"]::after { visibility: visible !important; }',
    'html[data-slop-pptx] [data-slop-pptx-shot="decor"] { -webkit-text-fill-color: transparent !important; }',
    'html[data-slop-pptx] [data-slop-pptx-shot="decor"]::before, html[data-slop-pptx] [data-slop-pptx-shot="decor"]::after { -webkit-text-fill-color: currentcolor !important; }',
  ].join("\n");

  var NEVER = { script: 1, style: 1, template: 1, noscript: 1, head: 1, title: 1, meta: 1, link: 1, audio: 1 };
  var PICTURED = { svg: 1, canvas: 1, video: 1, iframe: 1, object: 1, embed: 1, math: 1 };
  var IMAGE_FILE = /^(\.\/)?assets\/[^?#]+\.(png|jpe?g|gif|bmp)$/i;
  var MARKERS = { disc: "•", circle: "◦", square: "▪" };

  var scene = [];
  var shots = [];
  var encoded = "";
  var colorCanvas = null;

  /** The slides the file holds, in order: those the player shows. */
  function slides() {
    return Array.prototype.slice.call(document.querySelectorAll(".deck > .slide:not([data-hidden])"));
  }

  function num(text, fallback) {
    var value = parseFloat(text);
    return isFinite(value) ? value : fallback === undefined ? 0 : fallback;
  }

  /** `[r, g, b, a]`, with a from 0 to 1, for any CSS colour. */
  function color(text) {
    if (!text || text === "transparent") return [0, 0, 0, 0];
    var m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(text);
    if (m) {
      var alpha = m[4] === undefined ? 1 : num(m[4], 1) / (m[5] ? 100 : 1);
      return [Math.round(num(m[1])), Math.round(num(m[2])), Math.round(num(m[3])), alpha];
    }
    // Newer notations (oklch(), color()): let the browser turn them into pixels.
    try {
      colorCanvas = colorCanvas || document.createElement("canvas").getContext("2d");
      colorCanvas.clearRect(0, 0, 1, 1);
      colorCanvas.fillStyle = text;
      colorCanvas.fillRect(0, 0, 1, 1);
      var px = colorCanvas.getImageData(0, 0, 1, 1).data;
      return [px[0], px[1], px[2], px[3] / 255];
    } catch (e) {
      return [0, 0, 0, 1];
    }
  }

  /** `text` split at its top-level commas. */
  function splitTop(text) {
    var parts = [];
    var depth = 0;
    var start = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        parts.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    parts.push(text.slice(start).trim());
    return parts;
  }

  var SIDES = {
    "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
    "to top right": 45, "to right top": 45, "to bottom right": 135, "to right bottom": 135,
    "to bottom left": 225, "to left bottom": 225, "to top left": 315, "to left top": 315,
  };

  /** A `linear-gradient(…)` as `{ angle, stops }`; null for anything PowerPoint would not match. */
  function gradient(text) {
    var m = /^linear-gradient\((.*)\)$/.exec(text.trim());
    if (!m) return null;
    var parts = splitTop(m[1]);
    var angle = 180;
    var deg = /^(-?[\d.]+)deg$/.exec(parts[0]);
    if (deg) {
      angle = num(deg[1]);
      parts.shift();
    } else if (SIDES[parts[0]] !== undefined) {
      angle = SIDES[parts[0]];
      parts.shift();
    }
    if (parts.length < 2) return null;
    var stops = [];
    for (var i = 0; i < parts.length; i++) {
      var stop = /^(.*?\)|[a-z]+)(?:\s+([\d.]+)%)?$/.exec(parts[i]);
      if (!stop) return null;
      stops.push({ color: color(stop[1]), at: stop[2] === undefined ? null : num(stop[2]) / 100 });
    }
    if (stops[0].at === null) stops[0].at = 0;
    if (stops[stops.length - 1].at === null) stops[stops.length - 1].at = 1;
    for (var s = 1; s < stops.length; s++) {
      if (stops[s].at !== null) continue;
      var next = s;
      while (stops[next].at === null) next++;
      var before = stops[s - 1].at;
      stops[s].at = before + (stops[next].at - before) / (next - s + 1);
    }
    return { angle: angle, stops: stops };
  }

  /** What an element's transform does: rotation, scale, a flip, or that it is more than that. */
  function transformOf(cs) {
    var out = { simple: true, rotation: 0, scaleX: 1, scaleY: 1, flipH: false };
    var text = cs.transform;
    if (text && text !== "none") {
      var m = /^matrix\(([^)]+)\)$/.exec(text);
      if (!m) {
        out.simple = false;
        return out;
      }
      var v = m[1].split(",").map(function (n) { return num(n); });
      var det = v[0] * v[3] - v[1] * v[2];
      if (Math.abs(v[0] * v[2] + v[1] * v[3]) > 0.001 * Math.max(Math.abs(det), 0.001)) out.simple = false;
      out.flipH = det < 0;
      out.scaleX = Math.sqrt(v[0] * v[0] + v[1] * v[1]) * (out.flipH ? -1 : 1);
      out.scaleY = Math.sqrt(v[2] * v[2] + v[3] * v[3]);
      out.rotation = (Math.atan2(v[1], out.flipH ? -v[0] : v[0]) * 180) / Math.PI;
      out.scaleX = Math.abs(out.scaleX);
    }
    if (cs.rotate && cs.rotate !== "none") {
      var deg = /^(-?[\d.]+)deg$/.exec(cs.rotate);
      if (deg) out.rotation += num(deg[1]);
      else out.simple = false;
    }
    if (cs.scale && cs.scale !== "none") {
      var scales = cs.scale.trim().split(/\s+/);
      out.scaleX *= num(scales[0], 1);
      out.scaleY *= num(scales[1] === undefined ? scales[0] : scales[1], 1);
    }
    return out;
  }

  /** Whether a filter changes anything: entrance animations often end on `blur(0px)`. */
  function visibleFilter(text) {
    if (!text || text === "none") return false;
    return /\S/.test(text.replace(/blur\(0(px)?\)|(brightness|contrast|saturate|opacity)\(1\)|(grayscale|sepia|invert)\(0\)|hue-rotate\(0deg\)/g, ""));
  }

  function hasText(node) {
    return /\S/.test(node.textContent || "");
  }

  /** Whether a pseudo-element paints: `run` for plain in-flow text, `art` for anything else. */
  function pseudo(el, which) {
    var cs = getComputedStyle(el, which);
    if (!cs.content || cs.content === "none" || cs.content === "normal" || cs.display === "none") return null;
    var plain =
      color(cs.backgroundColor)[3] === 0 &&
      cs.backgroundImage === "none" &&
      (cs.position === "static" || !cs.position) &&
      !/\burl\(/.test(cs.content);
    if (plain && cs.borderTopStyle !== "none" && num(cs.borderTopWidth) > 0) plain = false;
    if (!plain) return "art";
    return /^["'][^]*["']$/.test(cs.content) && cs.content.length > 2 ? "run" : null;
  }

  function hasBox(cs) {
    return (
      color(cs.backgroundColor)[3] > 0 ||
      cs.backgroundImage !== "none" ||
      ["Top", "Right", "Bottom", "Left"].some(function (s) {
        return num(cs["border" + s + "Width"]) > 0 && cs["border" + s + "Style"] !== "none";
      })
    );
  }

  /** Whether `node` flows inside a line of text rather than standing on its own. */
  function isInline(node) {
    if (node.nodeType === 3) return true;
    if (node.nodeType !== 1) return false;
    var tag = node.tagName.toLowerCase();
    if (tag === "br") return true;
    if (tag === "img" || PICTURED[tag] || NEVER[tag]) return false;
    var cs = getComputedStyle(node);
    if (cs.position === "absolute" || cs.position === "fixed") return false;
    var d = cs.display;
    if (d === "inline") return true;
    return d === "inline-block" && !hasBox(cs);
  }

  /** How far an element's blur, shadows and 3D transform paint outside its box, in CSS pixels. */
  function effectReach(cs) {
    // WebKit can paint a 3D transform past the box it reports for it.
    var reach = /^matrix3d/.test(cs.transform || "") ? Math.max(num(cs.width), num(cs.height)) * 0.25 : 0;
    var blurs = (cs.filter || "").match(/-?[\d.]+px/g) || [];
    blurs.forEach(function (length) {
      reach = Math.max(reach, Math.abs(num(length)) * 3);
    });
    splitTop(cs.boxShadow && cs.boxShadow !== "none" ? cs.boxShadow : "").forEach(function (layer) {
      if (/\binset\b/.test(layer)) return;
      var total = 0;
      (layer.match(/-?[\d.]+px/g) || []).forEach(function (length) {
        total += Math.abs(num(length));
      });
      reach = Math.max(reach, total);
    });
    return reach;
  }

  /** `r` grown by `reach`, then cut to a `width` × `height` area. */
  function reachOf(r, reach, width, height) {
    var left = Math.max(r.x - reach, 0);
    var top = Math.max(r.y - reach, 0);
    var right = Math.min(r.x + r.w + reach, width);
    var bottom = Math.min(r.y + r.h + reach, height);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  /** A shot of `el` (or, `decor`, of its own box without its children) as a picture on the slide. */
  function addShot(el, decor, opaque, reach) {
    shots.push({ el: el, decor: !!decor, opaque: !!opaque, reach: reach || 0, slide: el.closest(".slide") });
    return shots.length - 1;
  }

  // ---- SVG as shapes: an inline <svg>, or the SVG a box stretches over itself as its background
  // (how the editor draws its figures), read into freeform shapes, lines and text boxes.

  /** Thrown inside an SVG that holds something PowerPoint cannot draw: it stays one picture. */
  var UNDRAWABLE = {};
  var SVG_UNSEEN = {
    defs: 1, title: 1, desc: 1, metadata: 1, style: 1, script: 1, symbol: 1, marker: 1, clippath: 1, mask: 1,
    lineargradient: 1, radialgradient: 1, pattern: 1, filter: 1, animate: 1, animatetransform: 1, animatemotion: 1, set: 1,
  };
  var SVG_GROUPS = { svg: 1, g: 1, a: 1 };
  var SVG_SHAPES = { path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1 };
  var SVG_PLACED = "[x], [y], [dx], [dy]";

  /** Matrices are `[a, b, c, d, e, f]`, as in CSS `matrix()`: `mul(m, n)` applies `n` first. */
  function mul(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5],
    ];
  }

  function invert(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    if (!det) throw UNDRAWABLE;
    return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
  }

  function at(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /** From `el`'s coordinates to the screen's. Engines differ on the page's own transforms here, so only two of these compared tell anything. */
  function matrixOf(el) {
    var m = el.getScreenCTM ? el.getScreenCTM() : null;
    if (!m) throw UNDRAWABLE;
    return [m.a, m.b, m.c, m.d, m.e, m.f];
  }

  /** What `m` does: its scales and turn, and whether that is all (`plain`: no skew, no mirror). */
  function spreadOf(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    var skewed = Math.abs(m[0] * m[2] + m[1] * m[3]) > 0.001 * Math.max(Math.abs(det), 1e-9);
    return {
      plain: !skewed && det > 0,
      sx: Math.sqrt(m[0] * m[0] + m[1] * m[1]),
      sy: Math.sqrt(m[2] * m[2] + m[3] * m[3]),
      scale: Math.sqrt(Math.abs(det)),
      rotation: (Math.atan2(m[1], m[0]) * 180) / Math.PI,
    };
  }

  /** An elliptical arc from (x0, y0) to (x, y) as cubic curves, added to `out`. */
  function arcTo(out, x0, y0, rx, ry, turn, large, sweep, x, y) {
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (x0 === x && y0 === y) return;
    if (!rx || !ry) {
      out.push(["L", x, y]);
      return;
    }
    var sin = Math.sin((turn * Math.PI) / 180);
    var cos = Math.cos((turn * Math.PI) / 180);
    var hx = (x0 - x) / 2;
    var hy = (y0 - y) / 2;
    var x1 = cos * hx + sin * hy;
    var y1 = -sin * hx + cos * hy;
    var over = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
    if (over > 1) {
      rx *= Math.sqrt(over);
      ry *= Math.sqrt(over);
    }
    var under = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    var k = Math.sqrt(Math.max(rx * rx * ry * ry - under, 0) / under) * (!!large === !!sweep ? -1 : 1);
    var cx1 = (k * rx * y1) / ry;
    var cy1 = (-k * ry * x1) / rx;
    var cx = cos * cx1 - sin * cy1 + (x0 + x) / 2;
    var cy = sin * cx1 + cos * cy1 + (y0 + y) / 2;
    var from = Math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx);
    var sweepBy = Math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx) - from;
    if (sweep && sweepBy < 0) sweepBy += 2 * Math.PI;
    else if (!sweep && sweepBy > 0) sweepBy -= 2 * Math.PI;
    var count = Math.max(1, Math.ceil(Math.abs(sweepBy) / (Math.PI / 2) - 1e-9));
    var step = sweepBy / count;
    var handle = (4 / 3) * Math.tan(step / 4);
    var place = function (u, v) {
      return [cx + cos * rx * u - sin * ry * v, cy + sin * rx * u + cos * ry * v];
    };
    for (var i = 0; i < count; i++) {
      var a = from + i * step;
      var b = a + step;
      var c1 = place(Math.cos(a) - handle * Math.sin(a), Math.sin(a) + handle * Math.cos(a));
      var c2 = place(Math.cos(b) + handle * Math.sin(b), Math.sin(b) - handle * Math.cos(b));
      var end = i === count - 1 ? [x, y] : place(Math.cos(b), Math.sin(b));
      out.push(["C", c1[0], c1[1], c2[0], c2[1], end[0], end[1]]);
    }
  }

  /**
   * Path data as absolute `["M", x, y]`, `["L", x, y]`, `["C", x1, y1, x2, y2, x, y]` and `["Z"]`:
   * all PowerPoint needs. As a browser does, it stops at the first thing it cannot read.
   */
  function pathSegments(d) {
    var NUMBER = /[\s,]*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
    var FLAG = /[\s,]*([01])/g;
    var SPACE = /[\s,]*/g;
    var out = [];
    var i = 0;
    var bad = false;
    var read = function (pattern) {
      pattern.lastIndex = i;
      var m = pattern.exec(d);
      if (!m || m.index !== i) {
        bad = true;
        return 0;
      }
      i = pattern.lastIndex;
      return parseFloat(m[1]);
    };
    var cmd = "";
    var x = 0;
    var y = 0;
    var startX = 0;
    var startY = 0;
    // The last curve's control point, which a smooth curve mirrors.
    var ctrlX = 0;
    var ctrlY = 0;
    var last = "";
    for (;;) {
      SPACE.lastIndex = i;
      SPACE.exec(d);
      i = SPACE.lastIndex;
      if (i >= d.length) break;
      var named = /[a-zA-Z]/.test(d.charAt(i));
      if (named) cmd = d.charAt(i++);
      var c = cmd.toUpperCase();
      if (!cmd || (c === "Z" && !named) || (!out.length && c !== "M")) break;
      var bx = cmd === c ? 0 : x;
      var by = cmd === c ? 0 : y;
      var before = out.length;
      var px = x;
      var py = y;
      var kind = "";
      if (c === "Z") {
        out.push(["Z"]);
        x = startX;
        y = startY;
      } else if (c === "M" || c === "L") {
        x = bx + read(NUMBER);
        y = by + read(NUMBER);
        out.push([c, x, y]);
        if (c === "M") {
          startX = x;
          startY = y;
          cmd = cmd === "M" ? "L" : "l";
        }
      } else if (c === "H") {
        x = bx + read(NUMBER);
        out.push(["L", x, y]);
      } else if (c === "V") {
        y = by + read(NUMBER);
        out.push(["L", x, y]);
      } else if (c === "C" || c === "S") {
        var x1 = c === "C" ? bx + read(NUMBER) : last === "C" ? 2 * x - ctrlX : x;
        var y1 = c === "C" ? by + read(NUMBER) : last === "C" ? 2 * y - ctrlY : y;
        ctrlX = bx + read(NUMBER);
        ctrlY = by + read(NUMBER);
        x = bx + read(NUMBER);
        y = by + read(NUMBER);
        out.push(["C", x1, y1, ctrlX, ctrlY, x, y]);
        kind = "C";
      } else if (c === "Q" || c === "T") {
        ctrlX = c === "Q" ? bx + read(NUMBER) : last === "Q" ? 2 * x - ctrlX : x;
        ctrlY = c === "Q" ? by + read(NUMBER) : last === "Q" ? 2 * y - ctrlY : y;
        x = bx + read(NUMBER);
        y = by + read(NUMBER);
        out.push(["C", px + (2 / 3) * (ctrlX - px), py + (2 / 3) * (ctrlY - py), x + (2 / 3) * (ctrlX - x), y + (2 / 3) * (ctrlY - y), x, y]);
        kind = "Q";
      } else if (c === "A") {
        var rx = read(NUMBER);
        var ry = read(NUMBER);
        var turn = read(NUMBER);
        var large = read(FLAG);
        var sweep = read(FLAG);
        x = bx + read(NUMBER);
        y = by + read(NUMBER);
        if (!bad) arcTo(out, px, py, rx, ry, turn, large, sweep, x, y);
      } else {
        bad = true;
      }
      if (bad) {
        out.length = before;
        break;
      }
      last = kind;
    }
    return out;
  }

  function ellipseSegments(cx, cy, rx, ry) {
    var k = 0.5522847498;
    return [
      ["M", cx + rx, cy],
      ["C", cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
      ["C", cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
      ["C", cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
      ["C", cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy],
      ["Z"],
    ];
  }

  function rectSegments(x, y, w, h, rx, ry) {
    if (!rx || !ry) return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
    var corner = function (ex, ey) {
      return "A" + [rx, ry, 0, 0, 1, ex, ey].join(" ");
    };
    return pathSegments(
      "M" + (x + rx) + " " + y + "H" + (x + w - rx) + corner(x + w, y + ry) + "V" + (y + h - ry) + corner(x + w - rx, y + h) +
        "H" + (x + rx) + corner(x, y + h - ry) + "V" + (y + ry) + corner(x + rx, y) + "Z",
    );
  }

  /** A length attribute of an SVG shape in its own units: the browser's reading of it, units and all. */
  function lengthOf(el, name) {
    var value = el[name] && el[name].baseVal ? el[name].baseVal.value : NaN;
    return isFinite(value) ? value : num(el.getAttribute(name));
  }

  /** The corner radii a `<rect>` is drawn with. */
  function cornersOf(el) {
    var given = function (name) {
      var text = el.getAttribute(name);
      return text !== null && text !== "" && text !== "auto";
    };
    var rx = given("rx") ? lengthOf(el, "rx") : given("ry") ? lengthOf(el, "ry") : 0;
    var ry = given("ry") ? lengthOf(el, "ry") : rx;
    return [Math.min(Math.max(rx, 0), lengthOf(el, "width") / 2), Math.min(Math.max(ry, 0), lengthOf(el, "height") / 2)];
  }

  /** The outline of an SVG shape, in its own coordinates. */
  function shapeSegments(el, tag) {
    if (tag === "path") return pathSegments(el.getAttribute("d") || "");
    if (tag === "rect") {
      var corners = cornersOf(el);
      var w = lengthOf(el, "width");
      var h = lengthOf(el, "height");
      return w > 0 && h > 0 ? rectSegments(lengthOf(el, "x"), lengthOf(el, "y"), w, h, corners[0], corners[1]) : [];
    }
    if (tag === "circle" || tag === "ellipse") {
      var rx = lengthOf(el, tag === "circle" ? "r" : "rx");
      var ry = lengthOf(el, tag === "circle" ? "r" : "ry");
      return rx > 0 && ry > 0 ? ellipseSegments(lengthOf(el, "cx"), lengthOf(el, "cy"), rx, ry) : [];
    }
    if (tag === "line") return [["M", lengthOf(el, "x1"), lengthOf(el, "y1")], ["L", lengthOf(el, "x2"), lengthOf(el, "y2")]];
    var numbers = ((el.getAttribute("points") || "").match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
    var out = [];
    for (var i = 0; i + 1 < numbers.length; i += 2) out.push([i ? "L" : "M", numbers[i], numbers[i + 1]]);
    if (tag === "polygon" && out.length) out.push(["Z"]);
    return out;
  }

  /** The box `segments` fill, curves measured where they turn. */
  function extentOf(segments) {
    var low = [Infinity, Infinity];
    var high = [-Infinity, -Infinity];
    var add = function (axis, value) {
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    };
    var here = [0, 0];
    var start = [0, 0];
    segments.forEach(function (s) {
      if (s[0] === "Z") {
        here = start;
        return;
      }
      var end = [s[s.length - 2], s[s.length - 1]];
      if (s[0] === "M") start = end;
      if (s[0] === "C") {
        [0, 1].forEach(function (axis) {
          var p0 = here[axis];
          var p1 = s[1 + axis];
          var p2 = s[3 + axis];
          var p3 = end[axis];
          var a = -p0 + 3 * p1 - 3 * p2 + p3;
          var b = 2 * (p0 - 2 * p1 + p2);
          var c = p1 - p0;
          var turns = [];
          var inside = b * b - 4 * a * c;
          if (Math.abs(a) < 1e-9) {
            if (Math.abs(b) > 1e-9) turns.push(-c / b);
          } else if (inside >= 0) {
            turns.push((-b + Math.sqrt(inside)) / (2 * a), (-b - Math.sqrt(inside)) / (2 * a));
          }
          turns.forEach(function (t) {
            if (!(t > 0 && t < 1)) return;
            var u = 1 - t;
            add(axis, u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3);
          });
        });
      }
      add(0, end[0]);
      add(1, end[1]);
      here = end;
    });
    if (low[0] === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: low[0], y: low[1], w: high[0] - low[0], h: high[1] - low[1] };
  }

  /** `segments` drawn through `m`. */
  function mapSegments(segments, m) {
    return segments.map(function (s) {
      var out = [s[0]];
      for (var i = 1; i < s.length; i += 2) {
        var p = at(m, s[i], s[i + 1]);
        out.push(p[0], p[1]);
      }
      return out;
    });
  }

  /** `segments` as text, measured from (x, y): what the app reads back (pptx/export/write.rs). */
  function pathText(segments, x, y) {
    return segments
      .map(function (s) {
        var text = s[0];
        for (var i = 1; i < s.length; i += 2) {
          text += " " + Math.round((s[i] - x) * 100) / 100 + " " + Math.round((s[i + 1] - y) * 100) / 100;
        }
        return text;
      })
      .join(" ");
  }

  /** Whether a property that is `none` unless used is used. */
  function isSet(text) {
    return !!text && !/^none\b/.test(text);
  }

  /** An SVG paint: null for none, a colour, or the id of what it refers to. */
  function paintOf(text) {
    if (!isSet(text)) return null;
    var ref = /^url\(["']?[^"')]*#([^"')]+)["']?\)/.exec(text);
    return ref ? { ref: ref[1] } : { color: color(text) };
  }

  /** The element `id` names for the SVG `root`: one of its own first, as an SVG in an image has only those. */
  function named(root, id) {
    var found = null;
    Array.prototype.some.call(root.querySelectorAll("[id]"), function (el) {
      if (el.id === id) found = el;
      return !!found;
    });
    return found || document.getElementById(id);
  }

  /**
   * The fill a `<linearGradient>` gives a shape whose own box is `local`, drawn through `m` into
   * `frame`. PowerPoint's gradients span the frame, so the stops move to where they fall on it.
   */
  function gradientFill(root, id, local, m, frame, alpha) {
    var g = named(root, id);
    if (!g || g.tagName.toLowerCase() !== "lineargradient") throw UNDRAWABLE;
    var holder = g;
    for (var hop = 0; hop < 4 && !holder.querySelector("stop"); hop++) {
      var href = holder.getAttribute("href") || holder.getAttribute("xlink:href") || "";
      var next = href.charAt(0) === "#" ? named(root, href.slice(1)) : null;
      if (!next) break;
      holder = next;
    }
    var stops = Array.prototype.map.call(holder.querySelectorAll("stop"), function (stop) {
      var cs = getComputedStyle(stop);
      var c = color(cs.stopColor || "rgb(0, 0, 0)");
      var offset = stop.getAttribute("offset") || "0";
      return {
        color: [c[0], c[1], c[2], c[3] * num(cs.stopOpacity, 1) * alpha],
        at: Math.min(Math.max(/%$/.test(offset) ? num(offset) / 100 : num(offset), 0), 1),
      };
    });
    if (!stops.length) return null;
    if (stops.length === 1) return { color: stops[0].color };
    var user = g.getAttribute("gradientUnits") === "userSpaceOnUse";
    var coord = function (name, fallback) {
      var text = g.getAttribute(name);
      // In the drawing's own units, a percentage is one of its viewport: not worth the reading.
      if (user && (text === null ? fallback : /%$/.test(text))) throw UNDRAWABLE;
      if (text === null || text === "") return fallback;
      return /%$/.test(text) ? num(text) / 100 : num(text);
    };
    var ends = [[coord("x1", 0), coord("y1", 0)], [coord("x2", 1), coord("y2", 0)]];
    if (g.hasAttribute("gradientTransform")) {
      var list = g.gradientTransform && g.gradientTransform.baseVal;
      if (!list) throw UNDRAWABLE;
      var whole = list.numberOfItems ? list.consolidate().matrix : null;
      if (whole) {
        ends = ends.map(function (p) {
          return at([whole.a, whole.b, whole.c, whole.d, whole.e, whole.f], p[0], p[1]);
        });
      }
    }
    ends = ends.map(function (p) {
      return user ? at(m, p[0], p[1]) : at(m, local.x + p[0] * local.w, local.y + p[1] * local.h);
    });
    var dx = ends[1][0] - ends[0][0];
    var dy = ends[1][1] - ends[0][1];
    var length = Math.sqrt(dx * dx + dy * dy);
    var reach = length ? Math.abs((frame.w * dx) / length) + Math.abs((frame.h * dy) / length) : 0;
    if (!reach) return { color: stops[stops.length - 1].color };
    var fromX = frame.x + frame.w / 2 - (dx / length) * (reach / 2);
    var fromY = frame.y + frame.h / 2 - (dy / length) * (reach / 2);
    var first = ((ends[0][0] - fromX) * dx + (ends[0][1] - fromY) * dy) / length / reach;
    var last = 0;
    stops.forEach(function (stop) {
      last = stop.at = Math.max(last, Math.min(Math.max(first + (stop.at * length) / reach, 0), 1));
    });
    return { gradient: { angle: (Math.atan2(dy, dx) * 180) / Math.PI + 90, stops: stops } };
  }

  /** The outline `cs` strokes with, `scale` canvas pixels to its unit; `inner` when only its inner half shows. */
  function strokeOf(cs, scale, alpha, inner) {
    var paint = paintOf(cs.stroke);
    var own = num(cs.strokeWidth, 1);
    if (!paint || own <= 0) return null;
    if (paint.ref) throw UNDRAWABLE;
    var c = paint.color;
    var a = c[3] * num(cs.strokeOpacity, 1) * alpha;
    if (a <= 0) return null;
    var dashes = isSet(cs.strokeDasharray) ? cs.strokeDasharray.split(/[\s,]+/).map(function (n) { return num(n); }) : null;
    var dotted = dashes && (dashes[0] <= own * 1.2 || (dashes[0] < dashes[1] && dashes[0] <= own * 3));
    return {
      color: [c[0], c[1], c[2], a],
      width: own * scale * (inner ? 0.5 : 1),
      dash: dashes && dashes[0] > 0 ? (dotted ? "dotted" : "dashed") : null,
      cap: cs.strokeLinecap || null,
      join: cs.strokeLinejoin || null,
    };
  }

  /** PowerPoint's arrowhead for the `<marker>` a line's end names: its kind and size, by eye. */
  function arrowOf(root, text, width) {
    var paint = paintOf(text);
    var marker = paint && paint.ref ? named(root, paint.ref) : null;
    if (!marker) return null;
    var size = num(marker.getAttribute("markerWidth"), 3) / (marker.getAttribute("markerUnits") === "userSpaceOnUse" ? width || 1 : 1);
    return { kind: marker.querySelector("circle, ellipse") ? "oval" : "triangle", size: size < 2.5 ? "sm" : size < 4.5 ? "med" : "lg" };
  }

  /**
   * Whether `node`'s clip is its own outline, which leaves the inner half of its stroke: how an
   * outline is kept inside a shape (the editor's figures). Any other clip PowerPoint cannot make.
   */
  function clippedToItself(node, tag, cs, root) {
    var ref = paintOf(cs.clipPath);
    var clip = ref && ref.ref ? named(root, ref.ref) : null;
    var only = clip && clip.children.length === 1 ? clip.children[0] : null;
    if (tag !== "path" || !only || only.tagName.toLowerCase() !== "path" || only.hasAttribute("transform")) return false;
    var own = (node.getAttribute("d") || "").trim();
    var cut = (only.getAttribute("d") || "").trim();
    return !!cut && (own === cut || own.indexOf(cut + " ") === 0);
  }

  /** The box an item covers on the slide, turned as it is. */
  function boundsOf(item) {
    var turn = ((item.rotation || 0) * Math.PI) / 180;
    var cos = Math.abs(Math.cos(turn));
    var sin = Math.abs(Math.sin(turn));
    var w = item.w * cos + item.h * sin;
    var h = item.w * sin + item.h * cos;
    return { x: item.x + item.w / 2 - w / 2, y: item.y + item.h / 2 - h / 2, w: w, h: h };
  }

  /** One SVG shape as a box (a plain rectangle or ellipse) or a freeform. */
  function svgShape(node, tag, cs, s, alpha, clipped, out) {
    var inner = clipped && clippedToItself(node, tag, cs, s.root);
    if (clipped && !inner) throw UNDRAWABLE;
    var local = shapeSegments(node, tag);
    if (local.length < 2) return;
    var m = s.to(node);
    var spread = spreadOf(m);
    var own = extentOf(local);
    var corners = tag === "rect" ? cornersOf(node) : [0, 0];
    var even = Math.abs(spread.sx - spread.sy) <= 0.01 * spread.sx;
    var asBox =
      spread.plain &&
      (tag === "circle" || tag === "ellipse" || (tag === "rect" && (!corners[0] || (even && Math.abs(corners[0] - corners[1]) < 0.01))));
    // A box turns with its fill, so its gradient is read before the turn.
    var through = asBox ? [spread.sx, 0, 0, spread.sy, 0, 0] : m;
    var drawn = asBox ? null : mapSegments(local, m);
    var frame = asBox ? { x: own.x * spread.sx, y: own.y * spread.sy, w: own.w * spread.sx, h: own.h * spread.sy } : extentOf(drawn);
    var paint = tag === "line" ? null : paintOf(cs.fill);
    var fillAlpha = alpha * num(cs.fillOpacity, 1);
    var fill = null;
    if (paint && paint.ref) fill = gradientFill(s.root, paint.ref, own, through, frame, fillAlpha);
    else if (paint && paint.color[3] * fillAlpha > 0) fill = { color: [paint.color[0], paint.color[1], paint.color[2], paint.color[3] * fillAlpha] };
    var border = strokeOf(cs, spread.scale, alpha, inner);
    if (isSet(cs.markerMid)) throw UNDRAWABLE;
    if (isSet(cs.markerStart) || isSet(cs.markerEnd)) {
      var open = tag === "line" || tag === "polyline" || (tag === "path" && local[local.length - 1][0] !== "Z");
      if (!open || !border) throw UNDRAWABLE;
      border.head = arrowOf(s.root, cs.markerStart, num(cs.strokeWidth, 1));
      border.tail = arrowOf(s.root, cs.markerEnd, num(cs.strokeWidth, 1));
    }
    if (!fill && !border) return;
    if (asBox) {
      var centre = at(m, own.x + own.w / 2, own.y + own.h / 2);
      out.push({
        kind: "box",
        x: centre[0] - frame.w / 2,
        y: centre[1] - frame.h / 2,
        w: frame.w,
        h: frame.h,
        rotation: spread.rotation,
        fill: fill,
        border: border,
        radius: corners[0] * spread.sx,
        ellipse: tag !== "rect",
        opacity: 1,
      });
      return;
    }
    var item = { kind: "path", x: frame.x, y: frame.y, w: frame.w, h: frame.h, d: pathText(drawn, frame.x, frame.y), fill: fill, border: border };
    // An outline drawn as a second copy of the shape it goes around: one shape in PowerPoint.
    var under = out[out.length - 1];
    var same = under && under.kind === "path" && under.d === item.d && Math.abs(under.x - item.x) < 0.01 && Math.abs(under.y - item.y) < 0.01;
    if (same && !under.border && !fill) under.border = border;
    else out.push(item);
  }

  /** The runs of SVG text in `node`, `scale` canvas pixels to its unit. */
  function svgRuns(node, scale, alpha, runs) {
    if (node.nodeType === 3) {
      var cs = getComputedStyle(node.parentElement);
      var paint = paintOf(cs.fill);
      if (paint && paint.ref) throw UNDRAWABLE;
      var ink = paint ? paint.color : [0, 0, 0, 0];
      var lines = cs.textDecorationLine || cs.textDecoration || "";
      var spacing = cs.letterSpacing;
      runs.push({
        text: node.nodeValue.replace(/\s+/g, " "),
        font: splitTop(cs.fontFamily || "")[0].replace(/^["']|["']$/g, ""),
        size: num(cs.fontSize, 16) * scale,
        bold: num(cs.fontWeight, 400) >= 600 || cs.fontWeight === "bold",
        italic: cs.fontStyle === "italic" || /^oblique/.test(cs.fontStyle || ""),
        underline: /underline/.test(lines),
        strike: /line-through/.test(lines),
        color: [ink[0], ink[1], ink[2], ink[3] * num(cs.fillOpacity, 1) * alpha],
        spacing: !spacing || spacing === "normal" ? 0 : num(spacing) * scale,
        highlight: null,
        baseline: 0,
        link: null,
      });
      return;
    }
    if (node.nodeType !== 1) return;
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType !== 1) {
        svgRuns(child, scale, alpha, runs);
        return;
      }
      var tag = child.tagName.toLowerCase();
      var cs = getComputedStyle(child);
      if (SVG_UNSEEN[tag] || cs.display === "none") return;
      if (tag !== "tspan" && tag !== "a") throw UNDRAWABLE;
      svgRuns(child, scale, alpha * num(cs.opacity, 1), runs);
    });
  }

  /** The box the characters of `el`, a part of an SVG text, are drawn in, in the text's coordinates. */
  function charsBox(el) {
    var count = el.getNumberOfChars();
    var box = null;
    for (var i = 0; i < count; i++) {
      var r = el.getExtentOfChar(i);
      if (!box) box = { x: r.x, y: r.y, right: r.x + r.width, bottom: r.y + r.height };
      box.x = Math.min(box.x, r.x);
      box.y = Math.min(box.y, r.y);
      box.right = Math.max(box.right, r.x + r.width);
      box.bottom = Math.max(box.bottom, r.y + r.height);
    }
    return box && { x: box.x, y: box.y, width: box.right - box.x, height: box.bottom - box.y };
  }

  /** SVG text as text boxes where the browser drew it: one, or one for each line placed on its own. */
  function svgText(node, cs, s, alpha, out) {
    var flows = node.querySelector("textPath") || node.hasAttribute("rotate") || node.hasAttribute("textLength");
    if (flows || /^(vertical|sideways|tb)/.test(cs.writingMode || "")) throw UNDRAWABLE;
    ["x", "y", "dx", "dy"].forEach(function (name) {
      // A list of them places each letter.
      if (/[\s,]/.test((node.getAttribute(name) || "").trim())) throw UNDRAWABLE;
    });
    var m = s.to(node);
    var spread = spreadOf(m);
    if (!spread.plain) throw UNDRAWABLE;
    var part = function (el, box) {
      var runs = [];
      svgRuns(el, spread.scale, alpha, runs);
      runs = tidy(runs).filter(function (run) { return run.color[3] > 0; });
      if (!box || !(box.width > 0) || !runs.some(function (run) { return run.text; })) return;
      var centre = at(m, box.x + box.width / 2, box.y + box.height / 2);
      var w = box.width * spread.sx;
      var h = box.height * spread.sy;
      var anchor = getComputedStyle(el).textAnchor;
      out.push({
        kind: "text",
        x: centre[0] - w / 2,
        y: centre[1] - h / 2,
        w: w,
        h: h,
        rotation: spread.rotation,
        wrap: false,
        paragraphs: [{ align: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left", lineHeight: null, runs: runs }],
      });
    };
    if (!node.querySelector(SVG_PLACED)) {
      part(node, node.getBBox());
      return;
    }
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType !== 1) {
        if (child.nodeType === 3 && hasText(child)) throw UNDRAWABLE;
        return;
      }
      if (child.tagName.toLowerCase() !== "tspan" || child.querySelector(SVG_PLACED)) throw UNDRAWABLE;
      if (getComputedStyle(child).display !== "none") part(child, charsBox(child));
    });
  }

  /** Adds what `node` of an SVG draws to `out`. */
  function svgNode(node, s, alpha, out) {
    var tag = node.tagName.toLowerCase();
    if (SVG_UNSEEN[tag]) return;
    var cs = getComputedStyle(node);
    if (cs.display === "none") return;
    alpha *= num(cs.opacity, 1);
    if (alpha < 0.004) return;
    var masked = isSet(cs.mask) || isSet(cs.maskImage) || isSet(cs.webkitMaskImage);
    if (visibleFilter(cs.filter) || masked || (cs.mixBlendMode && cs.mixBlendMode !== "normal")) throw UNDRAWABLE;
    var clipped = isSet(cs.clipPath);
    if (SVG_GROUPS[tag]) {
      if (clipped) throw UNDRAWABLE;
      Array.prototype.forEach.call(node.children, function (child) {
        svgNode(child, s, alpha, out);
      });
      return;
    }
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return;
    if (tag === "text" && !clipped) svgText(node, cs, s, alpha, out);
    else if (SVG_SHAPES[tag]) svgShape(node, tag, cs, s, alpha, clipped, out);
    else throw UNDRAWABLE;
  }

  /** From the coordinates of what `<svg>` `el` holds to the slide's, for its viewport `area`. */
  function viewOf(el, area, scale) {
    var box = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (box.length !== 4 || box.some(isNaN) || !(box[2] > 0) || !(box[3] > 0)) return [scale, 0, 0, scale, area.x, area.y];
    var fit = (el.getAttribute("preserveAspectRatio") || "").trim();
    var sx = area.w / box[2];
    var sy = area.h / box[3];
    if (!/^none/.test(fit)) sx = sy = /slice/.test(fit) ? Math.max(sx, sy) : Math.min(sx, sy);
    var ax = /xMin/.test(fit) ? 0 : /xMax/.test(fit) ? 1 : 0.5;
    var ay = /YMin/.test(fit) ? 0 : /YMax/.test(fit) ? 1 : 0.5;
    return [sx, 0, 0, sy, area.x + (area.w - box[2] * sx) * ax - box[0] * sx, area.y + (area.h - box[3] * sy) * ay - box[1] * sy];
  }

  /**
   * What `<svg>` `el` draws into `area` of the slide, `scale` canvas pixels to its CSS pixel, then
   * turned, mirrored or scaled by `turn` (`[a, b, c, d]`, or null) about `about`. Null when
   * PowerPoint cannot draw all of it.
   */
  function drawingOf(el, area, scale, alpha, turn, about) {
    try {
      var view = viewOf(el, area, scale);
      if (turn) {
        view = mul([1, 0, 0, 1, about[0], about[1]], mul([turn[0], turn[1], turn[2], turn[3], 0, 0], mul([1, 0, 0, 1, -about[0], -about[1]], view)));
      }
      var back = mul(view, invert(matrixOf(el)));
      var s = {
        root: el,
        to: function (node) {
          return mul(back, matrixOf(node));
        },
      };
      var out = [];
      Array.prototype.forEach.call(el.children, function (child) {
        svgNode(child, s, alpha, out);
      });
      return out;
    } catch (e) {
      return null;
    }
  }

  /** The SVG a CSS image holds in a `url("data:image/svg+xml,…")`, or "". */
  function svgIn(image) {
    var m = /^url\(\s*["']?data:image\/svg\+xml((?:;[^,;]*)*),([^]*?)["']?\s*\)$/.exec((image || "").trim());
    if (!m) return "";
    try {
      var data = m[2].replace(/\\(["'\\])/g, "$1");
      return /;base64/i.test(m[1]) ? atob(data) : decodeURIComponent(data);
    } catch (e) {
      return "";
    }
  }

  /**
   * What the SVG `text`, an image stretched over `area`, draws there. Its shapes are measured with
   * it in the page for a moment: out of reach of the deck's styles, and without anything in it
   * that could run there, as nothing in an image does.
   */
  function imageDrawing(text, slide, area, scale, alpha, turn, about) {
    var parsed = null;
    try {
      parsed = new DOMParser().parseFromString(text, "image/svg+xml").documentElement;
    } catch (e) {
      return null;
    }
    if (!parsed || parsed.tagName.toLowerCase() !== "svg" || !document.body.attachShadow) return null;
    var all = [parsed].concat(Array.prototype.slice.call(parsed.querySelectorAll("*")));
    if (all.some(function (el) { return /^(script|style|foreignobject|image|use)$/.test(el.tagName.toLowerCase()); })) return null;
    all.forEach(function (el) {
      Array.prototype.slice.call(el.attributes).forEach(function (attr) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      });
    });
    var holder = document.createElement("div");
    holder.style.cssText =
      "all: initial; position: absolute; left: 0; top: 0; pointer-events: none; width: " + area.w / scale + "px; height: " + area.h / scale + "px";
    var svg = document.importNode(parsed, true);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    holder.attachShadow({ mode: "open" }).appendChild(svg);
    slide.appendChild(holder);
    try {
      return drawingOf(svg, area, scale, alpha, turn, about);
    } finally {
      slide.removeChild(holder);
    }
  }

  /** The scan of one slide. */
  function Scanner(slide) {
    var box = slide.getBoundingClientRect();
    this.left = box.left;
    this.top = box.top;
    this.width = slide.offsetWidth || box.width;
    this.height = slide.offsetHeight || box.height;
    this.ratio = box.width > 0 && this.width > 0 ? box.width / this.width : 1;
    this.items = [];
  }

  /** A viewport rectangle in canvas pixels. */
  Scanner.prototype.rect = function (r) {
    return {
      x: (r.left - this.left) / this.ratio,
      y: (r.top - this.top) / this.ratio,
      w: r.width / this.ratio,
      h: r.height / this.ratio,
    };
  };

  Scanner.prototype.off = function (r) {
    return r.x + r.w <= 0 || r.y + r.h <= 0 || r.x >= this.width || r.y >= this.height;
  };

  Scanner.prototype.push = function (item, ctx) {
    item.z = ctx.z;
    this.items.push(item);
  };

  Scanner.prototype.shot = function (el, r, ctx, decor) {
    var reach = effectReach(getComputedStyle(el));
    var c = reachOf(r, reach, this.width, this.height);
    this.push({ kind: "shot", shot: addShot(el, decor, false, reach), x: c.x, y: c.y, w: c.w, h: c.h }, ctx);
  };

  /** A rectangle for `el` before rotation: the same centre, its layout size. */
  function unrotated(el, r, t, ctx) {
    if (!t.rotation) return r;
    var w = (el.offsetWidth || r.w) * t.scaleX * ctx.scale;
    var h = (el.offsetHeight || r.h) * t.scaleY * ctx.scale;
    return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w: w, h: h };
  }

  /** The border to draw around the box, when all its sides agree. */
  function uniformBorder(cs) {
    return ["Right", "Bottom", "Left"].every(function (s) {
      return (
        cs["border" + s + "Width"] === cs.borderTopWidth &&
        cs["border" + s + "Style"] === cs.borderTopStyle &&
        cs["border" + s + "Color"] === cs.borderTopColor
      );
    });
  }

  function firstShadow(text) {
    if (!text || text === "none") return null;
    var layers = splitTop(text);
    for (var i = 0; i < layers.length; i++) {
      var layer = layers[i];
      if (/\binset\b/.test(layer)) continue;
      var colorText = /(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+\([^)]*\))/i.exec(layer);
      var rest = layer.replace(colorText ? colorText[0] : "", "");
      var lengths = rest.match(/-?[\d.]+px/g) || [];
      if (lengths.length < 2) continue;
      return {
        color: color(colorText ? colorText[0] : "rgb(0, 0, 0)"),
        x: num(lengths[0]),
        y: num(lengths[1]),
        blur: num(lengths[2]),
      };
    }
    return null;
  }

  function radiusOf(cs, r) {
    var corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
    var same = corners.every(function (c) { return c === corners[0]; });
    var text = (corners[0] || "0px").split(" ")[0];
    var value = /%$/.test(text) ? (num(text) / 100) * Math.min(r.w, r.h) : num(text);
    return { same: same, value: value, percent: /%$/.test(text) ? num(text) : null };
  }

  /** Paints `el`'s own box. False if PowerPoint cannot, and a shot of it is needed. */
  Scanner.prototype.box = function (el, cs, r, t, ctx) {
    var clipped = /text/.test(cs.webkitBackgroundClip || cs.backgroundClip || "");
    var fill = null;
    var image = null;
    var art = null;
    var bg = color(cs.backgroundColor);
    if (!clipped && cs.backgroundImage && cs.backgroundImage !== "none") {
      var layers = splitTop(cs.backgroundImage);
      if (layers.length > 1) return false;
      var g = gradient(layers[0]);
      var url = /^url\("?([^")]+)"?\)$/.exec(layers[0]);
      var file = url && url[1].replace(location.href.replace(/[^/]*$/, ""), "");
      if (g) fill = { gradient: g };
      else if (url && IMAGE_FILE.test(file) && /cover|100%/.test(cs.backgroundSize || "")) image = file;
      else if (!(art = this.backdrop(el, layers[0], cs, r, t, ctx))) return false;
      if (art && bg[3] > 0) fill = { color: bg };
    } else if (!clipped && bg[3] > 0) {
      fill = { color: bg };
    }
    var radius = radiusOf(cs, r);
    var border = null;
    var borderWidth = num(cs.borderTopWidth);
    var uniform = uniformBorder(cs);
    if (uniform && borderWidth > 0 && cs.borderTopStyle !== "none" && color(cs.borderTopColor)[3] > 0) {
      border = {
        color: color(cs.borderTopColor),
        width: borderWidth * ctx.scale,
        dash: /dash|dot/.test(cs.borderTopStyle) ? cs.borderTopStyle : null,
      };
    }
    if (!uniform && !radius.same) return false;
    if (image) {
      this.push({ kind: "image", src: image, x: r.x, y: r.y, w: r.w, h: r.h, rotation: t.rotation, opacity: ctx.opacity }, ctx);
      fill = null;
    }
    var shadow = firstShadow(cs.boxShadow);
    if (fill || border || shadow) {
      if (radius.same || !radius.value) {
        var ellipse = radius.percent !== null && radius.percent >= 50;
        this.push(
          {
            kind: "box",
            x: r.x + (border ? borderWidth / 2 : 0) * ctx.scale,
            y: r.y + (border ? borderWidth / 2 : 0) * ctx.scale,
            w: r.w - (border ? borderWidth : 0) * ctx.scale,
            h: r.h - (border ? borderWidth : 0) * ctx.scale,
            rotation: t.rotation,
            fill: fill,
            border: border,
            shadow: shadow,
            radius: ellipse ? 0 : radius.value * ctx.scale,
            ellipse: ellipse,
            opacity: ctx.opacity,
          },
          ctx,
        );
      } else return false;
    }
    if (art) this.group(art, ctx);
    if (!uniform) {
      // A rule along one side: a thin box of its own.
      var self = this;
      [
        ["Top", r.x, r.y, r.w, num(cs.borderTopWidth)],
        ["Bottom", r.x, r.y + r.h - num(cs.borderBottomWidth), r.w, num(cs.borderBottomWidth)],
        ["Left", r.x, r.y, num(cs.borderLeftWidth), r.h],
        ["Right", r.x + r.w - num(cs.borderRightWidth), r.y, num(cs.borderRightWidth), r.h],
      ].forEach(function (s) {
        var c = color(cs["border" + s[0] + "Color"]);
        if (cs["border" + s[0] + "Style"] === "none" || c[3] === 0 || s[3] <= 0 || s[4] <= 0) return;
        self.push({ kind: "box", x: s[1], y: s[2], w: s[3], h: s[4], rotation: 0, fill: { color: c }, radius: 0, opacity: ctx.opacity }, ctx);
      });
    }
    return true;
  };

  /** `items` drawn from one SVG, kept together as a group. */
  Scanner.prototype.group = function (items, ctx) {
    if (items.length < 2) {
      if (items.length) this.push(items[0], ctx);
      return;
    }
    var left = Infinity;
    var top = Infinity;
    var right = -Infinity;
    var bottom = -Infinity;
    items.forEach(function (item) {
      var b = boundsOf(item);
      left = Math.min(left, b.x);
      top = Math.min(top, b.y);
      right = Math.max(right, b.x + b.w);
      bottom = Math.max(bottom, b.y + b.h);
    });
    this.push({ kind: "group", x: left, y: top, w: right - left, h: bottom - top, items: items }, ctx);
  };

  /**
   * The shapes of the SVG a box stretches over itself as its background, the way the editor
   * draws a figure, with the shadow it keeps in a second SVG around it. Null if it stays a picture.
   */
  Scanner.prototype.backdrop = function (el, layer, cs, r, t, ctx) {
    var text = svgIn(layer);
    if (!text || !/^100% 100%$/.test((cs.backgroundSize || "").trim())) return null;
    var left = num(cs.borderLeftWidth) * ctx.scale;
    var top = num(cs.borderTopWidth) * ctx.scale;
    var area = { x: r.x + left, y: r.y + top, w: r.w - left - num(cs.borderRightWidth) * ctx.scale, h: r.h - top - num(cs.borderBottomWidth) * ctx.scale };
    if (!(area.w > 0) || !(area.h > 0)) return null;
    var angle = (t.rotation * Math.PI) / 180;
    var turn = t.rotation ? [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle)] : null;
    var items = imageDrawing(text, el.closest(".slide") || document.body, area, ctx.scale, ctx.opacity, turn, [r.x + r.w / 2, r.y + r.h / 2]);
    var around = cs.getPropertyValue ? cs.getPropertyValue("border-image-source") : "";
    if (items && isSet(around)) {
      var cast = svgIn(around);
      var blur = /stdDeviation=['"]([\d.]+)/.exec(cast);
      var filled = items.filter(function (item) { return item.fill; })[0];
      if (!blur || !filled) return null;
      var drop = /translate\(0 ([\d.]+)\)/.exec(cast);
      var strength = /fill-opacity=['"]([\d.]+)/.exec(cast);
      filled.shadow = {
        color: [0, 0, 0, (strength ? num(strength[1]) : 1) * ctx.opacity],
        x: 0,
        y: (drop ? num(drop[1]) : 0) * ctx.scale,
        blur: 2 * num(blur[1]) * ctx.scale,
      };
    }
    return items;
  };

  /**
   * An inline `<svg>` as shapes, over its own box. Its own transform (a line the PowerPoint
   * import mirrored, a turned drawing) goes into the shapes. False if PowerPoint cannot draw
   * all of it.
   */
  Scanner.prototype.svg = function (el, cs, r, ctx) {
    var scale = ctx.scale;
    var sides = function (a, b) {
      return num(cs["border" + a + "Width"]) + num(cs["padding" + a]) + num(cs["border" + b + "Width"]) + num(cs["padding" + b]);
    };
    var turn = null;
    var spread = null;
    var box = r;
    if ((cs.transform && cs.transform !== "none") || isSet(cs.rotate) || isSet(cs.scale)) {
      // The box before the transform: the same middle, its laid-out size.
      var m = /^matrix\(([^)]+)\)$/.exec(cs.transform || "");
      var outer = cs.boxSizing === "border-box";
      var w = /px$/.test(cs.width || "") ? num(cs.width) + (outer ? 0 : sides("Left", "Right")) : 0;
      var h = /px$/.test(cs.height || "") ? num(cs.height) + (outer ? 0 : sides("Top", "Bottom")) : 0;
      if (!m || isSet(cs.rotate) || isSet(cs.scale) || !(w > 0) || !(h > 0)) return false;
      turn = m[1].split(",").slice(0, 4).map(function (n) { return num(n); });
      spread = spreadOf(turn.concat([0, 0]));
      box = { x: r.x + r.w / 2 - (w * scale) / 2, y: r.y + r.h / 2 - (h * scale) / 2, w: w * scale, h: h * scale };
    }
    var left = (num(cs.borderLeftWidth) + num(cs.paddingLeft)) * scale;
    var top = (num(cs.borderTopWidth) + num(cs.paddingTop)) * scale;
    var area = { x: box.x + left, y: box.y + top, w: box.w - sides("Left", "Right") * scale, h: box.h - sides("Top", "Bottom") * scale };
    var about = [r.x + r.w / 2, r.y + r.h / 2];
    var items = drawingOf(el, area, scale, ctx.opacity, turn, about);
    if (!items) return false;
    // What the browser cuts off at the drawing's edge, PowerPoint would show.
    var past = function (item) {
      var b = boundsOf(item);
      var slack = item.kind === "text" ? 0.6 * ((item.paragraphs[0].runs[0] || {}).size || 16) : 2;
      return b.x < area.x - slack || b.y < area.y - slack || b.x + b.w > area.x + area.w + slack || b.y + b.h > area.y + area.h + slack;
    };
    if (/hidden|clip|scroll|auto/.test(cs.overflow || "")) {
      var upright = turn ? drawingOf(el, area, scale, ctx.opacity, null) : items;
      if (!upright || upright.some(past)) return false;
    }
    // Its own fill and border, as any box has them.
    if (spread && !spread.plain && hasBox(cs)) return false;
    var own = Object.create(ctx);
    own.scale = scale * (spread ? spread.scale : 1);
    var grown = spread ? { x: about[0] - (box.w * spread.sx) / 2, y: about[1] - (box.h * spread.sy) / 2, w: box.w * spread.sx, h: box.h * spread.sy } : box;
    if (!this.box(el, cs, grown, { rotation: spread ? spread.rotation : 0 }, own)) return false;
    this.group(items, ctx);
    return true;
  };

  Scanner.prototype.image = function (el, cs, r, t, ctx) {
    var src = el.getAttribute("src") || "";
    var clip = ctx.clip;
    var escapes = clip && (r.x < clip.x - 1 || r.y < clip.y - 1 || r.x + r.w > clip.x + clip.w + 1 || r.y + r.h > clip.y + clip.h + 1);
    if (!IMAGE_FILE.test(src) || !el.naturalWidth) {
      if (el.naturalWidth || !IMAGE_FILE.test(src)) this.shot(el, r, ctx);
      return;
    }
    if (escapes && t.rotation) {
      this.shot(el, r, ctx);
      return;
    }
    var nw = el.naturalWidth;
    var nh = el.naturalHeight;
    var crop = null;
    var fit = cs.objectFit;
    var pos = (cs.objectPosition || "50% 50%").split(" ");
    var px = num(pos[0], 50) / 100;
    var py = num(pos[1], 50) / 100;
    if (fit === "cover" || fit === "contain" || (fit === "scale-down" && (nw > r.w || nh > r.h))) {
      var cover = fit === "cover";
      var scale = cover ? Math.max(r.w / nw, r.h / nh) : Math.min(r.w / nw, r.h / nh);
      var dw = nw * scale;
      var dh = nh * scale;
      if (cover) {
        var cutX = 1 - r.w / dw;
        var cutY = 1 - r.h / dh;
        crop = { l: cutX * px, r: cutX * (1 - px), t: cutY * py, b: cutY * (1 - py) };
      } else {
        r = { x: r.x + (r.w - dw) * px, y: r.y + (r.h - dh) * py, w: dw, h: dh };
      }
    }
    if (escapes) {
      // Cut by a parent: PowerPoint crops the picture the same way. On top of any crop above.
      var seen = crop || { l: 0, r: 0, t: 0, b: 0 };
      var showX = 1 - seen.l - seen.r;
      var showY = 1 - seen.t - seen.b;
      var left = Math.max(clip.x, r.x);
      var top = Math.max(clip.y, r.y);
      var right = Math.min(clip.x + clip.w, r.x + r.w);
      var bottom = Math.min(clip.y + clip.h, r.y + r.h);
      if (right <= left || bottom <= top) return;
      crop = {
        l: seen.l + (showX * (left - r.x)) / r.w,
        r: seen.r + (showX * (r.x + r.w - right)) / r.w,
        t: seen.t + (showY * (top - r.y)) / r.h,
        b: seen.b + (showY * (r.y + r.h - bottom)) / r.h,
      };
      r = { x: left, y: top, w: right - left, h: bottom - top };
      var parent = el.parentElement ? radiusOf(getComputedStyle(el.parentElement), r) : null;
      if (parent && parent.same && parent.value > 0) cs = getComputedStyle(el.parentElement);
    }
    var radius = radiusOf(cs, r);
    // Rounded by the parent that clips it, when it fills that parent.
    if (!radius.value && ctx.clipRadius && clip && Math.abs(r.w - clip.w) <= 2 && Math.abs(r.h - clip.h) <= 2) {
      radius = { same: true, value: ctx.clipRadius, percent: null };
    }
    var borderWidth = num(cs.borderTopWidth);
    var outline = null;
    if (borderWidth > 0 && cs.borderTopStyle !== "none" && uniformBorder(cs) && color(cs.borderTopColor)[3] > 0) {
      outline = { color: color(cs.borderTopColor), width: borderWidth * ctx.scale, dash: null };
      var half = (borderWidth * ctx.scale) / 2;
      r = { x: r.x + half, y: r.y + half, w: r.w - 2 * half, h: r.h - 2 * half };
    }
    this.push(
      {
        kind: "image",
        src: src,
        border: outline,
        alt: el.getAttribute("alt") || "",
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        rotation: t.rotation,
        flipH: t.flipH,
        crop: crop,
        radius: radius.value * ctx.scale,
        ellipse: radius.percent !== null && radius.percent >= 50,
        opacity: ctx.opacity,
      },
      ctx,
    );
  };

  /**
   * How far `cs` raises its text, as a percent of the size PowerPoint would shrink it from: raised
   * text there is drawn at two thirds of the size it is given, and raised by a share of that size.
   */
  function raisedBy(cs) {
    var align = cs.verticalAlign || "baseline";
    if (align === "super") return 30;
    if (align === "sub") return -25;
    var full = num(cs.fontSize, 16) * 1.5;
    if (/px$/.test(align)) return (num(align) / full) * 100;
    if (/%$/.test(align)) return (num(align) * num(cs.lineHeight, num(cs.fontSize, 16))) / full;
    return 0;
  }

  /** Runs for a text node, in the style of the element holding it, raised by `baseline`. */
  function textRuns(text, cs, ctx, link, runs, baseline) {
    var keep = /^pre|break-spaces/.test(cs.whiteSpace);
    var body = keep ? text : text.replace(/\s+/g, " ");
    if (cs.textTransform === "uppercase") body = body.toUpperCase();
    else if (cs.textTransform === "lowercase") body = body.toLowerCase();
    var fillText = cs.webkitTextFillColor;
    var ink = color(fillText && fillText !== "currentcolor" ? fillText : cs.color);
    if (ink[3] === 0) {
      // Text showing its background: the gradient's first colour stands in.
      var g = gradient(cs.backgroundImage || "") || gradient(ctx.clipImage || "");
      ink = g ? g.stops[0].color : color(cs.color);
    }
    ink = [ink[0], ink[1], ink[2], ink[3] * ctx.opacity];
    var mark = color(cs.backgroundColor);
    var lines = cs.textDecorationLine || cs.textDecoration || "";
    var parts = keep ? body.split("\n") : [body];
    parts.forEach(function (part, i) {
      if (i > 0) runs.push({ text: "", lineBreak: true });
      if (!part) return;
      runs.push({
        text: part,
        font: splitTop(cs.fontFamily || "")[0].replace(/^["']|["']$/g, ""),
        size: num(cs.fontSize, 16) * ctx.scale,
        bold: num(cs.fontWeight, 400) >= 600,
        italic: cs.fontStyle === "italic" || /^oblique/.test(cs.fontStyle),
        underline: /underline/.test(lines),
        strike: /line-through/.test(lines),
        color: ink,
        spacing: cs.letterSpacing === "normal" ? 0 : num(cs.letterSpacing) * ctx.scale,
        highlight: mark[3] > 0.05 ? mark : null,
        baseline: baseline || 0,
        link: link,
      });
    });
  }

  function pseudoRun(el, which, ctx, link, runs, baseline) {
    if (pseudo(el, which) !== "run") return;
    var cs = getComputedStyle(el, which);
    textRuns(cs.content.slice(1, -1), cs, ctx, link, runs, baseline);
  }

  /** Collects `node` and what is inside it as runs. */
  function collect(node, ctx, link, runs, baseline) {
    if (node.nodeType === 3) {
      textRuns(node.nodeValue, getComputedStyle(node.parentElement), ctx, link, runs, baseline);
      return;
    }
    if (node.nodeType !== 1) return;
    var tag = node.tagName.toLowerCase();
    if (tag === "br") {
      runs.push({ text: "", lineBreak: true });
      return;
    }
    var cs = getComputedStyle(node);
    if (cs.display === "none" || NEVER[tag]) return;
    if (tag === "a") link = node.getAttribute("href") || link;
    baseline = raisedBy(cs) || baseline;
    pseudoRun(node, "::before", ctx, link, runs, baseline);
    Array.prototype.forEach.call(node.childNodes, function (child) {
      collect(child, ctx, link, runs, baseline);
    });
    pseudoRun(node, "::after", ctx, link, runs, baseline);
  }

  /** Runs without the space collapsed away at the ends of a line. */
  function tidy(runs) {
    while (runs.length && !runs[0].lineBreak && !/\S/.test(runs[0].text)) runs.shift();
    while (runs.length && !runs[runs.length - 1].lineBreak && !/\S/.test(runs[runs.length - 1].text)) runs.pop();
    if (!runs.length) return runs;
    var last = runs[runs.length - 1];
    if (runs[0].text) runs[0].text = runs[0].text.replace(/^\s+/, "");
    if (last.text) last.text = last.text.replace(/\s+$/, "");
    return runs;
  }

  /** The marker of a list item, or null. */
  function bulletOf(li) {
    if (li.tagName.toLowerCase() !== "li") return null;
    var type = getComputedStyle(li).listStyleType || "disc";
    if (type === "none") return null;
    if (MARKERS[type]) return { char: MARKERS[type] };
    var custom = /^["'](.*)["']$/.exec(type);
    if (custom) return { char: custom[1].trim() || "•" };
    return { number: type };
  }

  /** The number a list item shows, or null when it shows none of its own. */
  function ordinal(li) {
    var list = li.parentElement;
    if (!list || list.tagName.toLowerCase() !== "ol") return null;
    var number = num(list.getAttribute("start"), 1);
    var counting = false;
    Array.prototype.some.call(list.children, function (item) {
      if (item.tagName.toLowerCase() !== "li") return item === li;
      if (counting) number += 1;
      counting = true;
      var value = item.getAttribute("value");
      if (value !== null && value !== undefined && value !== "") number = num(value, number);
      return item === li;
    });
    return number;
  }

  /**
   * The box of an empty mark at the top of the line holding `node`, a child of `parent`. Line tops
   * can't be told from the glyphs: browsers round the leading in ways of their own. In a flex or
   * grid box the mark would become an item, so there's no measuring.
   */
  function lineTop(parent, cs, node) {
    if (!/^(block|list-item|table-cell|inline-block|flow-root)$/.test(cs.display)) return null;
    var mark = document.createElement("span");
    mark.style.cssText = "display: inline-block; width: 0; height: 0; vertical-align: top";
    parent.insertBefore(mark, node);
    var box = mark.getBoundingClientRect();
    parent.removeChild(mark);
    return box;
  }

  /** The top of the first line of `rects`, and the height of its tallest text. */
  function firstLine(rects) {
    var shown = Array.prototype.filter.call(rects, function (rect) { return rect.width > 0; });
    if (!shown.length) return null;
    return shown.reduce(function (best, rect) {
      return rect.top < shown[0].bottom && rect.height > best.height ? rect : best;
    }, shown[0]);
  }

  function paragraph(owner, cs, runs, ctx) {
    var line = num(cs.lineHeight, 0);
    return {
      align: /center/.test(cs.textAlign) ? "center" : /right|end/.test(cs.textAlign) ? "right" : /justify/.test(cs.textAlign) ? "justify" : "left",
      lineHeight: line > 0 ? line * ctx.scale : null,
      runs: runs,
    };
  }

  function linesIn(rects, size) {
    var tops = [];
    Array.prototype.forEach.call(rects, function (r) {
      if (r.width <= 0) return;
      if (!tops.some(function (t) { return Math.abs(t - r.top) < size * 0.6; })) tops.push(r.top);
    });
    return tops.length;
  }

  /**
   * A text box for the inline `nodes`, which sit in `parent`; `first` and `last` tell whether
   * they open and close it, and so stand beside the text of its pseudo-elements.
   */
  Scanner.prototype.text = function (parent, cs, nodes, ctx, first, last) {
    var runs = [];
    var before = first && pseudo(parent, "::before") === "run";
    var after = last && pseudo(parent, "::after") === "run";
    if (before) pseudoRun(parent, "::before", ctx, ctx.link, runs);
    nodes.forEach(function (node) {
      collect(node, ctx, ctx.link, runs);
    });
    if (after) pseudoRun(parent, "::after", ctx, ctx.link, runs);
    tidy(runs);
    if (!runs.some(function (run) { return run.text; })) return;
    var range = document.createRange();
    range.setStartBefore(nodes[0]);
    range.setEndAfter(nodes[nodes.length - 1]);
    var bounds = range.getBoundingClientRect();
    var r = this.rect(bounds);
    if (ctx.rotated) r = ctx.rotated;
    if (r.w <= 0 && r.h <= 0) return;
    var size = runs[0].size || 16;
    var rects = range.getClientRects ? range.getClientRects() : [];
    var lines = linesIn(rects, size);
    var wrap = lines > 1;
    var para = paragraph(parent, cs, runs, ctx);
    // A range measures glyphs, but a line of text stands in its line box: taller or shorter than
    // the glyphs by the leading. Placing the glyph box would shift the text a little every trip.
    // Whole pixels too, or what a browser rounds away would add up over repeated round trips.
    var glyphs = firstLine(rects);
    if (para.lineHeight && glyphs && !ctx.rotated) {
      var glyphHeight = glyphs.height / this.ratio;
      var mark = lineTop(parent, cs, nodes[0]);
      var line = mark ? this.rect(mark).y : this.rect(glyphs).y + (glyphHeight - para.lineHeight) / 2;
      r = { x: r.x, y: Math.round(line), w: r.w, h: r.h + para.lineHeight - glyphHeight };
    }
    if (wrap || before || after) {
      var p = this.rect(parent.getBoundingClientRect());
      var padL = num(cs.paddingLeft) * ctx.scale;
      var padR = num(cs.paddingRight) * ctx.scale;
      var inner = { x: p.x + padL + num(cs.borderLeftWidth), w: p.w - padL - padR - num(cs.borderLeftWidth) - num(cs.borderRightWidth) };
      // A range counts the space hanging at the end of a line, so it can pass the width it wraps at.
      if (before || after || inner.w >= r.w - size) {
        r = { x: inner.x, y: r.y, w: inner.w, h: r.h };
      }
    }
    var bullet = bulletOf(parent);
    if (bullet) {
      var hang = Math.min(size * 1.4, 64);
      para.bullet = bullet;
      if (bullet.number) {
        var shown = ordinal(parent);
        if (shown > 1) bullet.start = shown;
      }
      para.marginLeft = hang;
      para.indent = -hang;
      r = { x: r.x - hang, y: r.y, w: r.w + hang, h: r.h };
    }
    this.push({ kind: "text", x: r.x, y: r.y, w: r.w, h: r.h, rotation: ctx.rotation, wrap: wrap, paragraphs: [para] }, ctx);
  };

  /** Whether a list can be one text box: items of plain text, each without a box of its own. */
  function simpleList(el) {
    var items = Array.prototype.slice.call(el.children);
    return (
      items.length > 0 &&
      items.every(function (li) {
        var cs = getComputedStyle(li);
        return (
          li.tagName.toLowerCase() === "li" &&
          !hasBox(cs) &&
          !cs.boxShadow.match(/px/) &&
          pseudo(li, "::before") !== "art" &&
          pseudo(li, "::after") !== "art" &&
          Array.prototype.every.call(li.childNodes, isInline)
        );
      })
    );
  }

  Scanner.prototype.list = function (el, r, ctx) {
    var self = this;
    var previous = null;
    var ordered = el.tagName.toLowerCase() === "ol";
    var start = ordered ? num(el.getAttribute("start"), 1) : 1;
    var paragraphs = [];
    Array.prototype.forEach.call(el.children, function (li) {
      var cs = getComputedStyle(li);
      var runs = [];
      pseudoRun(li, "::before", ctx, ctx.link, runs);
      Array.prototype.forEach.call(li.childNodes, function (node) {
        collect(node, ctx, ctx.link, runs);
      });
      pseudoRun(li, "::after", ctx, ctx.link, runs);
      tidy(runs);
      var box = self.rect(li.getBoundingClientRect());
      var para = paragraph(li, cs, runs, ctx);
      var size = (runs[0] && runs[0].size) || num(cs.fontSize, 16);
      var bullet = bulletOf(li);
      var left = Math.max(box.x - r.x, 0);
      if (bullet) {
        para.bullet = bullet;
        if (bullet.number && start > 1) para.bullet.start = start;
        var hang = Math.max(Math.min(left, size * 1.4), size * 0.8);
        para.marginLeft = Math.max(left, hang);
        para.indent = -hang;
      } else if (left > 0) {
        para.marginLeft = left;
      }
      if (previous) para.spaceBefore = Math.max(box.y - previous.y - previous.h, 0);
      previous = box;
      paragraphs.push(para);
    });
    if (!paragraphs.length) return;
    this.push({ kind: "text", x: r.x, y: r.y, w: r.w, h: r.h, rotation: ctx.rotation, wrap: true, paragraphs: paragraphs }, ctx);
  };

  /**
   * Whether `el`'s children are all paragraphs of plain text: <p>s, or the one block the editor
   * keeps the text of a text box or shape in (`data-text-body`, see assets/editor/).
   */
  function plainParagraphs(el) {
    var items = Array.prototype.slice.call(el.children);
    return (
      items.length > 0 &&
      items.every(function (child) {
        var cs = getComputedStyle(child);
        var paragraph = child.tagName.toLowerCase() === "p" || child.hasAttribute("data-text-body");
        return paragraph && !hasBox(cs) && Array.prototype.every.call(child.childNodes, isInline);
      }) &&
      !Array.prototype.some.call(el.childNodes, function (node) {
        return node.nodeType === 3 && hasText(node);
      })
    );
  }

  /** Paragraphs turned with their parent: one text box, which PowerPoint can turn the same way. */
  Scanner.prototype.turned = function (el, cs, r, ctx) {
    var paragraphs = [];
    Array.prototype.forEach.call(el.children, function (child) {
      var runs = [];
      Array.prototype.forEach.call(child.childNodes, function (node) {
        collect(node, ctx, ctx.link, runs);
      });
      tidy(runs);
      paragraphs.push(paragraph(child, getComputedStyle(child), runs, ctx));
    });
    var left = num(cs.paddingLeft) * ctx.scale;
    var top = num(cs.paddingTop) * ctx.scale;
    var inner = {
      x: r.x + left,
      y: r.y + top,
      w: r.w - left - num(cs.paddingRight) * ctx.scale,
      h: r.h - top - num(cs.paddingBottom) * ctx.scale,
    };
    this.push({ kind: "text", x: inner.x, y: inner.y, w: inner.w, h: inner.h, rotation: ctx.rotation, wrap: paragraphs.length > 1, paragraphs: paragraphs }, ctx);
  };

  /** The children of `el`: lines of text in order with the elements between them. */
  Scanner.prototype.content = function (el, cs, ctx) {
    var self = this;
    var group = [];
    var opening = true;
    var flush = function (last) {
      if (group.length) self.text(el, cs, group, ctx, opening, last);
      if (group.length) opening = false;
      group = [];
    };
    Array.prototype.forEach.call(el.childNodes, function (child) {
      if (child.nodeType === 3) {
        if (group.length || hasText(child)) group.push(child);
        return;
      }
      if (child.nodeType !== 1) return;
      if (isInline(child)) group.push(child);
      else {
        flush(false);
        opening = false;
        self.walk(child, ctx);
      }
    });
    flush(true);
  };

  Scanner.prototype.walk = function (el, ctx) {
    var tag = el.tagName.toLowerCase();
    if (NEVER[tag] || el.classList.contains("notes") || el.classList.contains("narration")) return;
    var cs = getComputedStyle(el);
    if (cs.display === "none") return;
    var opacity = ctx.opacity * num(cs.opacity, 1);
    if (opacity < 0.004) return;
    var r = this.rect(el.getBoundingClientRect());
    var positioned = cs.position && cs.position !== "static";
    var z = positioned && cs.zIndex !== "auto" ? num(cs.zIndex) : ctx.z;
    var next = {
      opacity: opacity,
      z: z,
      scale: ctx.scale,
      rotation: ctx.rotation,
      rotated: ctx.rotated,
      clip: ctx.clip,
      clipRadius: ctx.clipRadius,
      link: tag === "a" ? el.getAttribute("href") || ctx.link : ctx.link,
    };
    var hidden = cs.visibility === "hidden" || cs.visibility === "collapse";
    if (hidden && !el.children.length) return;

    var t = transformOf(cs);
    var effects =
      visibleFilter(cs.filter) ||
      (cs.webkitMaskImage && cs.webkitMaskImage !== "none") ||
      (cs.maskImage && cs.maskImage !== "none") ||
      (cs.clipPath && cs.clipPath !== "none") ||
      (cs.mixBlendMode && cs.mixBlendMode !== "normal");
    var blockChildren = Array.prototype.some.call(el.childNodes, function (child) {
      return child.nodeType === 1 && !isInline(child);
    });
    var turnsAsText = t.rotation && plainParagraphs(el);
    if (tag === "svg" && t.simple && !effects && !hidden && !this.off(r) && this.svg(el, cs, r, next)) return;
    if (PICTURED[tag] || !t.simple || effects || (t.rotation && blockChildren && tag !== "img" && !turnsAsText)) {
      if (!this.off(r) && !hidden) this.shot(el, r, next);
      return;
    }
    next.scale *= Math.max(t.scaleX, t.scaleY);
    var shape = unrotated(el, r, t, next);
    if (t.rotation) {
      next.rotation += t.rotation;
      next.rotated = shape;
    }
    if (tag === "img") {
      if (!this.off(r) && !hidden) this.image(el, cs, shape, t, next);
      return;
    }
    if (!hidden) {
      var art = pseudo(el, "::before") === "art" || pseudo(el, "::after") === "art";
      if (!this.off(r) && (art || !this.box(el, cs, shape, t, next))) this.shot(el, r, next, true);
    }
    if (cs.overflow !== "visible" && cs.overflowX !== "visible") {
      next.clip = r;
      var corners = radiusOf(cs, r);
      next.clipRadius = corners.same ? corners.value * next.scale : 0;
    }
    if (turnsAsText) {
      this.turned(el, cs, shape, next);
      return;
    }
    if ((tag === "ul" || tag === "ol") && simpleList(el)) {
      this.list(el, r, next);
      return;
    }
    if (pseudo(el, "::before") === "run" || pseudo(el, "::after") === "run") {
      var runs = [];
      if (!Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 ? hasText(n) : n.nodeType === 1; })) {
        pseudoRun(el, "::before", next, next.link, runs);
        pseudoRun(el, "::after", next, next.link, runs);
        tidy(runs);
        if (runs.length) {
          this.push({ kind: "text", x: r.x, y: r.y, w: r.w, h: r.h, rotation: next.rotation, wrap: false, paragraphs: [paragraph(el, cs, runs, next)] }, next);
        }
        return;
      }
    }
    this.content(el, cs, next);
  };

  /** The slide's background: a colour, a gradient, a picture, or a shot of all of it. */
  function backgroundOf(slide) {
    var cs = getComputedStyle(slide);
    var art = pseudo(slide, "::before") === "art" || pseudo(slide, "::after") === "art";
    var image = cs.backgroundImage;
    if (!art && image && image !== "none") {
      var layers = splitTop(image);
      var g = layers.length === 1 ? gradient(layers[0]) : null;
      if (g) return { gradient: g };
      var url = layers.length === 1 ? /^url\("?([^")]+)"?\)$/.exec(layers[0]) : null;
      var file = url && url[1].replace(location.href.replace(/[^/]*$/, ""), "");
      if (url && IMAGE_FILE.test(file) && /cover|100%/.test(cs.backgroundSize || "")) return { src: file };
      art = true;
    }
    if (art) return { shot: addShot(slide, true, true) };
    var bg = color(cs.backgroundColor);
    if (bg[3] === 0) bg = color(getComputedStyle(document.body).backgroundColor);
    return bg[3] === 0 ? { color: [255, 255, 255, 1] } : { color: [bg[0], bg[1], bg[2], 1] };
  }

  function scanSlide(slide) {
    var scanner = new Scanner(slide);
    var ctx = { opacity: 1, z: 0, scale: 1, rotation: 0, rotated: null, clip: null, clipRadius: 0, link: null };
    var background = backgroundOf(slide);
    scanner.content(slide, getComputedStyle(slide), ctx);
    // A stable sort by stacking order: later in the document paints on top.
    var items = scanner.items
      .map(function (item, i) { return { item: item, i: i }; })
      .sort(function (a, b) { return a.item.z - b.item.z || a.i - b.i; })
      .map(function (entry) {
        delete entry.item.z;
        return entry.item;
      });
    return { id: slide.id, background: background, items: items };
  }

  function show(index) {
    var all = slides();
    all.forEach(function (el, i) {
      el.classList.toggle("active", i === index);
    });
    window.dispatchEvent(new Event("resize"));
  }

  /** UTF-8 bytes of `text` as URL-safe base64, which survives being cut anywhere. */
  function encode(text) {
    return btoa(unescape(encodeURIComponent(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  window.__slopPptx = {
    /**
     * Waits for fonts and images (a few seconds at most), then reports the slide count and the
     * window's size: a window the engine never laid out has none, and nothing to read.
     */
    ready: function () {
      var images = Array.prototype.map.call(document.images, function (img) {
        return img.decode ? img.decode().catch(function () {}) : null;
      });
      var fonts = document.fonts ? document.fonts.ready : null;
      // Timers only: a hidden window paints no frames, so requestAnimationFrame never fires.
      var cap = new Promise(function (resolve) {
        setTimeout(resolve, 5000);
      });
      Promise.race([Promise.all(images.concat([fonts])), cap]).then(function () {
        setTimeout(function () {
          signal("ready&slides=" + slides().length + "&view=" + [window.innerWidth, window.innerHeight].join(","));
        }, 100);
      });
    },

    /**
     * Reads slide `index`, starting the scene over at the first, and reports it read; after the
     * last, also the size of the answer. The app asks for each slide in turn: timers alone
     * cannot carry the scan through a long deck, as WebKit slows and then stops those of a
     * hidden window until the app next reaches the page.
     */
    scan: function (index) {
      var all = slides();
      if (index === 0) {
        scene = [];
        shots = [];
      }
      show(index);
      setTimeout(function () {
        scene.push(scanSlide(all[index]));
        if (index + 1 < all.length) {
          signal("scanned=" + index);
          return;
        }
        encoded = encode(JSON.stringify({ slides: scene, shots: shots.map(function (s) { return { opaque: s.opaque }; }) }));
        signal("scanned=" + index + "&chunks=" + Math.ceil(encoded.length / CHUNK));
      }, 40);
    },

    /** Answers with piece `index` of the scene. */
    chunk: function (index) {
      signal("chunk=" + index + "&data=" + encoded.slice(index * CHUNK, (index + 1) * CHUNK));
    },

    /**
     * Shows only shot `index`, on `paper` (a CSS colour) if given, and reports where it is. Over
     * white and over black, its transparency can be worked out from the two pictures.
     */
    isolate: function (index, paper) {
      var shot = shots[index];
      if (!document.querySelector("style[data-slop-pptx]")) {
        var style = document.createElement("style");
        style.setAttribute("data-slop-pptx", "");
        style.textContent = css;
        document.head.appendChild(style);
      }
      Array.prototype.forEach.call(document.querySelectorAll("[data-slop-pptx-shot]"), function (el) {
        el.removeAttribute("data-slop-pptx-shot");
      });
      show(slides().indexOf(shot.slide));
      root.setAttribute("data-slop-pptx", "");
      if (paper) {
        root.setAttribute("data-slop-pptx-paper", "");
        root.style.setProperty("--slop-pptx-paper", paper);
      } else {
        root.removeAttribute("data-slop-pptx-paper");
      }
      shot.el.setAttribute("data-slop-pptx-shot", shot.decor ? "decor" : "all");
      // A hidden window decodes images only when asked; a capture would find them missing.
      var images = shot.el.tagName.toLowerCase() === "img" ? [shot.el] : Array.prototype.slice.call(shot.el.querySelectorAll("img"));
      var decoded = images.map(function (img) {
        return img.decode ? img.decode().catch(function () {}) : null;
      });
      var report = function () {
        var r = shot.el.getBoundingClientRect();
        var s = shot.slide.getBoundingClientRect();
        // The same area as the scan's: the picture goes back exactly there.
        var ratio = shot.slide.offsetWidth ? s.width / shot.slide.offsetWidth : 1;
        var area = reachOf({ x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height }, shot.reach * ratio, s.width, s.height);
        signal(
          "isolated=" + index +
            "&rect=" + [s.left + area.x, s.top + area.y, area.w, area.h].join(",") +
            "&view=" + [window.innerWidth, window.innerHeight].join(",") +
            "&scale=" + ratio,
        );
      };
      Promise.all(decoded).then(function () {
        setTimeout(report, 120);
      });
    },
  };

  window.__slopPptx.ready();
})();
