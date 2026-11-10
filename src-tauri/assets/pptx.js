/* SlopSlide PowerPoint export helper (src-tauri/src/pptx/export.rs). The app runs it in the hidden
   window that exports a deck; it never becomes part of a deck. Each step answers by navigating
   to /.pptx-signal?<answer>, which the app catches and cancels.

   It reads each shown slide as rendered into a scene of what PowerPoint has natively: boxes
   (fills with alpha, gradients, borders, outer shadows), text and images. Backdrop blur has no
   counterpart and is dropped; whatever else PowerPoint cannot draw (SVG, canvas, filters, masks,
   3D, pseudo-element art) becomes a "shot", a picture the app captures with `isolate`. */
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
    var bg = color(cs.backgroundColor);
    if (!clipped && cs.backgroundImage && cs.backgroundImage !== "none") {
      var layers = splitTop(cs.backgroundImage);
      if (layers.length > 1) return false;
      var g = gradient(layers[0]);
      var url = /^url\("?([^")]+)"?\)$/.exec(layers[0]);
      var file = url && url[1].replace(location.href.replace(/[^/]*$/, ""), "");
      if (g) fill = { gradient: g };
      else if (url && IMAGE_FILE.test(file) && /cover|100%/.test(cs.backgroundSize || "")) image = file;
      else return false;
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

    /** Reads every slide, showing each in turn, and reports the size of the answer. */
    scan: function () {
      var all = slides();
      var scene = [];
      shots = [];
      var step = function (index) {
        if (index >= all.length) {
          encoded = encode(JSON.stringify({ slides: scene, shots: shots.map(function (s) { return { opaque: s.opaque }; }) }));
          signal("scanned&chunks=" + Math.ceil(encoded.length / CHUNK));
          return;
        }
        show(index);
        setTimeout(function () {
          scene.push(scanSlide(all[index]));
          step(index + 1);
        }, 40);
      };
      step(0);
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
