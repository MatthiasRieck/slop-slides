  // ---- The look of any element: shadows, flips, images, the slide's background, the format
  // painter, and the deck's styles, colors and fonts.

  /** The look `describe` reports beyond text, fill and border. */
  function lookOf(el, style) {
    var size = sizeOf(el);
    var svg = el.namespaceURI === SVG_NS;
    var clipped = isCutOut(el);
    var corner = style.getPropertyValue("border-radius") || "0";
    var radius = parseFloat(corner) || 0;
    if (/%/.test(corner)) radius = (radius / 100) * Math.min(size.w, size.h);
    var figure = figureOf(el) ? figurePaint(el) : null;
    var shaped = !!figure || !!cutOutKind(el);
    var blur = (style.getPropertyValue(svg ? "filter" : "box-shadow") || "").match(SHADOW_LENGTHS);
    var image = isImage(el);
    var flips = el.style.transform || "";
    return {
      opacity: Math.round((parseFloat(style.opacity === "" ? "1" : style.opacity) || 0) * 100) / 100,
      shadow: figure ? figure.shadow : blur && !clipped ? Math.round(parseFloat(blur[1])) : 0,
      radius: svg || clipped || shaped ? null : Math.round(radius),
      clipped: clipped,
      image: image,
      fit: image ? style.getPropertyValue("object-fit") || "fill" : null,
      fitPosition: image ? style.getPropertyValue("object-position") || "50% 50%" : null,
      alt: image ? el.getAttribute("alt") || "" : null,
      flippable: flippable(el),
      flipX: figure ? figure.flipX : /scaleX\(-1\)/.test(flips),
      flipY: figure ? figure.flipY : /scaleY\(-1\)/.test(flips),
    };
  }

  /** Sets a style inline; null drops it, or where the deck's styles set one, overrides it with `neutral`. */
  function setOwn(el, prop, value, neutral) {
    el.style.removeProperty(prop);
    var sheet = getComputedStyle(el).getPropertyValue(prop);
    var own = value === null && sheet && sheet !== neutral ? neutral : value;
    if (own !== null) el.style.setProperty(prop, own);
  }

  /** A shadow that blurs `blur` pixels and falls a third of that. */
  function shadowValue(blur) {
    return "0px " + Math.round(blur / 3) + "px " + blur + "px " + SHADOW_COLOR;
  }

  function setShadow(el, blur) {
    // A figure's shadow follows its shape, and skips its text (see paintFigure).
    if (figureOf(el)) {
      var paint = figurePaint(el);
      paint.shadow = blur;
      paintFigure(el, paint);
      return;
    }
    if (el.namespaceURI !== SVG_NS) {
      setOwn(el, "box-shadow", blur > 0 ? shadowValue(blur) : null, "none");
      return;
    }
    var others = (el.style.getPropertyValue("filter") || "").replace(SHADOW_FILTER, "");
    var filter = ((blur > 0 ? "drop-shadow(" + shadowValue(blur) + ") " : "") + others).trim();
    if (filter) el.style.setProperty("filter", filter);
    else el.style.removeProperty("filter");
  }

  /** Mirrors `el` with an inline `transform`, after any tilt and `!important` like it. */
  function flipTo(el, x, y) {
    var inline = el.style.transform || "";
    var tilt = inline.match(TILT);
    var rest = inline.replace(TILT, "").replace(/scale[XY]\(-1\)\s*/g, "").trim();
    var value = [tilt ? tilt[0].trim() : "", x ? "scaleX(-1)" : "", y ? "scaleY(-1)" : "", rest].filter(Boolean).join(" ");
    setInline(el, "transform", value || null, "important");
  }

  /** Gives an image's box a fixed size, for when what it shows no longer sets it. */
  function pinSize(el) {
    var computed = getComputedStyle(el);
    ["width", "height"].forEach(function (name) {
      if (/px$/.test(computed[name])) el.style[name] = computed[name];
    });
  }

  /** Applies the keys of `changes` that `lookOf` reports, to `el`. */
  function applyLook(el, changes) {
    var has = function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    };
    if (has("opacity") && isFinite(changes.opacity)) {
      var opacity = Math.round(Math.min(1, Math.max(MIN_OPACITY, changes.opacity)) * 100) / 100;
      setOwn(el, "opacity", opacity < 1 ? String(opacity) : null, "1");
    }
    var cut = isCutOut(el);
    if (has("shadow") && changes.shadow >= 0 && !cut) setShadow(el, Math.round(changes.shadow));
    if (has("radius") && changes.radius >= 0 && !cut && !figureOf(el) && el.namespaceURI !== SVG_NS) {
      setOwn(el, "border-radius", changes.radius > 0 ? Math.round(changes.radius) + "px" : null, "0px");
    }
    if ((has("flipX") || has("flipY")) && lineOf(el)) {
      // A line has no flip to keep: each one mirrors it.
      flipLine(el, !!changes.flipX, !!changes.flipY);
    } else if ((has("flipX") || has("flipY")) && flippable(el)) {
      var now = lookOf(el, getComputedStyle(el));
      var x = has("flipX") ? !!changes.flipX : now.flipX;
      var y = has("flipY") ? !!changes.flipY : now.flipY;
      if (figureOf(el)) {
        var paint = figurePaint(el);
        paint.flipX = x;
        paint.flipY = y;
        paintFigure(el, paint);
      } else {
        flipTo(el, x, y);
      }
    }
    if (!isImage(el)) return;
    if (has("fit") && /^(contain|cover|fill)$/.test(changes.fit)) {
      pinSize(el);
      el.style.setProperty("object-fit", changes.fit);
    }
    if (has("fitPosition") && /^\d+% \d+%$/.test(changes.fitPosition)) el.style.setProperty("object-position", changes.fitPosition);
    if (has("alt") && typeof changes.alt === "string") el.setAttribute("alt", changes.alt);
  }

  /** Puts another `assets/…` file in the selected image, whose box stays as it is. */
  function replaceImage(src) {
    var el = selected;
    if (!isImage(el) || !slide.contains(el) || !/^assets\//.test(src)) return;
    pinSize(el);
    if (!el.style.getPropertyValue("object-fit")) el.style.setProperty("object-fit", "cover");
    el.removeAttribute("srcset");
    el.setAttribute("src", src);
    placeHandles();
    report();
    commit();
  }

  function reportBackground() {
    var computed = getComputedStyle(slide);
    var color = toHex(computed.backgroundColor);
    // A gradient or an image over the color: what the color well cannot show, and a pick replaces.
    var other = (computed.backgroundImage || "none") !== "none";
    // Whether the color is the slide's own, set here, and not the deck's.
    var own = !!slide.style.getPropertyValue("background-color");
    window.parent.postMessage({ type: "slop:edit-background", slide: slide.id, color: color, other: other, own: own }, "*");
  }

  /** The slide's own background, over any image or gradient the deck gives it; null drops it. */
  function setBackground(color) {
    if (color !== null && !toHex(color)) return;
    if (color) {
      slide.style.setProperty("background-color", color);
      slide.style.setProperty("background-image", "none");
    } else {
      slide.style.removeProperty("background-color");
      slide.style.removeProperty("background-image");
    }
    if (!slide.getAttribute("style")) slide.removeAttribute("style");
    reportBackground();
    commit();
  }

  /** What the format painter takes from `el`, as changes for `applyStyle`: all, and for text. */
  function paintableStyle(el) {
    var now = describe(el);
    var shared = { opacity: now.opacity, shadow: now.shadow };
    if (now.radius !== null) shared.radius = now.radius;
    var paint = { fill: now.fill, stroke: now.stroke, strokeWidth: now.strokeWidth };
    var text = {};
    if (now.text) {
      PAINTED_TEXT.forEach(function (key) {
        text[key] = now[key];
      });
      text.fontFamily = getComputedStyle(el).fontFamily;
    }
    return { vector: now.vector, shared: shared, paint: paint, text: text };
  }

  /** The changes that give `el` the look `taken` (see paintableStyle): fill and line only between likes, text only onto text. */
  function paintChanges(el, taken) {
    var target = describe(el);
    var changes = {};
    [taken.shared, target.vector === taken.vector ? taken.paint : {}, target.text ? taken.text : {}].forEach(function (part) {
      Object.keys(part).forEach(function (key) {
        changes[key] = part[key];
      });
    });
    return changes;
  }

  /** Gives `el` the look the format painter took, and puts it away. */
  function paintOnto(el) {
    var taken = painting;
    // A kept painter goes on to the next element with the look it took.
    if (keptTool !== tool) useTool("select", true);
    if (!el || !taken) return;
    select(el);
    applyStyle(paintChanges(el, taken));
  }

  /**
   * Calls `fn` with each rule of the deck's stylesheets (not the editor's own), nested rules after
   * the rule that holds them.
   */
  function forEachDeckRule(fn) {
    var visit = function (rules) {
      Array.prototype.forEach.call(rules || [], function (rule) {
        fn(rule);
        if (rule.cssRules) visit(rule.cssRules);
      });
    };
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      if (sheet.ownerNode === style) return;
      try {
        visit(sheet.cssRules);
      } catch (e) {
        // A stylesheet from another origin (a web font service) cannot be read.
      }
    });
  }

  /**
   * What the deck's stylesheets say, from one walk through their rules: the CSS variables they
   * define (not the app's own) as `names`, with the value each first has in `scoped`, and the
   * font stacks they name, in `stacks`.
   */
  function deckRules() {
    var names = [];
    var scoped = {};
    var stacks = [];
    forEachDeckRule(function (rule) {
      var props = rule.style;
      if (!props) return;
      // Not an @font-face rule, which names the font it defines.
      if (rule.type !== 5 && props.fontFamily) stacks.push(props.fontFamily);
      for (var i = 0; i < props.length; i++) {
        var name = props[i];
        if (!/^--/.test(name) || /^--slop-/.test(name) || Object.prototype.hasOwnProperty.call(scoped, name)) continue;
        names.push(name);
        scoped[name] = props.getPropertyValue(name);
      }
    });
    return { names: names, scoped: scoped, stacks: stacks };
  }

  /** The values of the deck's CSS variables as `el` sees them, for showing it outside the slide. */
  function cssVariables(el) {
    var found = deckRules();
    var computed = getComputedStyle(el);
    var vars = {};
    found.names.slice(0, MAX_SVG_VARS).forEach(function (name) {
      var value = String(computed.getPropertyValue(name) || found.scoped[name] || "").trim();
      if (value) vars[name] = value;
    });
    return vars;
  }

  /**
   * The deck's style rules, for showing a drawing outside the slide: `fonts` its @font-face rules
   * and the stylesheets that cannot be read (a web font service's), imported, which work only in
   * the app's document; `css` the rest. Relative urls are made absolute.
   */
  function deckStyles() {
    var fonts = [];
    var css = [];
    var absolute = function (text, base) {
      return text.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g, function (all, quote, url) {
        url = url.trim();
        if (!url || /^([a-z][a-z\d+.-]*:|#|\/\/)/i.test(url)) return all;
        try {
          return 'url("' + new URL(url, base).href + '")';
        } catch (e) {
          return all;
        }
      });
    };
    var visit = function (sheet, depth) {
      var base = sheet.href || document.baseURI;
      var rules;
      try {
        rules = sheet.cssRules;
      } catch (e) {
        if (sheet.href) fonts.push('@import url("' + sheet.href + '");');
        return;
      }
      Array.prototype.forEach.call(rules || [], function (rule) {
        if (/^@import\b/i.test(rule.cssText)) {
          if (rule.styleSheet && depth < 4) visit(rule.styleSheet, depth + 1);
          return;
        }
        var text = absolute(rule.cssText, base);
        (/^@font-face\b/i.test(text) ? fonts : css).push(text);
      });
    };
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      if (sheet.ownerNode !== style && !sheet.disabled) visit(sheet, 0);
    });
    return { css: css.join("\n"), fonts: fonts.join("\n") };
  }

  /** The elements `el` sits in, outermost first, with their attributes (not the editor's marks). */
  function ancestorsOf(el) {
    var chain = [];
    for (var n = el.parentElement; n && chain.length < MAX_SVG_ANCESTORS; n = n.parentElement) {
      var attrs = {};
      Array.prototype.forEach.call(n.attributes, function (a) {
        if (/^on/i.test(a.name) || EDITOR_ATTRS.indexOf(a.name) >= 0) return;
        attrs[a.name] = a.value;
      });
      chain.unshift({ tag: n.localName, attrs: attrs });
    }
    return chain;
  }

  /**
   * The colors in the deck's CSS variables (`found`, from deckRules), for the color popover's
   * deck swatches. A plain color is read as it is written; anything else (a color's name, hsl(),
   * another variable) is given to an element for the browser to work out.
   */
  function deckColors(found) {
    var computed = getComputedStyle(slide);
    var probe = null;
    var worked = function (value) {
      if (!probe) {
        probe = document.createElement("span");
        probe.setAttribute("data-slop-ui", "");
        document.body.appendChild(probe);
      }
      probe.style.color = "";
      probe.style.color = value;
      return probe.style.color ? toHex(getComputedStyle(probe).color) : null;
    };
    var seen = {};
    var colors = [];
    for (var i = 0; i < found.names.length && colors.length < MAX_DECK_COLORS; i++) {
      var name = found.names[i];
      var value = String(computed.getPropertyValue(name) || found.scoped[name] || "").trim();
      var hex = toHex(value);
      if (hex === null && value) hex = worked(value);
      if (!hex || seen[hex]) continue;
      seen[hex] = true;
      colors.push({ name: name.slice(2), value: hex });
    }
    if (probe) document.body.removeChild(probe);
    return colors;
  }

  /** The font stacks the deck's styles name (`found`, from deckRules), by their first family, for the toolbar's font list. */
  function deckFonts(found) {
    var fonts = [];
    var seen = {};
    var add = function (stack) {
      var name = firstFamily(stack);
      if (!name || seen[name.toLowerCase()] || /^(inherit|initial|unset|revert|serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system)$/i.test(name)) return;
      seen[name.toLowerCase()] = { name: name, stack: String(stack).trim(), weights: [] };
      fonts.push(seen[name.toLowerCase()]);
    };
    found.stacks.forEach(add);
    if (document.fonts && document.fonts.forEach) {
      document.fonts.forEach(function (face) {
        add('"' + firstFamily(face.family) + '"');
        // The weights its files come in ("400", "bold", or a variable font's "100 900"), for the weight list.
        var font = seen[firstFamily(face.family).toLowerCase()];
        var range = String(face.weight || "").replace(/normal/g, "400").replace(/bold/g, "700").match(/\d+/g);
        if (!font || !range) return;
        for (var w = 100; w <= 900; w += 100) {
          if (w >= Number(range[0]) && w <= Number(range[range.length - 1]) && font.weights.indexOf(w) < 0) font.weights.push(w);
        }
        font.weights.sort(function (a, b) {
          return a - b;
        });
      });
    }
    Array.prototype.forEach.call(slide.querySelectorAll("[style*='font-family']"), function (el) {
      add(el.style.fontFamily);
    });
    return fonts;
  }

  // What the deck's stylesheets say (see deckRules), read once for the fonts and the colors.
  var deckFound = null;

  function reportColors() {
    window.parent.postMessage({ type: "slop:edit-colors", slide: slide.id, colors: deckColors(deckFound) }, "*");
  }

  function reportFonts() {
    window.parent.postMessage({ type: "slop:edit-fonts", slide: slide.id, fonts: deckFonts(deckFound) }, "*");
  }

  reportBackground();
  // The deck's fonts and colors take a walk through every style rule: after the slide has shown.
  afterPaint(function () {
    deckFound = deckRules();
    reportFonts();
    reportColors();
  });
  // Fonts that came in later join the list.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      if (deckFound) reportFonts();
    });
  }
})();
