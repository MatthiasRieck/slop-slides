  // ---- Tools and changes: adding text boxes, shapes and drawings with a tool, restyling,
  // restacking and deleting.

  /** Picks a tool; `tell` lets the app know, when the editor switched by itself. */
  function useTool(next, tell) {
    tool = TOOLS.indexOf(next) >= 0 ? next : "select";
    painting = tool === "paint" && selected ? paintableStyle(selected) : null;
    if (tool === "select") {
      document.documentElement.removeAttribute("data-slop-tool");
    } else {
      document.documentElement.setAttribute("data-slop-tool", tool);
      hover(null);
    }
    placeSvgButton();
    if (tell) window.parent.postMessage({ type: "slop:edit-tool", slide: slide.id, tool: tool }, "*");
  }

  /** The style for a new element: what the app sent, with fallbacks. */
  function styleFor(key) {
    var value = toolStyle[key];
    return value === undefined ? FALLBACK_STYLE[key] : value;
  }

  /** Where the pointer at (x, y) is on the slide, in slide pixels. */
  function slidePoint(x, y) {
    var rect = slide.getBoundingClientRect();
    var k = zoom();
    return { x: Math.round((x - rect.left) / k), y: Math.round((y - rect.top) / k) };
  }

  function addElement(kind, css, svg) {
    var el = svg ? document.createElementNS(SVG_NS, "svg") : document.createElement("div");
    el.setAttribute(ADDED, kind);
    el.setAttribute("style", css);
    slide.appendChild(el);
    return el;
  }

  function place(el, x, y, w, h) {
    el.style.left = x + "px";
    el.style.top = y + "px";
    if (w !== null) el.style.width = w + "px";
    if (h !== null) el.style.height = h + "px";
  }

  function borderCss(color, width, dash) {
    return color && width > 0 ? width + "px " + (dash === "dashed" || dash === "dotted" ? dash : "solid") + " " + color : "none";
  }

  /** Inline styles for text laid out in a flex column, so it can align top, middle or bottom. */
  function textCss() {
    var stroke = styleFor("stroke");
    var width = styleFor("strokeWidth");
    return (
      " display: flex; flex-direction: column; justify-content: " + (JUSTIFY[styleFor("valign")] || "flex-start") +
      "; text-align: " + styleFor("align") + "; color: " + styleFor("color") + "; font-size: " + styleFor("fontSize") + "px;" +
      (styleFor("fontFamily") ? " font-family: " + String(styleFor("fontFamily")).replace(/[;{}<>]/g, "") + ";" : "") +
      (styleFor("bold") ? " font-weight: 700;" : "") +
      (styleFor("italic") ? " font-style: italic;" : "") +
      (styleFor("underline") || styleFor("strike")
        ? " text-decoration-line:" + (styleFor("underline") ? " underline" : "") + (styleFor("strike") ? " line-through" : "") + ";"
        : "") +
      (styleFor("letterSpacing") ? " letter-spacing: " + Number(styleFor("letterSpacing")) + "px;" : "") +
      (styleFor("lineHeight") > 0 ? " line-height: " + Number(styleFor("lineHeight")) + ";" : "") +
      (styleFor("fill") ? " background-color: " + styleFor("fill") + ";" : "") +
      (stroke && width > 0 ? " border: " + borderCss(stroke, width, styleFor("dash")) + ";" : "")
    );
  }

  function newText(x, y, w) {
    var el = addElement(
      "text",
      "position: absolute; left: " + x + "px; top: " + y + "px;" + (w ? " width: " + w + "px;" : "") +
        " margin: 0; line-height: 1.2;" + textCss(),
    );
    var body = document.createElement("div");
    body.setAttribute(BODY_ATTR, "");
    body.textContent = "Text";
    el.appendChild(body);
    return el;
  }

  function newShape(kind, x, y, w, h) {
    if (OUTLINES[kind]) return newOutline(kind, x, y, w, h);
    var el = addElement(
      "shape",
      "position: absolute; left: " + x + "px; top: " + y + "px; width: " + w + "px; height: " + h + "px; margin: 0;" +
        " box-sizing: border-box; padding: 16px;" + (RADIUS[kind] ? " border-radius: " + RADIUS[kind] + ";" : "") + textCss(),
    );
    if (FIGURES[kind]) {
      var width = styleFor("strokeWidth");
      var paint = {
        fill: styleFor("fill") || null,
        stroke: width > 0 ? styleFor("stroke") || null : null,
        width: width,
        dash: DASHES[styleFor("dash")] ? styleFor("dash") : "solid",
      };
      el.style.removeProperty("background-color");
      ["border", "border-width", "border-style", "border-color"].forEach(function (prop) {
        el.style.removeProperty(prop);
      });
      el.setAttribute(SHAPE_ATTR, kind);
      paintFigure(el, paint);
    }
    return el;
  }

  /** A bracket or brace: a drawing with one stroke through its box (see `outlineData`). */
  function newOutline(kind, x, y, w, h) {
    var drawing = newDrawing({ x: x, y: y });
    drawing.path.setAttribute("fill", "none");
    drawing.svg.setAttribute("data-outline", kind);
    drawOutline(drawing.svg, x, y, w, h);
    return drawing.svg;
  }

  /** Fits outline `svg` (see newOutline) to the box at (x, y), w × h, in slide pixels. */
  function drawOutline(svg, x, y, w, h) {
    var path = vectorsOf(svg)[0];
    var stroke = parseFloat(path.getAttribute("stroke-width")) || 0;
    w = Math.max(w, stroke + 2);
    h = Math.max(h, stroke + 2);
    place(svg, x, y, w, h);
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    path.setAttribute("d", outlineData(svg.getAttribute("data-outline"), w, h, Math.ceil(stroke / 2)));
  }

  /**
   * The stroke of an outline `kind` across a w × h box, `pad` in from its edges: a bracket's
   * three straight sides, or a brace's curls (quadratic curves, so it never reads as a line).
   */
  function outlineData(kind, w, h, pad) {
    var r = function (n) {
      return roundTenth(n);
    };
    var left = pad;
    var right = w - pad;
    var top = pad;
    var bottom = h - pad;
    if (kind === "bracket") {
      return "M" + r(right) + " " + r(top) + " L" + r(left) + " " + r(top) + " L" + r(left) + " " + r(bottom) + " L" + r(right) + " " + r(bottom);
    }
    var mid = (left + right) / 2;
    var center = h / 2;
    var curl = Math.min(right - left, (bottom - top) / 4);
    return (
      "M" + r(right) + " " + r(top) +
      " Q" + r(mid) + " " + r(top) + " " + r(mid) + " " + r(top + curl) +
      " L" + r(mid) + " " + r(center - curl) +
      " Q" + r(mid) + " " + r(center) + " " + r(left) + " " + r(center) +
      " Q" + r(mid) + " " + r(center) + " " + r(mid) + " " + r(center + curl) +
      " L" + r(mid) + " " + r(bottom - curl) +
      " Q" + r(mid) + " " + r(bottom) + " " + r(right) + " " + r(bottom)
    );
  }

  function newDrawing(at) {
    var svg = addElement("drawing", "position: absolute; left: 0px; top: 0px; width: 1px; height: 1px; margin: 0; overflow: visible;", true);
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", styleFor("fill") || "none");
    path.setAttribute("stroke", styleFor("stroke") || BORDER_COLOR);
    path.setAttribute("stroke-width", String(styleFor("strokeWidth") || BORDER_WIDTH));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    if (DASHES[styleFor("dash")]) setDash(path, styleFor("dash"), parseFloat(path.getAttribute("stroke-width")));
    svg.appendChild(path);
    return { svg: svg, path: path, points: [[at.x, at.y]] };
  }

  function pathData(points, dx, dy) {
    // A tap draws a dot: a zero-length line, which round caps make visible.
    var all = points.length === 1 ? [points[0], points[0]] : points;
    return all.map(function (p, i) {
      return (i ? "L" : "M") + (p[0] - dx) + " " + (p[1] - dy);
    }).join(" ");
  }

  /** Starts adding an element with the current tool at the pointer. */
  function startCreating(event) {
    if (tool === "paint") {
      paintOnto(pickable(event.target, event.clientX, event.clientY));
      return;
    }
    var at = slidePoint(event.clientX, event.clientY);
    if (tool === "text") {
      // The text tool types into a text box or shape that is already there.
      var target = pickable(event.target, event.clientX, event.clientY);
      if (target && /^(text|shape)$/.test(target.getAttribute(ADDED) || "")) {
        useTool("select", true);
        startEditing(target, event.clientX, event.clientY);
        return;
      }
    }
    select(null);
    create = { tool: tool, x: event.clientX, y: event.clientY, at: at, el: null, moved: false, line: isLine(tool) };
    if (tool === "draw" || create.line) {
      create.drawing = newDrawing(at);
      create.el = create.drawing.svg;
      create.drawing.path.setAttribute("d", pathData(create.drawing.points, 0, 0));
    }
    if (create.line) {
      // An arrow or connector has a head where it is dragged to; a connector routes itself.
      create.heads = { start: null, end: tool === "line" ? null : "arrow" };
      if (tool === "elbow" || tool === "curve") create.el.setAttribute(ROUTE_ATTR, tool === "elbow" ? "elbow" : "curved");
    }
  }

  function createTo(event) {
    var dx = event.clientX - create.x;
    var dy = event.clientY - create.y;
    if (!create.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    create.moved = true;
    var at = slidePoint(event.clientX, event.clientY);
    if (create.line) {
      var to = event.shiftKey ? snapLine(create.at, at) : at;
      var hit = event.metaKey || event.ctrlKey ? null : stickTarget(to, create.el);
      if (hit && (hit.edge || hit.site) && !event.shiftKey) to = endSpot(hit, [create.at.x, create.at.y], create.el);
      drawLine(create, to, hit);
      previewStick(hit);
      return;
    }
    if (create.drawing) {
      var points = create.drawing.points;
      var last = points[points.length - 1];
      if (Math.abs(at.x - last[0]) < DRAW_STEP && Math.abs(at.y - last[1]) < DRAW_STEP) return;
      points.push([at.x, at.y]);
      create.drawing.path.setAttribute("d", pathData(points, 0, 0));
      return;
    }
    var w = Math.abs(at.x - create.at.x);
    var h = Math.abs(at.y - create.at.y);
    if (event.shiftKey) w = h = Math.max(w, h);
    var x = at.x < create.at.x ? create.at.x - w : create.at.x;
    var y = at.y < create.at.y ? create.at.y - h : create.at.y;
    if (!create.el) create.el = create.tool === "text" ? newText(x, y, w) : newShape(create.tool, x, y, w, h);
    if (OUTLINES[create.tool]) drawOutline(create.el, x, y, w, h);
    else place(create.el, x, y, w, create.tool === "text" ? null : h);
    fitFigure(create.el);
    placeHandles();
  }

  function finishCreating() {
    var done = create;
    create = null;
    if (done.line) {
      if (!done.moved) drawLine(done, { x: done.at.x + SHAPE_SIZE.w, y: done.at.y });
      previewStick(null);
      var ends = done.points;
      var stuck = false;
      ENDS.forEach(function (end, i) {
        var hit = stickTarget({ x: ends[i][0], y: ends[i][1] }, done.el);
        if (hit) stick(done.el, end, hit);
        stuck = stuck || !!hit;
      });
      // A connector leaves what its ends are stuck to out of their sides.
      if (stuck && routeOf(done.el)) writeLine(done.el, ends, done.heads, true);
      useTool("select", true);
      select(done.el);
      commit();
      placeHandles();
      return;
    }
    if (done.drawing) {
      finishDrawing(done.drawing);
      placeHandles();
      return;
    }
    var el = done.el;
    if (!el) {
      var size = OUTLINES[done.tool] ? OUTLINE_SIZE : SHAPE_SIZE;
      el = done.tool === "text" ? newText(done.at.x, done.at.y) : newShape(done.tool, done.at.x, done.at.y, size.w, size.h);
      fitFigure(el);
    }
    useTool("select", true);
    select(el);
    // A new text box starts out typing, with its placeholder selected; it is saved when done.
    if (done.tool === "text") startEditing(el);
    else commit();
  }

  /** Fits the drawing's box around its line, so it moves, scales and rotates like any element. */
  function finishDrawing(drawing) {
    var points = drawing.points;
    var xs = points.map(function (p) {
      return p[0];
    });
    var ys = points.map(function (p) {
      return p[1];
    });
    var pad = Math.ceil((parseFloat(drawing.path.getAttribute("stroke-width")) || 0) / 2);
    var left = Math.min.apply(null, xs) - pad;
    var top = Math.min.apply(null, ys) - pad;
    var w = Math.max.apply(null, xs) - left + pad;
    var h = Math.max.apply(null, ys) - top + pad;
    place(drawing.svg, left, top, w, h);
    drawing.svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    drawing.path.setAttribute("d", pathData(drawing.points, left, top));
    commit();
  }

  function cancelCreating() {
    if (!create) return;
    if (create.el && create.el.parentElement) create.el.parentElement.removeChild(create.el);
    create = null;
  }

  /**
   * Restyles the selection with the toolbar's `changes` and saves it (or, while its text is
   * being edited, once that is done). Text styles go to all of its text: what its own inline
   * elements set for them gives way.
   */
  function applyStyle(changes) {
    var el = selected;
    if (!el || !slide.contains(el)) return;
    var has = function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    };
    if (autofit) autofit.unfit(el);
    // A box saved with its text directly in it (see 00-header.js) gets its body now.
    if (isTextBox(el) && el.textContent.trim()) ensureBody(el);
    var text = {};
    TEXT_KEYS.forEach(function (key) {
      if (has(key) && key !== "link" && key !== "script") text[key] = changes[key];
    });
    if (Object.keys(text).length && vectorsOf(el).length === 0) {
      Array.prototype.slice.call(el.querySelectorAll("*")).reverse().forEach(function (inner) {
        if (INLINE.test(inner.tagName) && inner.namespaceURI !== SVG_NS) stripFormatting(inner, text);
      });
    }
    if (has("color")) el.style.color = changes.color || "";
    if (has("fontSize")) el.style.fontSize = changes.fontSize > 0 ? Math.round(changes.fontSize) + "px" : "";
    if (has("fontFamily")) el.style.fontFamily = changes.fontFamily || "";
    if (has("bold")) el.style.fontWeight = changes.bold ? "700" : "400";
    if (has("italic")) el.style.fontStyle = changes.italic ? "italic" : "normal";
    if (has("underline") || has("strike")) {
      removeLine(el, "underline");
      removeLine(el, "line-through");
      var lines = [];
      if (has("underline") ? changes.underline : decorated(el, "underline")) lines.push("underline");
      if (has("strike") ? changes.strike : decorated(el, "line-through")) lines.push("line-through");
      if (lines.length) el.style.setProperty("text-decoration-line", lines.join(" "));
      else if (decorated(el, "underline") || decorated(el, "line-through")) el.style.setProperty("text-decoration-line", "none");
    }
    if (has("script")) {
      Array.prototype.slice.call(el.querySelectorAll("sup, sub")).forEach(unwrap);
      if (changes.script === "sup" || changes.script === "sub") {
        var script = document.createElement(changes.script);
        var into = ensureBody(el, true);
        while (into.firstChild) script.appendChild(into.firstChild);
        into.appendChild(script);
      }
    }
    if (has("letterSpacing")) el.style.letterSpacing = changes.letterSpacing ? changes.letterSpacing + "px" : "";
    if (has("lineHeight")) el.style.lineHeight = changes.lineHeight > 0 ? String(Math.round(changes.lineHeight * 100) / 100) : "";
    if (has("autofit")) setAutofit(el, changes.autofit);
    if (has("align") && /^(left|center|right)$/.test(changes.align)) {
      el.style.textAlign = changes.align;
      withDescendants(el).filter(isList).forEach(function (list) {
        alignList(list, changes.align, depthOf(list, el));
      });
    }
    if (has("valign") && JUSTIFY[changes.valign]) {
      var computed = getComputedStyle(el);
      if (/flex/.test(computed.display || "")) {
        el.style[/column/.test(computed.flexDirection || "") ? "justifyContent" : "alignItems"] = JUSTIFY[changes.valign];
      }
    }
    // An old cut-out becomes a figure to take what only a figure can show.
    if (["stroke", "strokeWidth", "dash", "shadow", "flipX", "flipY"].some(has)) upgradeCutOut(el);
    var vectors = vectorsOf(el);
    if (figureOf(el)) {
      if (has("adjust")) setAdjust(el, Number(changes.adjust));
      if (has("fill") || has("stroke") || has("strokeWidth") || has("dash")) {
        var paint = figurePaint(el);
        if (has("fill")) paint.fill = changes.fill || null;
        if (has("stroke")) paint.stroke = changes.stroke || null;
        if (has("strokeWidth")) paint.width = Math.max(0, changes.strokeWidth || 0);
        if (has("dash") && DASHES[changes.dash]) paint.dash = changes.dash;
        // Picking a border color or dashes shows a border; picking a width gives it a color.
        if (((has("stroke") && paint.stroke) || (has("dash") && paint.dash !== "solid")) && !paint.width) paint.width = BORDER_WIDTH;
        if ((has("strokeWidth") || has("dash")) && paint.width && !paint.stroke) paint.stroke = BORDER_COLOR;
        paintFigure(el, paint);
      }
    } else if (vectors.length) {
      var line = lineOf(el);
      vectors.forEach(function (vector) {
        // A line's heads take its color and width when it is redrawn.
        if (vector.hasAttribute(HEAD_ATTR) && line) return;
        if (has("fill")) vector.setAttribute("fill", changes.fill || "none");
        if (has("stroke")) vector.setAttribute("stroke", changes.stroke || "none");
        if (has("strokeWidth")) vector.setAttribute("stroke-width", String(Math.max(0, changes.strokeWidth || 0)));
        if (has("dash") || has("strokeWidth")) {
          setDash(vector, has("dash") && DASHES[changes.dash] ? changes.dash : dashOf(vector), parseFloat(vector.getAttribute("stroke-width")));
        }
      });
      // A line's heads and the box around it go with its width; its route and heads change how it is drawn.
      if (line && ["stroke", "strokeWidth", "headStart", "headEnd", "route"].some(has)) {
        var heads = {
          start: has("headStart") ? (HEADS[changes.headStart] ? changes.headStart : null) : line.heads.start,
          end: has("headEnd") ? (HEADS[changes.headEnd] ? changes.headEnd : null) : line.heads.end,
        };
        var points = slidePoints(el, line);
        if (has("route")) {
          if (ROUTES[changes.route]) el.setAttribute(ROUTE_ATTR, changes.route);
          else el.removeAttribute(ROUTE_ATTR);
        }
        writeLine(el, points, heads);
      }
    } else {
      if (has("fill")) el.style.backgroundColor = changes.fill || "transparent";
      if ((has("stroke") || has("strokeWidth") || has("dash")) && !isCutOut(el)) {
        var now = describe(el);
        var color = has("stroke") ? changes.stroke : now.stroke;
        var width = has("strokeWidth") ? changes.strokeWidth : now.strokeWidth;
        var dash = has("dash") && DASHES[changes.dash] ? changes.dash : now.dash;
        // Picking a border color or dashes shows a border; picking a width gives it a color.
        if ((has("stroke") && color) || (has("dash") && dash !== "solid")) width = width || BORDER_WIDTH;
        if ((has("strokeWidth") || has("dash")) && width && !color) color = BORDER_COLOR;
        el.style.border = borderCss(color, width, dash);
      }
    }
    applyLook(el, changes);
    if (!el.getAttribute("style")) el.removeAttribute("style");
    if (editing) tidy(el);
    refit(el);
    placeHandles();
    report();
    if (!editing) commit();
  }

  function overlaps(a, b) {
    var r = a.getBoundingClientRect();
    var s = b.getBoundingClientRect();
    return r.left <= s.right && s.left <= r.right && r.top <= s.bottom && s.top <= r.bottom;
  }

  /**
   * Moves the selection up or down the stack among its siblings with an inline z-index, so the
   * layout stays put: "forward" / "backward" past the next element it overlaps (with `any`, the
   * next one, overlapping or not), "front" / "back" past all of them.
   */
  function restack(where, any) {
    var el = selected;
    if (!el || !slide.contains(el) || ["front", "forward", "backward", "back"].indexOf(where) < 0) return;
    var parent = el.parentElement;
    // From the Layers panel, it goes among the layers it is listed with, wherever they sit.
    var siblings = any ? inDocumentOrder(layerPeers(el)) : Array.prototype.filter.call(parent.children, function (s) {
      return !/^(script|style|template)$/i.test(s.tagName) && !s.classList.contains("notes") && !s.classList.contains("narration") && !s.classList.contains("slop-review");
    });
    var layer = function (s) {
      var style = getComputedStyle(s);
      var z = parseInt(style.zIndex, 10);
      var positioned = style.position && style.position !== "static";
      return { el: s, i: siblings.indexOf(s), z: positioned ? (isNaN(z) ? 0 : z) : STATIC_Z };
    };
    var order = function (a, b) {
      return a.z - b.z || a.i - b.i;
    };
    var mine = layer(el);
    var up = where === "front" || where === "forward";
    var past = siblings
      .filter(function (s) {
        return s !== el && (any || where === "front" || where === "back" || overlaps(s, el));
      })
      .map(layer)
      .filter(function (o) {
        return up ? order(o, mine) > 0 : order(o, mine) < 0;
      })
      .sort(order);
    if (!past.length) return;
    var target = where === "front" || where === "backward" ? past[past.length - 1] : past[0];
    // Equal z-indexes paint in document order.
    var z = up
      ? target.z === STATIC_Z ? 0 : target.i < mine.i ? target.z : target.z + 1
      : target.z === STATIC_Z ? -1 : target.i > mine.i ? target.z : target.z - 1;
    var style = getComputedStyle(el);
    if (!style.position || style.position === "static") el.style.position = "relative";
    el.style.zIndex = String(z);
    // Below zero it would drop behind its parent's background, unless the parent keeps it in.
    if (z < 0 && parent !== slide) parent.style.isolation = "isolate";
    placeHandles();
    commit();
  }

  function removeSelected() {
    var group = movable();
    if (!group.length) return;
    finishEditing();
    select(null);
    group.forEach(removeElement);
    commit();
  }

  function removeElement(el) {
    // Keep its slot so the rest of the layout does not reflow; a resized element already has one.
    var placeholder = placeholderOf(el);
    if (placeholder) {
      placeholder.removeAttribute(PLACEHOLDER);
      placeholder.setAttribute(DELETED, "");
    } else if (el.parentElement && !/^(absolute|fixed)$/.test(getComputedStyle(el).position) && getComputedStyle(el).display !== "none") {
      el.parentElement.insertBefore(slotFor(el, DELETED), el);
    }
    if (el.parentElement) el.parentElement.removeChild(el);
  }

