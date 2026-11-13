  // ---- Elements: the slide's markup, paths to its elements, picking and selecting them, what the
  // toolbar shows for one, its transforms, and placing the handles and the SVG editor's button.

  /** The slide's markup without anything the editor or the player added. */
  function serialize() {
    var copy = cleanCopy(slide);
    copy.classList.remove("active");
    return copy.outerHTML;
  }

  /** A copy of `el` without the editor's marks, or the font sizes a text fit set. */
  function cleanCopy(el) {
    var copy = el.cloneNode(true);
    var originals = withDescendants(el);
    withDescendants(copy).forEach(function (node, i) {
      EDITOR_ATTRS.forEach(function (name) {
        node.removeAttribute(name);
      });
      var before = autofit && autofit.original(originals[i]);
      if (!before) return;
      if (before.value) node.style.setProperty("font-size", before.value, before.priority);
      else node.style.removeProperty("font-size");
      if (!node.getAttribute("style")) node.removeAttribute("style");
    });
    return copy;
  }

  function withDescendants(el) {
    return [el].concat(Array.prototype.slice.call(el.querySelectorAll("*")));
  }

  function commit() {
    if (batching) return;
    followLines([]);
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
    var markup = serialize();
    if (markup === saved) return;
    saved = markup;
    window.parent.postMessage(
      { type: "slop:edit-commit", slide: slide.id, markup: markup, select: pathOf(selected), also: extras.map(pathOf) },
      "*",
    );
  }

  /** Child-index path from the slide to `el`, to select it again after the preview reloads. */
  function pathOf(el) {
    if (!el || !slide.contains(el) || el === slide) return null;
    var path = [];
    for (var node = el; node !== slide; node = node.parentElement) {
      path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
    }
    return path;
  }

  function atPath(path) {
    var el = slide;
    for (var i = 0; path && i < path.length && el; i++) el = el.children[path[i]];
    return el && el !== slide ? el : null;
  }

  /**
   * The text element a list belongs to: its outermost list, and when that is all its parent
   * holds (as a list the editor made from the parent's lines is), the parent. Items are lines
   * of one text, not elements of their own: selecting one would lose the list's editing.
   */
  function listHolder(el) {
    var list = el.closest("li, ul, ol");
    if (!list || !slide.contains(list) || list === slide) return el;
    for (var up = list.parentElement; up && up !== slide && slide.contains(up); up = up.parentElement) {
      if (/^(ul|ol|li)$/i.test(up.tagName)) list = up;
    }
    var parent = list.parentElement;
    var alone = parent !== slide && parent.children.length === 1 && parent.textContent.trim() === list.textContent.trim();
    return alone ? parent : list;
  }

  /** The element to select for `el`: not inline text runs, whole SVG drawings, whole lists. */
  function selectable(el) {
    if (!el || el.nodeType !== 1 || !slide.contains(el) || el === slide || el.closest(SLOTS)) return null;
    var svg = el.closest("svg");
    while (svg && svg.parentElement && svg.parentElement.closest("svg")) svg = svg.parentElement.closest("svg");
    if (svg && slide.contains(svg)) el = svg;
    // A text box or shape is one text: nothing in it is picked on its own.
    var body = el.closest("[" + BODY_ATTR + "]");
    if (body && body.parentElement && body.parentElement !== slide && slide.contains(body)) el = body.parentElement;
    var box = el.closest("[" + ADDED + '="text"], [' + ADDED + '="shape"]');
    if (box && slide.contains(box)) el = box;
    el = listHolder(el);
    while (el.parentElement !== slide && getComputedStyle(el).display === "inline") {
      // A link around an element without text (display: contents) leaves the element selected.
      if (getComputedStyle(el.parentElement).display === "contents") break;
      el = el.parentElement;
    }
    return groupFor(el);
  }

  /**
   * What selecting `el` selects: the outermost group it is in, or once that group was entered
   * (with a double-click), the next one in, or `el`.
   */
  function groupFor(el) {
    var chain = [];
    for (var up = el.parentElement; up && up !== slide; up = up.parentElement) {
      if (up.hasAttribute(GROUP_ATTR)) chain.push(up);
    }
    if (!chain.length) return el;
    var at = enteredGroup ? chain.indexOf(enteredGroup) : -1;
    if (at < 0) return chain[chain.length - 1];
    return at === 0 ? el : chain[at - 1];
  }

  /**
   * What a pointer at (x, y) on `target` picks: the top-most element there that shows
   * something, so invisible overlays (hover zones, empty wrappers) do not get in the way.
   */
  function pickable(target, x, y) {
    var stack = document.elementsFromPoint && x !== undefined ? document.elementsFromPoint(x, y) : [];
    // Only a spot the pointer is at can miss a line in its box; the target alone was hit.
    var spot = stack.length > 0;
    if (!stack.length) {
      for (var node = target && target.nodeType === 1 ? target : target && target.parentElement; node; node = node.parentElement) {
        stack.push(node);
      }
    }
    for (var i = 0; i < stack.length; i++) {
      if (stack[i] === slide) return null;
      var el = selectable(stack[i]);
      // A locked element is out of the way: what is under it is picked. So is the empty part of
      // a line's box.
      if (el && paints(el) && !isLocked(el) && (!spot || !lineOf(el) || onLine(el, lineOf(el), x, y))) return el;
    }
    return null;
  }

  function mark(el, name, on) {
    if (!el) return;
    if (on) el.setAttribute(name, "");
    else el.removeAttribute(name);
  }

  function select(el) {
    // Selecting what is outside the group being worked in leaves it.
    if (enteredGroup && !(el && el !== enteredGroup && enteredGroup.contains(el))) enteredGroup = null;
    if (el === selected && !extras.length) return;
    clearExtras();
    mark(selected, "data-slop-selected", false);
    selected = el;
    mark(selected, "data-slop-selected", true);
    placeHandles();
    report();
  }

  /** Tells the app what its toolbar shows for the selection. */
  function report() {
    reportFrame = 0;
    window.parent.postMessage({ type: "slop:edit-selection", slide: slide.id, selected: !!selected, selection: describe(selected) }, "*");
  }

  /** Reports once per frame, however often the text selection moves while typing. */
  function scheduleReport() {
    if (!reportFrame) reportFrame = window.requestAnimationFrame(report);
  }

  /** `#rrggbb` for a CSS color, or null when it is transparent or not a plain color. */
  function toHex(value) {
    value = String(value || "").trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(value)) return value;
    if (/^#[0-9a-f]{3}$/.test(value)) return "#" + value[1] + value[1] + value[2] + value[2] + value[3] + value[3];
    var m = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
    if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return null;
    return "#" + [m[1], m[2], m[3]].map(function (n) {
      return ("0" + Math.min(255, Math.round(parseFloat(n))).toString(16)).slice(-2);
    }).join("");
  }

  /** The shapes in a drawing, whose fill and stroke stand for the drawing's. */
  function vectorsOf(el) {
    return el.getAttribute(ADDED) === "drawing"
      ? Array.prototype.slice.call(el.querySelectorAll("path, line, polyline, polygon, rect, circle, ellipse"))
      : [];
  }

  function paintOf(vector, attr) {
    var value = vector && vector.getAttribute(attr);
    return value && value !== "none" ? toHex(value) : null;
  }

  /** Which way `el` lays out its text vertically, when it is a flex box; null otherwise. */
  function valignOf(style) {
    if (!/flex/.test(style.display || "")) return null;
    var value = /column/.test(style.flexDirection || "") ? style.justifyContent : style.alignItems;
    return /center/.test(value) ? "middle" : /end/.test(value) ? "bottom" : "top";
  }

  function weightOf(style) {
    return style.fontWeight === "bold" ? 700 : parseInt(style.fontWeight, 10) || 400;
  }

  /** The first family of a CSS `font-family` stack, unquoted. */
  function firstFamily(stack) {
    return String(stack || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  }

  /** Whether `node` (an element) shows `line` ("underline" or "line-through"), from it or an ancestor. */
  function decorated(node, line) {
    var tags = line === "underline" ? /^u$/i : /^(s|strike|del)$/i;
    for (var n = node; n && n.nodeType === 1 && n !== slide.parentElement; n = n.parentElement) {
      var style = getComputedStyle(n);
      if (tags.test(n.tagName) || (style.textDecorationLine || "").indexOf(line) >= 0 || (style.textDecoration || "").indexOf(line) >= 0) {
        return true;
      }
      if (n === slide) break;
    }
    return false;
  }

  /** The element the text selection starts in, while `el` is being edited; otherwise `el`. */
  function textNodeOf(el) {
    var range = editing === el ? editRange() : null;
    if (!range) return el;
    var node = range.startContainer;
    if (node.nodeType === 1 && !range.collapsed && node.childNodes[range.startOffset]) node = node.childNodes[range.startOffset];
    if (node.nodeType !== 1) node = node.parentNode;
    return node && node.nodeType === 1 && el.contains(node) ? node : el;
  }

  /** The link `el` (or the text at `node` in it) is in, or that wraps all of its text. */
  function linkOf(el, node) {
    var at = (node || el).closest("a");
    if (at && (slide.contains(at) || at === el)) return at;
    var root = textRoot(el);
    var only = root.children.length === 1 && root.firstElementChild;
    return only && /^a$/i.test(only.tagName) && only.textContent.trim() === root.textContent.trim() ? only : null;
  }

  /** The line height as a multiple of the font size; null when it is `normal`. */
  function lineHeightOf(style) {
    var size = parseFloat(style.fontSize);
    var value = style.lineHeight;
    if (!value || value === "normal") return null;
    if (/px$/.test(value)) return size ? Math.round((parseFloat(value) / size) * 100) / 100 : null;
    return parseFloat(value) || null;
  }

  /** What the toolbar shows for `el`: its kind, text styles (of the selected text, while typing), fill and border. */
  function describe(el) {
    if (!el) return null;
    if (isGroup(el)) {
      // A group shows the look of the first thing in it, which its restyles go to as well.
      var first = leavesOf([el])[0];
      var inside = first ? describe(first) : describe(document.createElement("div"));
      return Object.assign(inside, {
        kind: "group",
        group: true,
        locked: isLocked(el),
        flippable: false,
        flipX: false,
        flipY: false,
        line: null,
        adjust: null,
        editing: false,
        range: false,
        list: null,
      });
    }
    var style = getComputedStyle(el);
    var tag = el.tagName.toLowerCase();
    var kind = el.getAttribute(ADDED) || (/^(img|svg|video|canvas|picture|iframe|object|embed)$/.test(tag) ? "media" : "element");
    var vectors = vectorsOf(el);
    var first = vectors[0];
    var borderWidth = style.borderTopStyle && style.borderTopStyle !== "none" ? parseFloat(style.borderTopWidth) || 0 : 0;
    var align = style.textAlign || "left";
    var node = textNodeOf(el);
    var text = node === el ? style : getComputedStyle(node);
    var range = editing === el ? editRange() : null;
    var script = node.closest("sup, sub");
    var link = linkOf(el, node);
    var list = listKindOf(el);
    // A shrunk box reports the sizes it was given, not the ones it shrank to.
    var fit = autofit ? autofit.scale(el.closest('[data-autofit="shrink"]') || el) : 1;
    var spacing = parseFloat(text.letterSpacing);
    var look = lookOf(el, style);
    var figure = figureOf(el) ? figurePaint(el) : null;
    var line = kind === "drawing" ? lineOf(el) : null;
    var borderDash = /^(dashed|dotted)$/.test(style.borderTopStyle || "") ? style.borderTopStyle : "solid";
    return {
      kind: kind,
      text: kind !== "drawing" && kind !== "media",
      vector: kind === "drawing",
      color: toHex(text.color),
      fontSize: Math.round(parseFloat(text.fontSize) / fit) || null,
      fontFamily: firstFamily(text.fontFamily) || null,
      bold: weightOf(text) >= 600,
      italic: text.fontStyle === "italic",
      underline: decorated(node, "underline"),
      strike: decorated(node, "line-through"),
      script: script && el.contains(script) ? script.tagName.toLowerCase() : null,
      letterSpacing: isFinite(spacing) ? Math.round(spacing * 10) / 10 : 0,
      lineHeight: lineHeightOf(style),
      align: /center/.test(align) ? "center" : /right|end/.test(align) ? "right" : "left",
      valign: valignOf(style),
      list: list,
      link: link ? link.getAttribute("href") || "" : null,
      autofit: /^(shrink|grow)$/.test(el.getAttribute("data-autofit") || "") ? el.getAttribute("data-autofit") : null,
      editing: editing === el,
      range: !!range && !range.collapsed,
      fill: figure ? figure.fill : first ? paintOf(first, "fill") : toHex(style.backgroundColor),
      stroke: figure ? figure.stroke : first ? paintOf(first, "stroke") : borderWidth ? toHex(style.borderTopColor) : null,
      strokeWidth: figure ? figure.width : first ? parseFloat(first.getAttribute("stroke-width")) || 0 : borderWidth,
      dash: figure ? figure.dash : first ? dashOf(first) : borderDash,
      line: line ? { start: line.heads.start, end: line.heads.end, route: line.route || "straight" } : null,
      adjust: figure && FIGURES[figureOf(el)].adjust
        ? Object.assign({}, FIGURES[figureOf(el)].adjust, { value: adjustOf(el) })
        : null,
      opacity: look.opacity,
      shadow: look.shadow,
      radius: look.radius,
      clipped: look.clipped,
      image: look.image,
      fit: look.fit,
      fitPosition: look.fitPosition,
      alt: look.alt,
      flippable: look.flippable,
      flipX: look.flipX,
      flipY: look.flipY,
      group: false,
      locked: isLocked(el),
    };
  }

  /** Marks `el` as under the pointer: outlined, or a line glowing along its stroke rather than boxed in. */
  function hover(el) {
    if (el === hovered) return;
    mark(hovered, "data-slop-hover", false);
    hovered = el;
    if (hovered) hovered.setAttribute("data-slop-hover", lineOf(hovered) ? "line" : "");
  }

  /** The element's inline `translate` offset in slide pixels. */
  function offsetOf(el) {
    var parts = (el.style.translate || "").match(/-?[\d.]+(?=px)/g) || [];
    return { x: parseFloat(parts[0] || "0"), y: parseFloat(parts[1] || "0") };
  }

  function moveTo(el, x, y) {
    x = Math.round(x);
    y = Math.round(y);
    setInline(el, "translate", x === 0 && y === 0 ? null : x + "px " + y + "px");
  }

  /** The element's rotation in degrees and its (uniform) scale, inline or from the stylesheet. */
  function angleOf(el) {
    var match = (el.style.rotate || getComputedStyle(el).rotate || "").match(/^(-?[\d.]+)deg$/);
    return match ? parseFloat(match[1]) : 0;
  }
  function scaleOf(el) {
    return parseScale(el.style.scale || getComputedStyle(el).scale);
  }
  function parseScale(value) {
    var parts = String(value || "").trim().split(/\s+/).map(parseFloat);
    var x = isFinite(parts[0]) && parts[0] > 0 ? parts[0] : 1;
    var y = isFinite(parts[1]) && parts[1] > 0 ? parts[1] : x;
    return { x: x, y: y };
  }

  /** What the stylesheet alone gives `el` for `prop`. */
  function sheetValue(el, prop) {
    var inline = el.style[prop];
    if (!inline) return getComputedStyle(el)[prop];
    var priority = el.style.getPropertyPriority(prop);
    el.style[prop] = "";
    var value = getComputedStyle(el)[prop];
    el.style.setProperty(prop, inline, priority);
    return value;
  }

  /** The element's 3D tilt in degrees: around its horizontal (x) and vertical (y) axis. */
  function tiltOf(el) {
    var match = (el.style.transform || "").match(TILT);
    return match ? { x: parseFloat(match[1]), y: parseFloat(match[2]) } : { x: 0, y: 0 };
  }

  /**
   * Tilts `el` in depth with an inline `transform` (there is no separate property for it), seen
   * with perspective. It is `!important` so entrance animations, which animate `transform`,
   * cannot undo it, and keeps whatever `transform` the element already had after the tilt.
   */
  function tiltTo(el, x, y) {
    x = wrapAngle(x);
    y = wrapAngle(y);
    var inline = el.style.transform;
    var sheet = sheetValue(el, "transform");
    // An entrance animation that ended leaves the identity matrix.
    sheet = !sheet || sheet === "none" || sheet === "matrix(1, 0, 0, 1, 0, 0)" ? "" : sheet;
    var rest = inline ? inline.replace(TILT, "") : sheet;
    if (x || y) {
      var tilt = "perspective(" + PERSPECTIVE + "px) rotateX(" + x + "deg) rotateY(" + y + "deg)";
      setInline(el, "transform", rest ? tilt + " " + rest : tilt, "important");
    } else {
      setInline(el, "transform", rest && rest !== sheet ? rest : null);
    }
  }

  /** Whole degrees in (-180, 180]. */
  function wrapAngle(degrees) {
    degrees = Math.round(degrees) % 360;
    if (degrees > 180) degrees -= 360;
    if (degrees <= -180) degrees += 360;
    return degrees;
  }

  function rotateTo(el, degrees) {
    degrees = wrapAngle(degrees);
    var sheet = sheetValue(el, "rotate");
    var same = degrees === 0 ? !sheet || sheet === "none" || sheet === "0deg" : sheet === degrees + "deg";
    setInline(el, "rotate", same ? null : degrees + "deg");
  }

  function scaleTo(el, x, y) {
    x = Math.max(MIN_SCALE, Math.round(x * 1000) / 1000);
    y = Math.max(MIN_SCALE, Math.round(y * 1000) / 1000);
    var sheet = parseScale(sheetValue(el, "scale"));
    setInline(el, "scale", sheet.x === x && sheet.y === y ? null : x === y ? String(x) : x + " " + y);
  }

  /** Sets (or with null, drops) an inline transform; `data-moved` marks any hand transform. */
  function setInline(el, prop, value, priority) {
    if (value === null) el.style.removeProperty(prop);
    else el.style.setProperty(prop, value, priority || "");
    if (!el.getAttribute("style")) el.removeAttribute("style");
    mark(el, MOVED, !!(el.style.translate || el.style.rotate || el.style.scale || TILT.test(el.style.transform || "")));
    placeHandles();
  }

  /** The center of the element's box on screen; a tilt in perspective would shift its bounds. */
  function centerOf(el) {
    var inline = el.style.transform || "";
    var tilted = TILT.test(inline);
    var priority = el.style.getPropertyPriority("transform");
    if (tilted) el.style.setProperty("transform", inline.replace(TILT, "") || "none", priority);
    var rect = el.getBoundingClientRect();
    if (tilted) el.style.setProperty("transform", inline, priority);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** The element's untransformed size, in slide pixels. */
  function sizeOf(el) {
    var computed = getComputedStyle(el);
    var px = function (name) { return parseFloat(computed[name]) || 0; };
    var contentBox = computed.boxSizing !== "border-box";
    // offsetWidth/Height round to whole pixels, which can shift flex/grid siblings.
    return {
      w: /px$/.test(computed.width) ? px("width") + (contentBox ? px("paddingLeft") + px("paddingRight") + px("borderLeftWidth") + px("borderRightWidth") : 0) : el.offsetWidth || 0,
      h: /px$/.test(computed.height) ? px("height") + (contentBox ? px("paddingTop") + px("paddingBottom") + px("borderTopWidth") + px("borderBottomWidth") : 0) : el.offsetHeight || 0,
    };
  }

  /** Screen pixels per slide pixel. */
  function zoom() {
    return overflow.zoom(slide);
  }

  /**
   * The frame around `el` as it shows, on screen: its center (x, y), size (w, h) and rotation
   * (angle). That is its box, or under a tilt the extent of its perspective. The frame turns with
   * the rotation, so a rotated element's extent is measured without it and put back in its place.
   */
  function shownFrame(el) {
    var angle = angleOf(el);
    if (!TILT.test(el.style.transform || "")) {
      var center = centerOf(el);
      var size = sizeOf(el);
      var scale = scaleOf(el);
      return { x: center.x, y: center.y, w: size.w * scale.x * zoom(), h: size.h * scale.y * zoom(), angle: angle };
    }
    if (!angle) {
      var rect = el.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, w: rect.width, h: rect.height, angle: 0 };
    }
    var turned = centerOf(el);
    var rotate = el.style.rotate;
    var priority = el.style.getPropertyPriority("rotate");
    el.style.setProperty("rotate", "none", "important");
    var extent = el.getBoundingClientRect();
    var upright = centerOf(el);
    el.style.setProperty("rotate", rotate, priority);
    var off = turn(extent.left + extent.width / 2 - upright.x, extent.top + extent.height / 2 - upright.y, angle);
    return { x: turned.x + off.x, y: turned.y + off.y, w: extent.width, h: extent.height, angle: angle };
  }

  /**
   * How far the sides of `el` must go for those of its frame to go one pixel: more the further it
   * is tilted away, which would leave the handles behind the pointer.
   */
  function spreadOf(el) {
    if (!TILT.test(el.style.transform || "")) return { x: 1, y: 1 };
    var frame = shownFrame(el);
    var size = sizeOf(el);
    var scale = scaleOf(el);
    var spread = function (box, shown) {
      return shown > 0 ? Math.min(MAX_SPREAD, (box * zoom()) / shown) : MAX_SPREAD;
    };
    return { x: spread(size.w * scale.x, frame.w), y: spread(size.h * scale.y, frame.h) };
  }

  /** Lays the handles over the selection's frame, turned with it; they keep their size on screen. */
  function placeHandles() {
    scheduleSlideChecks();
    scheduleGeometry();
    // A locked element shows its frame, but no handles to change it.
    mark(ui, "data-locked", !!selected && isLocked(selected));
    placeFrames();
    placeSvgButton();
    if (placePoints() || !selected || editing || extras.length || !slide.contains(selected)) {
      ui.style.display = "none";
      return;
    }
    var frame = shownFrame(selected);
    ui.style.display = "";
    ui.style.left = frame.x - frame.w / 2 + "px";
    ui.style.top = frame.y - frame.h / 2 + "px";
    ui.style.width = frame.w + "px";
    ui.style.height = frame.h + "px";
    ui.style.transform = "rotate(" + frame.angle + "deg)";
    // Edge handles only where there is room for them between the corners.
    mark(ui, "data-narrow", frame.w < 40);
    mark(ui, "data-flat", frame.h < 40);
    placeAdjust();
  }

  /** Puts the handle that changes a figure's proportions on its spot, turned and flipped with the figure. */
  function placeAdjust() {
    var handle = ui.querySelector("[data-handle=adjust]");
    var kind = figureOf(selected);
    var spec = kind && FIGURES[kind];
    var tilt = kind ? tiltOf(selected) : null;
    handle.hidden = !spec || !spec.handle || !!tilt.x || !!tilt.y;
    if (handle.hidden) return;
    var size = figureSize(selected);
    var paint = figurePaint(selected);
    var at = spec.handle(size.w, size.h, adjustOf(selected));
    var fx = at[0] / size.w;
    var fy = at[1] / size.h;
    handle.style.left = roundTenth((paint.flipX ? 1 - fx : fx) * 100) + "%";
    handle.style.top = roundTenth((paint.flipY ? 1 - fy : fy) * 100) + "%";
  }

  /** Drags a figure's proportions (see FIGURES) to where the pointer is. */
  function adjustTo(event) {
    var el = drag.el;
    var spec = FIGURES[figureOf(el)];
    var at = anchorOf(el, slidePoint(event.clientX, event.clientY));
    var paint = figurePaint(el);
    var size = figureSize(el);
    var x = (paint.flipX ? 1 - at[0] : at[0]) * size.w;
    var y = (paint.flipY ? 1 - at[1] : at[1]) * size.h;
    setAdjust(el, spec.fromHandle(size.w, size.h, [x, y]));
    placeHandles();
  }

  // ---- The SVG editor's button: a selected drawing opens in the app's SVG editor.

  function isDrawing(el) {
    return !!el && el.namespaceURI === SVG_NS && el.localName === "svg";
  }

  /** Puts the "Edit SVG" button at the selected drawing's top right, outside its handles. */
  function placeSvgButton() {
    var show = isDrawing(selected) && !editing && !extras.length && tool === "select" && !(drag && drag.moved) &&
      slide.contains(selected);
    svgButton.hidden = !show;
    if (!show) return;
    var rect = selected.getBoundingClientRect();
    svgButton.style.left = Math.round(rect.right + 12) + "px";
    svgButton.style.top = Math.round(rect.top - 4) + "px";
  }

  /** Hands the drawing `el` to the app's SVG editor. */
  function openSvg(el) {
    if (!isDrawing(el)) return;
    if (nudgeTimer) commit();
    var size = sizeOf(el);
    var computed = getComputedStyle(el);
    var styles = deckStyles();
    window.parent.postMessage(
      {
        type: "slop:edit-open-svg",
        slide: slide.id,
        path: pathOf(el),
        markup: cleanCopy(el).outerHTML,
        width: size.w || el.getBoundingClientRect().width / zoom(),
        height: size.h || el.getBoundingClientRect().height / zoom(),
        color: computed.color || null,
        vars: cssVariables(el),
        css: styles.css,
        fonts: styles.fonts,
        ancestors: ancestorsOf(el),
      },
      "*",
    );
  }

  svgButton.addEventListener("pointerdown", function (event) {
    // Not a press on the slide: the selection stays, and nothing drags.
    event.stopPropagation();
    event.preventDefault();
  });
  svgButton.addEventListener("click", function (event) {
    event.stopPropagation();
    openSvg(selected);
  });

