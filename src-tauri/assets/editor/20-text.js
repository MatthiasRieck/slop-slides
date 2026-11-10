  // ---- Editing text: typing in an element, the caret and the text selection, formatting the
  // selected text, and the body a box's text sits in.

  function startEditing(el, x, y) {
    if (!el || editing || /^(img|svg|video|canvas|iframe|hr|br)$/i.test(el.tagName) || isGroup(el) || isLocked(el)) return;
    if (!el.textContent.trim() && !/^(text|shape)$/.test(el.getAttribute(ADDED) || "")) return;
    select(el);
    editing = el;
    textRange = null;
    el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "true");
    el.setAttribute("data-slop-editing", "");
    slide.setAttribute("data-slop-typing", "");
    var root = ensureBody(el);
    // An empty body has no line for the caret to stand on.
    if (root !== el) ensureLine(root);
    el.focus();
    placeHandles();
    var range = x !== undefined && document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (!range || !root.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(root);
    }
    var selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    textRange = range.cloneRange();
    report();
  }

  function finishEditing() {
    if (!editing) return;
    var el = editing;
    el.removeAttribute("contenteditable");
    el.removeAttribute("spellcheck");
    el.removeAttribute("data-slop-editing");
    slide.removeAttribute("data-slop-typing");
    editing = null;
    textRange = null;
    var selection = window.getSelection();
    if (selection) selection.removeAllRanges();
    // A text box left empty goes away.
    if (el.getAttribute(ADDED) === "text" && !el.textContent.trim()) {
      if (selected === el) select(null);
      el.parentElement.removeChild(el);
    } else {
      // Whatever was typed around the body belongs in it.
      var root = ensureBody(el);
      dropTrailingBreaks(root);
      // A shape without text holds nothing.
      if (root !== el && !hasContent(root)) el.removeChild(root);
      refit(el);
    }
    placeHandles();
    if (selected === el) report();
    commit();
  }

  /** Enter at the end of the text leaves line breaks for the caret that would stay as blank lines. */
  function dropTrailingBreaks(el) {
    while (el.lastChild && (el.lastChild.nodeName === "BR" || (el.lastChild.nodeType === 3 && !el.lastChild.data))) {
      el.removeChild(el.lastChild);
    }
  }

  /** The text selection (or caret) in the element being edited, or the last one it had. */
  function editRange() {
    if (!editing) return null;
    var selection = window.getSelection();
    if (selection && selection.rangeCount) {
      var live = selection.getRangeAt(0);
      if (editing.contains(live.startContainer) && editing.contains(live.endContainer)) textRange = live.cloneRange();
    }
    if (textRange && editing.contains(textRange.startContainer) && editing.contains(textRange.endContainer)) return textRange;
    return null;
  }

  /** Makes `range` the text selection again, with focus in the text. */
  function useRange(range) {
    if (!editing) return;
    if (document.activeElement !== editing && editing.focus) editing.focus();
    var selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    textRange = range.cloneRange();
  }

  /** Where `range` starts and ends in `root`'s text, in characters. */
  function textOffsets(root, range) {
    var before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(range.startContainer, range.startOffset);
    var start = before.toString().length;
    return { start: start, end: start + range.toString().length };
  }

  /** The range spanning characters `start` to `end` of `root`'s text. */
  function rangeAt(root, at) {
    var range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(true);
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var seen = 0;
    var started = false;
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      var end = seen + node.data.length;
      // A selection starts in the text after a boundary, and ends in the text before it.
      if (!started && (at.start < end || (at.start === end && at.start === at.end))) {
        range.setStart(node, at.start - seen);
        started = true;
      }
      if (started && at.end <= end) {
        range.setEnd(node, at.end - seen);
        return range;
      }
      seen = end;
    }
    var whole = document.createRange();
    whole.selectNodeContents(root);
    if (started) range.setEnd(whole.endContainer, whole.endOffset);
    else range = whole;
    if (!started) range.collapse(false);
    return range;
  }

  /** The caret's place by node, which survives moving nodes (unlike a live range). */
  function caretOf(range) {
    return { sc: range.startContainer, so: range.startOffset, ec: range.endContainer, eo: range.endOffset };
  }

  function rangeFromCaret(caret, root) {
    if (!root.contains(caret.sc) || !root.contains(caret.ec)) return null;
    var range = document.createRange();
    try {
      range.setStart(caret.sc, Math.min(caret.so, lengthOf(caret.sc)));
      range.setEnd(caret.ec, Math.min(caret.eo, lengthOf(caret.ec)));
    } catch (e) {
      return null;
    }
    return range;
  }

  function lengthOf(node) {
    return node.nodeType === 1 ? node.childNodes.length : node.data.length;
  }

  function isInline(node) {
    return node.nodeType !== 1 || INLINE.test(node.tagName);
  }

  /** Whether `node` holds anything that shows: text, a line break, or media. */
  function hasContent(node) {
    return !!(node.textContent.trim() || (node.querySelector && node.querySelector("br, img, svg")) || /^(br|img|svg)$/i.test(node.nodeName));
  }

  /** Replaces `node` with its children. */
  function unwrap(node) {
    var parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }

  /** Puts `node` inside `wrapper`, where `node` was. */
  function wrap(node, wrapper) {
    node.parentNode.insertBefore(wrapper, node);
    wrapper.appendChild(node);
    return wrapper;
  }

  function cloneShallow(el) {
    var copy = el.cloneNode(false);
    copy.removeAttribute("id");
    return copy;
  }

  /**
   * Splits the inline elements around text node `t` (up to its block) so each holds only `t`,
   * and returns them, innermost first: restyling them restyles exactly `t`.
   */
  function isolate(t, root) {
    var chain = [];
    var node = t;
    while (node.parentNode && node.parentNode !== root && isInline(node.parentNode)) {
      var parent = node.parentNode;
      if (node.previousSibling) {
        var head = cloneShallow(parent);
        while (parent.firstChild !== node) head.appendChild(parent.firstChild);
        parent.parentNode.insertBefore(head, parent);
      }
      if (node.nextSibling) {
        var tail = cloneShallow(parent);
        while (node.nextSibling) tail.appendChild(node.nextSibling);
        parent.parentNode.insertBefore(tail, parent.nextSibling);
      }
      chain.push(parent);
      node = parent;
    }
    return chain;
  }

  function removeLine(el, line) {
    ["text-decoration-line", "text-decoration"].forEach(function (prop) {
      var value = el.style.getPropertyValue(prop);
      if (!value || value.indexOf(line) < 0) return;
      var rest = value.split(/\s+/).filter(function (part) {
        return part && part !== line;
      });
      if (rest.length && !/^(none|solid|double|dotted|dashed|wavy)$/.test(rest.join(" "))) el.style.setProperty(prop, rest.join(" "));
      else el.style.removeProperty(prop);
    });
  }

  /**
   * Takes the formatting `changes` replace off `el`: inline styles, and tags that only mean
   * that formatting (`keep` leaves the element itself in place).
   */
  function stripFormatting(el, changes, keep) {
    var has = function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    };
    var tag = el.tagName.toLowerCase();
    var props = { color: "color", fontSize: "font-size", fontFamily: "font-family", bold: "font-weight", italic: "font-style", letterSpacing: "letter-spacing" };
    Object.keys(props).forEach(function (key) {
      if (has(key)) el.style.removeProperty(props[key]);
    });
    if (has("underline")) removeLine(el, "underline");
    if (has("strike")) removeLine(el, "line-through");
    if (has("script")) el.style.removeProperty("vertical-align");
    if (tag === "font") {
      if (has("color")) el.removeAttribute("color");
      if (has("fontSize")) el.removeAttribute("size");
      if (has("fontFamily")) el.removeAttribute("face");
    }
    if (!el.getAttribute("style")) el.removeAttribute("style");
    var means =
      (has("bold") && /^(b|strong)$/.test(tag)) ||
      (has("italic") && /^(i|em)$/.test(tag)) ||
      (has("underline") && tag === "u") ||
      (has("strike") && /^(s|strike|del)$/.test(tag)) ||
      (has("script") && /^(sup|sub)$/.test(tag)) ||
      (has("link") && tag === "a") ||
      (/^(span|font)$/.test(tag) && !el.attributes.length);
    if (means && !keep) unwrap(el);
  }

  /**
   * Gives text node `t` the formatting `changes`, where its surroundings do not already: on
   * the <span> that holds only it, or a new one around it.
   */
  function applyFormatting(t, changes, root) {
    var has = function (key) {
      return Object.prototype.hasOwnProperty.call(changes, key);
    };
    var own = t.parentNode !== root && /^span$/i.test(t.parentNode.tagName) && t.parentNode.childNodes.length === 1;
    if (own) {
      // What its own span already sets for these gives way, so the comparison is with its surroundings.
      stripFormatting(t.parentNode, changes, true);
    }
    var around = getComputedStyle(own ? t.parentNode.parentNode : t.parentNode);
    var span = own ? t.parentNode : document.createElement("span");
    if (has("bold") && changes.bold !== weightOf(around) >= 600) span.style.fontWeight = changes.bold ? "700" : "400";
    if (has("italic") && changes.italic !== (around.fontStyle === "italic")) span.style.fontStyle = changes.italic ? "italic" : "normal";
    if (has("color") && changes.color && toHex(around.color) !== changes.color) span.style.color = changes.color;
    if (has("fontSize") && changes.fontSize > 0 && Math.round(parseFloat(around.fontSize)) !== Math.round(changes.fontSize)) {
      span.style.fontSize = Math.round(changes.fontSize) + "px";
    }
    if (has("fontFamily") && changes.fontFamily && firstFamily(around.fontFamily) !== firstFamily(changes.fontFamily)) {
      span.style.fontFamily = changes.fontFamily;
    }
    if (has("letterSpacing") && isFinite(changes.letterSpacing)) {
      var now = parseFloat(around.letterSpacing) || 0;
      if (now !== changes.letterSpacing) span.style.letterSpacing = changes.letterSpacing ? changes.letterSpacing + "px" : "normal";
    }
    var lines = [];
    if (changes.underline && !decorated(t.parentNode, "underline")) lines.push("underline");
    if (changes.strike && !decorated(t.parentNode, "line-through")) lines.push("line-through");
    if (lines.length) {
      var kept = span.style.getPropertyValue("text-decoration-line");
      span.style.setProperty("text-decoration-line", (kept && kept !== "none" ? kept + " " : "") + lines.join(" "));
    }
    var node = own ? span : t;
    if (!own && span.getAttribute("style")) node = wrap(node, span);
    if (changes.script === "sup" || changes.script === "sub") node = wrap(node, document.createElement(changes.script));
    if (changes.link) node = wrap(node, linkTo(document.createElement("a"), changes.link));
  }

  /** The text nodes `range` covers, split at its ends so it covers each one whole. */
  function coveredText(range, root) {
    if (range.startContainer.nodeType === 3 && range.startOffset > 0 && range.startOffset < range.startContainer.data.length) {
      var rest = range.startContainer.splitText(range.startOffset);
      if (range.endContainer === range.startContainer) range.setEnd(rest, range.endOffset - range.startOffset);
      range.setStart(rest, 0);
    }
    if (range.endContainer.nodeType === 3 && range.endOffset > 0 && range.endOffset < range.endContainer.data.length) {
      range.endContainer.splitText(range.endOffset);
    }
    var nodes = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data.length && range.comparePoint(node, 0) >= 0 && range.comparePoint(node, node.data.length) <= 0) nodes.push(node);
    }
    return nodes;
  }

  /** Merges neighboring inline elements that look the same, and drops empty, attribute-less ones. */
  function tidy(root) {
    Array.prototype.slice.call(root.querySelectorAll("*")).reverse().forEach(function (el) {
      if (!INLINE.test(el.tagName) || el.attributes.length) return;
      if (!hasContent(el)) el.parentNode.removeChild(el);
      else if (/^(span|font)$/i.test(el.tagName)) unwrap(el);
    });
    withDescendants(root).forEach(function (el) {
      for (var child = el.firstChild; child; child = child.nextSibling) {
        var next = child.nextSibling;
        while (next && sameInline(child, next)) {
          while (next.firstChild) child.appendChild(next.firstChild);
          el.removeChild(next);
          next = child.nextSibling;
        }
      }
    });
    root.normalize();
  }

  function sameInline(a, b) {
    if (a.nodeType !== 1 || b.nodeType !== 1 || a.tagName !== b.tagName || !INLINE.test(a.tagName)) return false;
    if (a.attributes.length !== b.attributes.length) return false;
    return Array.prototype.every.call(a.attributes, function (attr) {
      return b.getAttribute(attr.name) === attr.value;
    });
  }

  /** Gives the text `range` covers in the element being edited the formatting `changes`. */
  function formatRange(range, changes) {
    var root = editing;
    var at = textOffsets(root, range);
    coveredText(range, root).forEach(function (t) {
      isolate(t, root).forEach(function (el) {
        if (el !== t.parentNode || !/^span$/i.test(el.tagName)) stripFormatting(el, changes);
      });
      applyFormatting(t, changes, root);
    });
    tidy(root);
    useRange(rangeAt(root, at));
  }

  /** Changes to the text while typing, without losing the text selection or the text fit. */
  function changeText(el, change) {
    if (autofit) autofit.unfit(el);
    change();
    refit(el);
    placeHandles();
  }

  /** Shrinks the text of a `data-autofit="shrink"` box again until it fits. */
  function refit(el) {
    if (autofit && el && el.getAttribute && el.getAttribute("data-autofit") === "shrink") autofit.fit(el);
  }

  /**
   * Restyles the text being edited: the text styles go to the selected text (or with a caret,
   * the whole element), the rest to the element.
   */
  function styleText(changes) {
    var el = editing;
    var range = editRange();
    var formats = range && !range.collapsed && Object.keys(changes).some(function (key) {
      return TEXT_KEYS.indexOf(key) >= 0;
    });
    if (formats) {
      // The <span>s of the formatting stay in the text's lines only inside a body.
      ensureBody(el, true);
      range = editRange();
    }
    var text = {};
    var rest = {};
    Object.keys(changes).forEach(function (key) {
      (TEXT_KEYS.indexOf(key) >= 0 && range && !range.collapsed ? text : rest)[key] = changes[key];
    });
    if (Object.keys(text).length) {
      changeText(el, function () {
        formatRange(range, text);
      });
    }
    if (Object.keys(rest).length) {
      applyStyle(rest);
      var again = editRange();
      if (again) useRange(again);
    }
    report();
  }

  /** ⌘B / ⌘I / ⌘U: turns bold, italic or underline on or off, as the selected text has it now. */
  function toggleStyle(key) {
    var now = describe(selected);
    if (!now || !now.text) return;
    var changes = {};
    changes[key] = !now[key];
    if (editing) styleText(changes);
    else applyToSelection(changes);
  }

  function isTextBox(el) {
    return /^(text|shape)$/.test(el.getAttribute(ADDED) || "");
  }

  function isList(node) {
    return node.nodeType === 1 && /^(ul|ol)$/i.test(node.tagName);
  }

  /** The block holding `el`'s text, when it has one (see 00-header.js). */
  function bodyOf(el) {
    return Array.prototype.find.call(el.children, function (child) {
      return child.hasAttribute(BODY_ATTR);
    }) || null;
  }

  /** Where `el`'s text is: its body, or `el` itself. */
  function textRoot(el) {
    return bodyOf(el) || el;
  }

  /**
   * Whether formatted text needs a body in `el`: a flex or grid box lays out each inline element
   * directly in it as an item of its own, so a bold word would leave its line. A box that holds
   * elements of its own next to its text is left as it is.
   */
  function needsBody(el) {
    if (!/flex|grid/.test(getComputedStyle(el).display || "")) return false;
    var text = Array.prototype.some.call(el.childNodes, function (node) {
      return node.nodeType === 3 && node.data.trim();
    });
    return text && Array.prototype.every.call(el.children, function (child) {
      return INLINE.test(child.tagName) || /^(br|ul|ol)$/i.test(child.tagName);
    });
  }

  /**
   * Puts all of `el`'s text in its body and returns it: for a text box or shape, an element that
   * has a body already, or with `formatting`, any box that needs one. Otherwise returns `el`.
   * The text selection stays where it was.
   */
  function ensureBody(el, formatting) {
    var body = bodyOf(el);
    if (!body && !isTextBox(el) && !(formatting && needsBody(el))) return el;
    var loose = Array.prototype.filter.call(el.childNodes, function (node) {
      return node !== body && (node.nodeType === 1 || (node.nodeType === 3 && (!body || node.data.trim())));
    });
    if (body && !loose.length) return body;
    var range = editing === el ? editRange() : null;
    var caret = range ? caretOf(range) : null;
    if (!body) {
      body = document.createElement("div");
      body.setAttribute(BODY_ATTR, "");
      while (el.firstChild) body.appendChild(el.firstChild);
      el.appendChild(body);
      if (caret && caret.sc === el) caret.sc = body;
      if (caret && caret.ec === el) caret.ec = body;
    } else {
      // What ended up around the body goes into it, on the side it was on.
      var first = body.firstChild;
      var before = true;
      Array.prototype.slice.call(el.childNodes).forEach(function (node) {
        if (node === body) before = false;
        if (loose.indexOf(node) < 0) return;
        var content = [node];
        if (node.nodeType === 1 && node.hasAttribute(BODY_ATTR)) {
          // A second body is more lines of the same text.
          content = [document.createElement("br")].concat(Array.prototype.slice.call(node.childNodes));
          el.removeChild(node);
        }
        content.forEach(function (part) {
          if (before) body.insertBefore(part, first);
          else body.appendChild(part);
        });
      });
      if (caret && (caret.sc === el || caret.ec === el)) caret = null;
    }
    if (range) {
      var back = caret && rangeFromCaret(caret, el);
      if (!back) {
        back = document.createRange();
        back.selectNodeContents(body);
        back.collapse(false);
      }
      useRange(back);
    }
    return body;
  }

  /** Whether `node` shows text or media: more than a line break or blank space. */
  function showsText(node) {
    if (node.nodeType === 3) return !!node.data.trim();
    if (node.nodeType !== 1) return false;
    return !!node.textContent.trim() || /^(img|svg)$/i.test(node.nodeName) || !!node.querySelector("img, svg");
  }

  /** Moves line breaks out of the inline elements around them, splitting those, so lines split between elements. */
  function hoistBreaks(root) {
    Array.prototype.slice.call(root.querySelectorAll("br")).forEach(function (br) {
      while (br.parentNode !== root && br.parentNode.nodeType === 1 && INLINE.test(br.parentNode.tagName)) {
        var parent = br.parentNode;
        if (br.nextSibling) {
          var tail = cloneShallow(parent);
          while (br.nextSibling) tail.appendChild(br.nextSibling);
          parent.parentNode.insertBefore(tail, parent.nextSibling);
        }
        parent.parentNode.insertBefore(br, parent.nextSibling);
        if (!parent.firstChild) parent.parentNode.removeChild(parent);
      }
    });
  }

