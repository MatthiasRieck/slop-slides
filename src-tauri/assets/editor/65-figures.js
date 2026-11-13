  // ---- Figures: a box whose shape an SVG in its background draws (see FIGURES), with its
  // fill and border (an inner stroke, as wide as a CSS border would be) and its flips, which
  // mirror the shape while the text stays readable. Its padding, in pixels from its size,
  // keeps the text inside the shape, so it is fitted again whenever the box changes size.

  /** The kind of figure `el` is, or null. */
  function figureOf(el) {
    var kind = el && el.getAttribute ? el.getAttribute(SHAPE_ATTR) : null;
    return kind && Object.prototype.hasOwnProperty.call(FIGURES, kind) ? kind : null;
  }

  /** The old `clip-path` cut-out (see CUT_OUTS) `el` is, or null. */
  function cutOutKind(el) {
    if (!el || !el.style || el.namespaceURI === SVG_NS || figureOf(el)) return null;
    var squash = function (text) {
      return String(text || "").replace(/\s+/g, "");
    };
    var clip = squash(el.style.getPropertyValue("clip-path"));
    if (!clip) return null;
    for (var kind in CUT_OUTS) {
      if (squash(CUT_OUTS[kind]) === clip) return kind;
    }
    return null;
  }

  /** Redraws an old cut-out as a figure, keeping its fill, so it takes a border, shadow and flips. */
  function upgradeCutOut(el) {
    var kind = cutOutKind(el);
    if (!kind) return;
    var fill = toHex(getComputedStyle(el).backgroundColor);
    el.style.removeProperty("clip-path");
    setOwn(el, "background-color", null, "rgba(0, 0, 0, 0)");
    el.setAttribute(SHAPE_ATTR, kind);
    paintFigure(el, { fill: fill, stroke: null, width: 0, dash: "solid", flipX: false, flipY: false, shadow: 0 });
  }

  // What an SVG paint may be in a figure's image (it cannot see the deck's CSS variables).
  var FIGURE_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%/]+\)|[a-z]+)$/i;

  /** The size a figure is drawn at: its box, in whole pixels. */
  function figureSize(el) {
    var size = sizeOf(el);
    return { w: Math.max(1, Math.round(size.w)), h: Math.max(1, Math.round(size.h)) };
  }

  /** The proportions figure `el` is drawn with (see FIGURES): its `data-adjust`, kept in range, or the default. */
  function adjustOf(el) {
    var spec = FIGURES[figureOf(el)].adjust;
    if (!spec) return 0;
    var value = parseFloat(el.getAttribute(ADJUST_ATTR));
    return isFinite(value) ? Math.min(spec.max, Math.max(spec.min, value)) : spec.value;
  }

  /** Sets figure `el`'s proportions (see adjustOf) and redraws it; its default drops the attribute. */
  function setAdjust(el, value) {
    var spec = FIGURES[figureOf(el)].adjust;
    if (!spec || !isFinite(value)) return;
    value = Math.min(spec.max, Math.max(spec.min, Math.round(value / spec.step) * spec.step));
    if (value === spec.value) el.removeAttribute(ADJUST_ATTR);
    else el.setAttribute(ADJUST_ATTR, String(value));
    paintFigure(el, figurePaint(el));
  }

  /** What an image's data says, for a figure's SVG. */
  function svgUrl(svg) {
    return 'url("data:image/svg+xml,' + svg.replace(/%/g, "%25").replace(/#/g, "%23").replace(/</g, "%3C").replace(/>/g, "%3E") + '")';
  }

  /** The SVG an image's `url("data:image/svg+xml,…")` holds, or "". */
  function svgOf(image) {
    try {
      return decodeURIComponent(String(image || "").replace(/^url\(\s*["']?data:image\/svg\+xml,/, "").replace(/["']?\s*\)$/, ""));
    } catch (e) {
      // Not one the editor drew.
      return "";
    }
  }

  /**
   * Draws figure `el` with `paint`: { fill, stroke, width, dash, flipX, flipY, shadow } (null
   * colors for none), at its size and proportions, and fits its text inside the shape. Its
   * shadow is a second SVG in its `border-image`, reaching past its box: the shape's shadow
   * where the shape is not, so the text casts none.
   */
  function paintFigure(el, paint) {
    var kind = figureOf(el);
    var size = figureSize(el);
    var w = size.w;
    var h = size.h;
    var a = adjustOf(el);
    var d = FIGURES[kind].path(w, h, a);
    var rim = FIGURES[kind].rim ? FIGURES[kind].rim(w, h, a) : "";
    var color = function (value) {
      return value && FIGURE_COLOR.test(value) ? value : "none";
    };
    var width = Math.max(0, Math.round(Number(paint.width) || 0));
    var edge = paint.stroke && width > 0;
    var flip = "matrix(" + (paint.flipX ? -1 : 1) + " 0 0 " + (paint.flipY ? -1 : 1) + " " + (paint.flipX ? w : 0) + " " + (paint.flipY ? h : 0) + ")";
    var dashes = paint.dash === "dashed" ? " stroke-dasharray='" + 3 * width + " " + 2 * width + "'"
      : paint.dash === "dotted" ? " stroke-dasharray='" + width + " " + width + "'" : "";
    var svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 " + w + " " + h + "' preserveAspectRatio='none'>" +
      (edge ? "<clipPath id='edge'><path d='" + d + "'/></clipPath>" : "") +
      "<g transform='" + flip + "'>" +
      "<path d='" + d + "' fill='" + color(paint.fill) + "'/>" +
      // Twice as wide, and cut to the shape: what shows is inside it, as wide as `width`.
      (edge
        ? "<path d='" + d + (rim ? " " + rim : "") + "' fill='none' stroke='" + color(paint.stroke) + "' stroke-width='" + 2 * width +
          "'" + dashes + " stroke-linejoin='round' clip-path='url(#edge)'/>"
        : "") +
      "</g></svg>";
    el.style.setProperty("background-image", svgUrl(svg));
    el.style.setProperty("background-size", "100% 100%");
    el.style.setProperty("background-repeat", "no-repeat");
    var blur = Math.max(0, Math.round(Number(paint.shadow) || 0));
    // An earlier version's shadow, a filter over the whole box, text and all.
    var others = (el.style.getPropertyValue("filter") || "").replace(SHADOW_FILTER, "").trim();
    if (others) el.style.setProperty("filter", others);
    else el.style.removeProperty("filter");
    if (blur > 0) {
      var drop = Math.round(blur / 3);
      var reach = Math.ceil(1.5 * blur + drop) + 2;
      var box = -reach + " " + -reach + " " + (w + 2 * reach) + " " + (h + 2 * reach);
      var shadow =
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='" + box + "' preserveAspectRatio='none'><defs>" +
        "<filter id='blur' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='" + blur / 2 + "'/></filter>" +
        "<mask id='out' maskUnits='userSpaceOnUse' x='" + -reach + "' y='" + -reach + "' width='" + (w + 2 * reach) + "' height='" + (h + 2 * reach) + "'>" +
        "<rect x='" + -reach + "' y='" + -reach + "' width='" + (w + 2 * reach) + "' height='" + (h + 2 * reach) + "' fill='white'/>" +
        "<path d='" + d + "' fill='black' transform='" + flip + "'/></mask></defs>" +
        "<g mask='url(#out)'><g transform='translate(0 " + drop + ")'><path d='" + d + "' fill='black' fill-opacity='0.35'" +
        " filter='url(#blur)' transform='" + flip + "'/></g></g></svg>";
      el.style.setProperty("border-image-source", svgUrl(shadow));
      el.style.setProperty("border-image-slice", "0 fill");
      el.style.setProperty("border-image-width", "0");
      el.style.setProperty("border-image-outset", reach + "px");
      el.style.setProperty("border-image-repeat", "stretch");
    } else {
      ["border-image", "border-image-source", "border-image-slice", "border-image-width", "border-image-outset", "border-image-repeat"].forEach(function (prop) {
        el.style.removeProperty(prop);
      });
    }
    padFigure(el, paint);
  }

  /** How figure `el` is drawn, as paintFigure takes it. */
  function figurePaint(el) {
    // Tidying may have moved it into the slide's rules.
    var svg = svgOf(el.style.getPropertyValue("background-image") || getComputedStyle(el).backgroundImage);
    var shadow = svgOf(el.style.getPropertyValue("border-image-source") || getComputedStyle(el).getPropertyValue("border-image-source"));
    var fill = svg.match(/<path d='[^']*' fill='([^']*)'\/>/);
    var stroke = svg.match(/stroke='([^']*)' stroke-width='([\d.]+)'/);
    var dash = svg.match(/stroke-dasharray='([\d.]+) ([\d.]+)'/);
    var flips = svg.match(/matrix\((-?1) 0 0 (-?1)/);
    var blur = shadow.match(/stdDeviation='([\d.]+)'/);
    var filter = blur ? null : (el.style.getPropertyValue("filter") || "").match(SHADOW_LENGTHS);
    var paintOf = function (value) {
      return value && value !== "none" ? toHex(value) || value : null;
    };
    return {
      fill: fill ? paintOf(fill[1]) : null,
      stroke: stroke ? paintOf(stroke[1]) : null,
      width: stroke ? Math.round(parseFloat(stroke[2]) / 2) : 0,
      dash: dash ? (dash[1] === dash[2] ? "dotted" : "dashed") : "solid",
      flipX: !!flips && flips[1] === "-1",
      flipY: !!flips && flips[2] === "-1",
      shadow: blur ? Math.round(2 * parseFloat(blur[1])) : filter ? Math.round(parseFloat(filter[1])) : 0,
    };
  }

  /** Gives figure `el` the padding, in pixels from its size, that keeps its text inside its shape. */
  function padFigure(el, paint) {
    var size = sizeOf(el);
    if (!size.w || !size.h) return;
    var inset = FIGURES[figureOf(el)].inset(size.w, size.h, adjustOf(el));
    var top = inset[paint.flipY ? 2 : 0];
    var bottom = inset[paint.flipY ? 0 : 2];
    var right = inset[paint.flipX ? 3 : 1];
    var left = inset[paint.flipX ? 1 : 3];
    var px = function (length) {
      return Math.max(FIGURE_PADDING, Math.round(length)) + "px";
    };
    el.style.padding = [px(top), px(right), px(bottom), px(left)].join(" ");
  }

  /** Redraws figure `el` (or an old cut-out, made one) at its size, as whenever the box changes size. */
  function fitFigure(el) {
    var paint = resizedPaint(el);
    if (paint) fitFigureWith(el, paint);
  }

  /**
   * What to redraw `el` with (see scheduleFigure) as its box changes size: its paint, read once
   * for all the steps of a resize. An old cut-out is made a figure first; null for anything else.
   */
  function resizedPaint(el) {
    upgradeCutOut(el);
    return figureOf(el) ? figurePaint(el) : null;
  }

  /** Redraws figure `el` at its size with `paint` (see figurePaint), when it has a size. */
  function fitFigureWith(el, paint) {
    var size = sizeOf(el);
    if (size.w && size.h) paintFigure(el, paint);
  }

  // The figures whose box changed size since they were last drawn, each with its paint.
  var pendingFigures = [];

  /**
   * Redraws figure `el` at its size next frame, with the `paint` read when its resize started:
   * drawing one builds its image anew, and reading its paint takes that image apart, which is
   * too much for every pointer move. `flushFigures` draws what waits right away.
   */
  function scheduleFigure(el, paint) {
    var waiting = Array.prototype.find.call(pendingFigures, function (item) {
      return item.el === el;
    });
    if (waiting) waiting.paint = paint;
    else pendingFigures.push({ el: el, paint: paint });
    if (!figuresFrame) figuresFrame = window.requestAnimationFrame(flushFigures);
  }

  function flushFigures() {
    if (figuresFrame) window.cancelAnimationFrame(figuresFrame);
    figuresFrame = 0;
    var due = pendingFigures;
    pendingFigures = [];
    due.forEach(function (item) {
      if (item.el.isConnected) fitFigureWith(item.el, item.paint);
    });
  }

  /** A box cut out with a `clip-path` polygon the editor cannot redraw, which shows no border or shadow. */
  function isCutOut(el) {
    return /polygon/.test(getComputedStyle(el).getPropertyValue("clip-path") || "") && !cutOutKind(el);
  }

  /**
   * Whether flipping `el` mirrors what it shows without mirroring text: images, figures and
   * drawings. A line is mirrored through its points, which keeps its ends where they can stick.
   */
  function flippable(el) {
    if (!el || !el.tagName) return false;
    if (isImage(el) || figureOf(el) || cutOutKind(el)) return true;
    return el.namespaceURI === SVG_NS && el.tagName.toLowerCase() === "svg";
  }

  function isImage(el) {
    return !!el && /^img$/i.test(el.tagName);
  }

