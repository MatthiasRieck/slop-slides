  // ---- Lines of text and lists, Enter and Tab in them, pasted text, links and the text fit.

  /**
   * The lines of the text in `root`, in order. A line is `{ nodes, kind, depth }`: its content,
   * and for a list item the kind of its list ("ul" or "ol", otherwise null) and how many lists
   * that one is in. An item also has `item` (its <li>) and `from` (its list, at `fromDepth`), a
   * plain line ended by a line break has it in `br`, and a block that is neither (a paragraph
   * in a card) is a line of its own with the element in `block`, kept as it is.
   * Nothing is changed: `writeLines` puts lines back.
   */
  function readLines(root) {
    var lines = [];
    var run = [];
    var flush = function () {
      var parts = [[]];
      var breaks = [];
      run.forEach(function (node) {
        if (node.nodeName === "BR") {
          breaks.push(node);
          parts.push([]);
        } else {
          parts[parts.length - 1].push(node);
        }
      });
      run = [];
      // A line break at the end ends its line; it does not start another.
      if (parts.length > 1 && !parts[parts.length - 1].some(showsText)) parts.pop();
      else if (parts.length === 1 && !parts[0].some(showsText)) return;
      parts.forEach(function (nodes, i) {
        lines.push({ nodes: nodes, kind: null, depth: 0, br: breaks[i] || null });
      });
    };
    var readList = function (list, depth) {
      var kind = list.tagName.toLowerCase();
      Array.prototype.slice.call(list.childNodes).forEach(function (item) {
        if (item.nodeType !== 1) return;
        if (isList(item)) {
          readList(item, depth + 1);
          return;
        }
        var line = { nodes: [], kind: kind, depth: depth, from: list, fromDepth: depth, item: /^li$/i.test(item.tagName) ? item : null };
        var inner = [];
        Array.prototype.slice.call(item.childNodes).forEach(function (node) {
          if (isList(node)) inner.push(node);
          else if (node.nodeType !== 3 || node.data) line.nodes.push(node);
        });
        // The break that keeps an empty item open is not content.
        while (line.nodes.length && line.nodes[line.nodes.length - 1].nodeName === "BR") line.nodes.pop();
        lines.push(line);
        inner.forEach(function (list) {
          readList(list, depth + 1);
        });
      });
    };
    Array.prototype.slice.call(root.childNodes).forEach(function (node) {
      if (node.nodeType === 3 && !node.data) return;
      if (node.nodeType !== 1 || INLINE.test(node.tagName) || /^(br|img|svg)$/i.test(node.nodeName)) {
        run.push(node);
      } else if (isList(node)) {
        flush();
        readList(node, 0);
      } else {
        flush();
        lines.push({ nodes: [], kind: null, depth: 0, block: node });
      }
    });
    flush();
    return lines;
  }

  /** A caret at the start of `line`, as it stands in the text. */
  function lineStart(line) {
    var at = document.createRange();
    if (line.kind && line.item) at.setStart(line.item, 0);
    else if (line.block) at.setStartBefore(line.block);
    else if (line.nodes.length) at.setStartBefore(line.nodes[0]);
    else if (line.br) at.setStartBefore(line.br);
    else return null;
    at.collapse(true);
    return at;
  }

  /** The lines `range` is in: the one its caret is in, or all it selects text of. */
  function linesIn(lines, range) {
    var indexAt = function (node, offset) {
      var point = document.createRange();
      point.setStart(node, offset);
      point.collapse(true);
      var found = 0;
      lines.forEach(function (line, i) {
        var start = lineStart(line);
        if (start && start.compareBoundaryPoints(Range.START_TO_START, point) <= 0) found = i;
      });
      return found;
    };
    var first = indexAt(range.startContainer, range.startOffset);
    var last = indexAt(range.endContainer, range.endOffset);
    var into = last > first ? lineStart(lines[last]) : null;
    if (into) {
      // A selection that ends right at the start of a line has nothing of that line in it.
      into.setEnd(range.endContainer, range.endOffset);
      if (!into.toString()) last--;
    }
    return lines.slice(first, last + 1);
  }

  /**
   * The lines a list change is for: those `range` is in (all of them without one), leaving out
   * blank lines unless there is nothing else.
   */
  function pickLines(lines, range) {
    var targets = range ? linesIn(lines, range) : lines;
    var full = targets.filter(function (line) {
      return line.kind || line.block || line.nodes.some(showsText);
    });
    return full.length ? full : targets.slice(0, 1);
  }

  /** Makes `line` an item of a list of `kind`, or with null, a plain line. */
  function setLineKind(line, kind) {
    if (kind && line.block) {
      line.nodes = Array.prototype.slice.call(line.block.childNodes);
      line.block = null;
    }
    if (!kind || !line.kind) line.depth = 0;
    if (!kind) line.item = null;
    line.kind = kind;
  }

  /** Which way `el` aligns its text: "left", "center" or "right". */
  function alignOf(el) {
    var align = getComputedStyle(el).textAlign || "";
    return /center/.test(align) ? "center" : /right|end/.test(align) ? "right" : "left";
  }

  function styleList(list, depth) {
    list.style.margin = "0";
    list.style.paddingLeft = "1.2em";
    list.style.listStyleType = LIST_TYPES[list.tagName.toLowerCase()][depth % 3];
  }

  /**
   * Keeps a list's bullets and numbers by its text: a marker outside the item stays at the left
   * edge of the box while centered or right-aligned text moves away from it, so there it goes
   * inside, at the start of the item's first line (and a list the editor made gives up the
   * room it left for the marker).
   */
  function alignList(list, align, depth) {
    var inside = align === "center" || align === "right";
    if (inside) list.style.listStylePosition = "inside";
    else list.style.removeProperty("list-style-position");
    var room = inside && !depth ? "0px" : "1.2em";
    if (/^(0px|1\.2em)$/.test(list.style.paddingLeft) && list.style.paddingLeft !== room) list.style.paddingLeft = room;
    if (!list.getAttribute("style")) list.removeAttribute("style");
  }

  /** The list an item `line` goes in, `depth` lists deep: the one it came from where it can be, or a new one. */
  function listFor(line, depth, used, align) {
    var from = line.from;
    var list;
    if (from && from.tagName.toLowerCase() === line.kind) {
      list = used.indexOf(from) < 0 ? from : cloneShallow(from);
      while (list.firstChild) list.removeChild(list.firstChild);
      if (line.fromDepth !== depth && list.style.listStyleType) list.style.listStyleType = LIST_TYPES[line.kind][depth % 3];
    } else if (from) {
      // Another kind of list: it keeps its attributes, and a bullet style the editor set follows the kind.
      list = document.createElement(line.kind);
      Array.prototype.forEach.call(from.attributes, function (attr) {
        list.setAttribute(attr.name, attr.value);
      });
      if (used.indexOf(from) >= 0) list.removeAttribute("id");
      if (list.style.listStyleType) list.style.listStyleType = LIST_TYPES[line.kind][depth % 3];
    } else {
      list = document.createElement(line.kind);
      styleList(list, depth);
    }
    if (from) used.push(from);
    alignList(list, align, depth);
    return list;
  }

  /**
   * Writes `lines` (see readLines) as the text in `root`: plain lines with a line break between
   * them, items next to each other in one list, deeper ones in a list in the item before them.
   */
  function writeLines(root, lines, align) {
    var out = document.createDocumentFragment();
    var open = [];
    var used = [];
    lines.forEach(function (line, i) {
      line.br = null;
      if (!line.kind) {
        open = [];
        if (line.block) {
          out.appendChild(line.block);
          return;
        }
        line.nodes.forEach(function (node) {
          out.appendChild(node);
        });
        var next = lines[i + 1];
        // A break before the next plain line; a blank line needs one to be a line at all.
        if ((next && !next.kind && !next.block) || !line.nodes.some(showsText)) {
          line.br = document.createElement("br");
          out.appendChild(line.br);
        }
        return;
      }
      // An item is at most one list deeper than the one before it.
      var depth = Math.min(line.depth, open.length);
      open.length = Math.min(open.length, depth + 1);
      if (open.length > depth && open[depth].tagName.toLowerCase() !== line.kind) open.length = depth;
      if (open.length === depth) {
        var list = listFor(line, depth, used, align);
        (depth ? open[depth - 1].lastElementChild : out).appendChild(list);
        open.push(list);
      }
      var item = line.item || document.createElement("li");
      while (item.firstChild) item.removeChild(item.firstChild);
      line.nodes.forEach(function (node) {
        item.appendChild(node);
      });
      ensureLine(item);
      open[depth].appendChild(item);
      line.item = item;
      line.depth = depth;
    });
    root.textContent = "";
    root.appendChild(out);
  }

  /**
   * The kind of list ("ul" or "ol") `el`'s text is: of the lines the text selection is in while
   * it is being edited, otherwise of all its lines. Null when any of them is not in such a list.
   */
  function listKindOf(el) {
    if (isList(el)) return el.tagName.toLowerCase();
    var root = textRoot(el);
    if (!root.querySelector || !root.querySelector("ul, ol")) return null;
    var lines = readLines(root);
    if (!lines.length) return null;
    var picked = pickLines(lines, editing === el ? editRange() : null);
    var kind = picked[0].kind;
    return kind && picked.every(function (line) {
      return line.kind === kind;
    }) ? kind : null;
  }

  /** How many lists `list` is nested in, inside `root`. */
  function depthOf(list, root) {
    var depth = 0;
    for (var n = list.parentElement; n && n !== root && root.contains(n); n = n.parentElement) {
      if (/^(ul|ol)$/i.test(n.tagName)) depth++;
    }
    return depth;
  }

  /** `list` as a list of `kind`, keeping its attributes, items and an editor-set bullet style. */
  function retag(list, kind, root) {
    var next = document.createElement(kind);
    Array.prototype.forEach.call(list.attributes, function (attr) {
      next.setAttribute(attr.name, attr.value);
    });
    while (list.firstChild) next.appendChild(list.firstChild);
    list.parentNode.replaceChild(next, list);
    if (next.style.listStyleType) next.style.listStyleType = LIST_TYPES[kind][depthOf(next, root) % 3];
    return next;
  }

  function ensureLine(item) {
    if (!hasContent(item)) item.appendChild(document.createElement("br"));
  }

  /**
   * Turns lines of the selection's text into a list of `kind` ("ul" or "ol"), one item per line,
   * or when they all are items of such a list already, back into plain lines. While typing,
   * the lines the text selection is in; otherwise all of them.
   */
  function toggleList(kind) {
    var el = editing || selected;
    if (!el || !slide.contains(el) || !LIST_TYPES[kind] || !describe(el).text) return;
    var root = isList(el) ? null : ensureBody(el, true);
    var range = editing ? editRange() : null;
    var caret = range ? caretOf(range) : null;
    var at = null;
    if (!root) {
      // A list on its own stays a list: it only changes its kind.
      if (el.tagName.toLowerCase() === kind) return;
      changeText(el, function () {
        var next = retag(el, kind, el);
        if (editing === el) editing = next;
        selected = next;
        mark(next, "data-slop-selected", true);
      });
    } else {
      // Moving line breaks out of formatted text moves the text the selection is in.
      hoistBreaks(root);
      if (caret) range = rangeFromCaret(caret, el);
      changeText(el, function () {
        var lines = readLines(root);
        if (!lines.length) lines.push({ nodes: [], kind: null, depth: 0 });
        var picked = pickLines(lines, range);
        var off = picked.every(function (line) {
          return line.kind === kind;
        });
        picked.forEach(function (line) {
          setLineKind(line, off ? null : kind);
        });
        writeLines(root, lines, alignOf(el));
        at = picked[0];
      });
    }
    if (editing) {
      // The caret stays in its text; one that stood between elements goes to the start of its line.
      var inText = caret && caret.sc.nodeType === 3 && caret.ec.nodeType === 3;
      var back = (inText || !at ? caret && rangeFromCaret(caret, editing) : null) || (at && lineStart(at));
      if (!back) {
        back = document.createRange();
        back.selectNodeContents(textRoot(editing));
        back.collapse(false);
      }
      useRange(back);
    }
    placeHandles();
    report();
    if (!editing) commit();
  }

  /**
   * Takes `item` out of its list while typing: a nested item moves out a level, any other
   * becomes a plain line, with the caret at its start.
   */
  function unlistItem(item) {
    var outer = item.parentElement.parentElement;
    if (outer && /^li$/i.test(outer.tagName) && editing.contains(outer)) {
      changeText(editing, function () {
        outdent(item);
      });
      return;
    }
    var root = textRoot(editing);
    changeText(editing, function () {
      var lines = readLines(root);
      var line = lines.filter(function (other) {
        return other.item === item;
      })[0];
      if (!line) return;
      setLineKind(line, null);
      writeLines(root, lines, alignOf(editing));
      var at = lineStart(line);
      if (at) useRange(at);
    });
    report();
  }

  /** The item the caret stands at the very start of, when that item can leave its list. */
  function itemAtCaretStart() {
    var range = editRange();
    var item = range && range.collapsed ? caretItem() : null;
    if (!item) return null;
    var before = document.createRange();
    before.setStart(item, 0);
    before.setEnd(range.startContainer, range.startOffset);
    if (before.toString() || before.cloneContents().querySelector("img, svg, br, li")) return null;
    var nested = /^li$/i.test((item.parentElement.parentElement || {}).tagName || "");
    return nested || !isList(textRoot(editing)) ? item : null;
  }

  /** The list item the caret is in, inside the element being edited. */
  function caretItem() {
    var range = editRange();
    if (!range) return null;
    var node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentNode;
    var item = node && node.closest ? node.closest("li") : null;
    return item && item !== editing && editing.contains(item) ? item : null;
  }

  /** Enter in a list: the rest of the item goes into a new one after it. */
  function newItem(item) {
    var range = editRange();
    if (!item.textContent.trim() && !item.querySelector("img, svg")) {
      var outer = item.parentElement.parentElement;
      if (outer && /^li$/i.test(outer.tagName) && editing.contains(outer)) {
        outdent(item);
      } else if (isList(textRoot(editing))) {
        // A list on its own cannot hold a plain line: its empty last item ends the editing.
        var list = item.parentElement;
        if (list.children.length > 1) list.removeChild(item);
        finishEditing();
      } else {
        // An empty item ends the list there: it becomes a plain line to go on typing in.
        unlistItem(item);
      }
      return;
    }
    changeText(editing, function () {
      if (!range.collapsed) range.deleteContents();
      var rest = document.createRange();
      rest.setStart(range.startContainer, range.startOffset);
      rest.setEnd(item, item.childNodes.length);
      var next = cloneShallow(item);
      next.appendChild(rest.extractContents());
      item.parentNode.insertBefore(next, item.nextSibling);
      ensureLine(item);
      ensureLine(next);
      var caret = document.createRange();
      caret.setStart(next, 0);
      caret.collapse(true);
      useRange(caret);
    });
  }

  /** Tab in a list: the item goes into a list inside the item before it. */
  function indent(item) {
    var before = item.previousElementSibling;
    if (!before || !/^li$/i.test(before.tagName)) return;
    var range = editRange();
    var caret = range ? caretOf(range) : null;
    var list = item.parentElement;
    var inner = before.lastElementChild && before.lastElementChild.tagName === list.tagName ? before.lastElementChild : null;
    if (!inner) {
      inner = cloneShallow(list);
      before.appendChild(inner);
      if (inner.style.listStyleType) inner.style.listStyleType = LIST_TYPES[inner.tagName.toLowerCase()][depthOf(inner, editing) % 3];
      alignList(inner, alignOf(editing), depthOf(inner, editing));
    }
    inner.appendChild(item);
    var back = caret && rangeFromCaret(caret, editing);
    if (back) useRange(back);
    placeHandles();
  }

  /** Shift+Tab in a nested list: the item moves out after the item it is in, taking the items after it along. */
  function outdent(item) {
    var list = item.parentElement;
    var outer = list.parentElement;
    if (!outer || !/^li$/i.test(outer.tagName) || !editing.contains(outer)) return;
    var range = editRange();
    var caret = range ? caretOf(range) : null;
    if (item.nextElementSibling) {
      var rest = cloneShallow(list);
      while (item.nextSibling) rest.appendChild(item.nextSibling);
      item.appendChild(rest);
    }
    outer.parentNode.insertBefore(item, outer.nextSibling);
    if (!list.children.length) list.parentNode.removeChild(list);
    var back = caret && rangeFromCaret(caret, editing);
    if (!back) {
      back = document.createRange();
      back.setStart(item, 0);
      back.collapse(true);
    }
    useRange(back);
    placeHandles();
  }

  /** Enter, or Shift+Enter in a list: a line break at the caret. */
  function insertLineBreak() {
    if (document.execCommand && document.execCommand("insertLineBreak")) return;
    insertAtCaret(document.createElement("br"));
  }

  /** Puts `content` (a node or fragment) in place of the selected text and the caret after it. */
  function insertAtCaret(content) {
    if (editing) ensureBody(editing, true);
    var range = editRange();
    if (!range) return;
    changeText(editing, function () {
      range.deleteContents();
      var last = content.nodeType === 11 ? content.lastChild : content;
      if (!last) return;
      range.insertNode(content);
      var after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      useRange(after);
    });
  }

  /** Plain text as text with line breaks. */
  function textFragment(text) {
    var fragment = document.createDocumentFragment();
    String(text || "").replace(/\r\n?/g, "\n").split("\n").forEach(function (line, i) {
      if (i) fragment.appendChild(document.createElement("br"));
      if (line) fragment.appendChild(document.createTextNode(line));
    });
    return fragment;
  }

  /**
   * Pasted HTML as text with its formatting: bold, italic, underline, strikethrough,
   * superscript / subscript, color, links and line breaks. Fonts, sizes, classes and
   * everything else are dropped, so it takes on the look of the text it goes into.
   */
  function pastedFragment(html) {
    var template = document.createElement("template");
    template.innerHTML = html;
    var out = document.createDocumentFragment();
    var add = function (into, node) {
      into.appendChild(node);
    };
    var walk = function (from, into) {
      Array.prototype.forEach.call(from.childNodes, function (node) {
        if (node.nodeType === 3) {
          var text = node.data.replace(/[\t\n\r ]+/g, " ");
          if (text.trim() || (into.lastChild && into.lastChild.nodeName !== "BR")) add(into, document.createTextNode(text));
          return;
        }
        if (node.nodeType !== 1 || PASTE_SKIP.test(node.tagName)) return;
        var tag = node.tagName.toLowerCase();
        if (tag === "br") {
          add(into, document.createElement("br"));
          return;
        }
        if (!INLINE.test(tag)) {
          // Blocks become lines; the extra breaks this leaves are tidied below.
          into.appendChild(document.createElement("br"));
          walk(node, into);
          into.appendChild(document.createElement("br"));
          return;
        }
        var style = node.style;
        var weight = style.fontWeight === "bold" ? 700 : parseInt(style.fontWeight, 10);
        var lines = (style.textDecorationLine || "") + " " + (style.textDecoration || "");
        var bold = /^(b|strong)$/.test(tag) ? !(weight < 600 || style.fontWeight === "normal") : weight >= 600;
        var span = document.createElement("span");
        if (bold) span.style.fontWeight = "700";
        if (/^(i|em)$/.test(tag) || style.fontStyle === "italic") span.style.fontStyle = "italic";
        var decoration = [];
        if (tag === "u" || /underline/.test(lines)) decoration.push("underline");
        if (/^(s|strike|del)$/.test(tag) || /line-through/.test(lines)) decoration.push("line-through");
        if (decoration.length) span.style.setProperty("text-decoration-line", decoration.join(" "));
        var color = toHex(style.color || node.getAttribute("color"));
        if (color) span.style.color = color;
        var inner = document.createDocumentFragment();
        walk(node, inner);
        if (!hasContent(inner) && !inner.textContent) return;
        var result = inner;
        if (span.getAttribute("style")) {
          span.appendChild(result);
          result = span;
        }
        if (tag === "sup" || tag === "sub") {
          var script = document.createElement(tag);
          script.appendChild(result);
          result = script;
        }
        var href = tag === "a" ? safeHref(node.getAttribute("href")) : null;
        if (href) result = wrapIn(linkTo(document.createElement("a"), href), result);
        add(into, result);
      });
    };
    walk(template.content, out);
    // One break between lines: none before the first or after the last, none doubled.
    var walker = document.createTreeWalker(out, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var breaks = [];
    var text = false;
    var lastBreak = null;
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeName === "BR") {
        if (!text || lastBreak) breaks.push(node);
        else lastBreak = node;
      } else if (node.nodeType === 3 && node.data.trim()) {
        text = true;
        lastBreak = null;
      }
    }
    if (lastBreak) breaks.push(lastBreak);
    breaks.forEach(function (br) {
      br.parentNode.removeChild(br);
    });
    while (out.lastChild && out.lastChild.nodeType === 3 && !out.lastChild.data.trim()) out.removeChild(out.lastChild);
    return out;
  }

  function wrapIn(wrapper, content) {
    wrapper.appendChild(content);
    return wrapper;
  }

  /** A link's href as given, if it is one a slide may hold: a web or mail address, or another slide. */
  function safeHref(href) {
    href = String(href || "").trim();
    return /^(https?:|mailto:|#)/i.test(href) && href !== "#" ? href : null;
  }

  /** Points `a` at `href`; web links open in a new window, so the presentation stays open. */
  function linkTo(a, href) {
    a.setAttribute("href", href);
    if (/^https?:/i.test(href)) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    } else {
      a.removeAttribute("target");
      a.removeAttribute("rel");
    }
    return a;
  }

  /**
   * Links the selection to `href`, or with null, removes its link. While typing, the selected
   * text (or the link at the caret, or else all of the text); otherwise the element: its text,
   * or an element without text (an image, a shape) in an <a> that leaves its layout alone.
   */
  function setLink(given) {
    var href = given === null ? null : safeHref(given);
    var el = editing || selected;
    if (!el || !slide.contains(el) || (given !== null && !href)) return;
    if (editing) {
      ensureBody(el, true);
      var range = editRange();
      var node = textNodeOf(el);
      var at = node.closest("a");
      changeText(el, function () {
        if (range && !range.collapsed) {
          formatRange(range, { link: href });
        } else if (at && el.contains(at)) {
          if (href) linkTo(at, href);
          else unwrap(at);
        } else if (href) {
          var all = document.createRange();
          all.selectNodeContents(textRoot(el));
          formatRange(all, { link: href });
          var caret = rangeAt(el, { start: el.textContent.length, end: el.textContent.length });
          useRange(caret);
        }
      });
      report();
      return;
    }
    var link = linkOf(el, el);
    if (link && href) {
      linkTo(link, href);
    } else if (link) {
      if (link === el) select(link.firstElementChild || null);
      unwrap(link);
    } else if (href && describe(el).text && el.textContent.trim()) {
      var a = linkTo(document.createElement("a"), href);
      var into = ensureBody(el, true);
      while (into.firstChild) a.appendChild(into.firstChild);
      into.appendChild(a);
    } else if (href) {
      var around = linkTo(document.createElement("a"), href);
      around.style.display = "contents";
      wrap(el, around);
    } else {
      return;
    }
    placeHandles();
    report();
    commit();
  }

  /**
   * How the box handles text that does not fit: "shrink" its text (data-autofit, see
   * runtime.js), "grow" (its height becomes a min-height, so it grows with its text), or null.
   */
  function setAutofit(el, mode) {
    mode = mode === "shrink" || mode === "grow" ? mode : null;
    var was = el.getAttribute("data-autofit");
    if (was === mode) return;
    if (autofit) autofit.unfit(el);
    if (was === "grow") {
      // Back to a fixed box, as tall as it grew.
      var grown = getComputedStyle(el).height;
      el.style.removeProperty("min-height");
      if (/px$/.test(grown)) el.style.height = grown;
    }
    if (mode) el.setAttribute("data-autofit", mode);
    else el.removeAttribute("data-autofit");
    if (mode === "grow") {
      var height = getComputedStyle(el).height;
      if (/px$/.test(height)) el.style.minHeight = height;
      el.style.height = "auto";
      el.style.removeProperty("max-height");
    }
    refit(el);
  }

