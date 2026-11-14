  // ---- Pointer and clipboard: presses, drags and hover, the context menu, focus, pasted and dropped
  // text and images, and copying and pasting elements.

  listen(document, "pointerdown", function (event) {
    // The pasteboard takes the middle button and Space+drag before this sees them.
    if (event.button !== 0) return;
    wires.removeAttribute("data-quiet");
    if (editing && editing.contains(event.target)) return;
    finishEditing();
    saveNudges();
    // The handles are where a press reads them, and what was hovered is picked anew after it.
    flushHandles();
    hoverPick = null;
    if (tool !== "select") {
      event.preventDefault();
      // What is added takes an ink that shows on what lies under it (see readable).
      darkGround = darkAt(event.clientX, event.clientY);
      startCreating(event);
      return;
    }
    var el = pickable(event.target, event.clientX, event.clientY);
    if (reachesUnder(event) || event.shiftKey) {
      event.preventDefault();
      lastDown = { el: null, at: 0 };
      // ⌘ / Ctrl-click goes down through what lies at the pointer; Shift-click adds or takes out.
      // From an empty spot, either draws a marquee that adds to the selection.
      if (reachesUnder(event) && !event.shiftKey) {
        if (!selectUnder(event.target, event.clientX, event.clientY)) startMarquee(event, null, true);
      } else if (el) toggleSelected(el);
      else startMarquee(event, null, true);
      return;
    }
    // On a Mac, Ctrl-click is a right click, which leaves the selection it lands on alone.
    if (event.ctrlKey && isSelected(el)) return;
    var now = Date.now();
    var double = el && el === lastDown.el && now - lastDown.at < DOUBLE_CLICK_MS;
    lastDown = { el: el, at: double ? 0 : now };
    if (!isSelected(el) && (!el || isBackdrop(el))) {
      // An empty spot, on the slide or on the pasteboard around it: a drag draws the marquee and
      // a click selects nothing, or the see-through wrapper there. Where there is nothing to pick
      // but a locked element, a click selects that, with its frame and no handles, so that it
      // can be unlocked.
      startMarquee(event, lockedAt(event.target, event.clientX, event.clientY) || el, false);
      return;
    }
    if (!isSelected(el)) select(el);
    if (double && isGroup(el)) {
      // Into the group: what it holds is picked now.
      event.preventDefault();
      enteredGroup = el;
      // The browser's dblclick that follows selects, it does not start typing in what was picked.
      enteredAt = Date.now();
      var inner = pickable(event.target, event.clientX, event.clientY);
      if (inner && inner !== el) select(inner);
      else placeHandles();
      lastDown = { el: inner, at: 0 };
      return;
    }
    if (double) {
      // Otherwise the browser moves focus to what was clicked, which may be an overlay.
      event.preventDefault();
      editAt(el, event.clientX, event.clientY);
      return;
    }
    event.preventDefault();
    var start = offsetOf(el);
    drag = { mode: "move", el: el, x: event.clientX, y: event.clientY, from: start, zoom: zoom(), moved: false };
    if (el.setPointerCapture) {
      try {
        el.setPointerCapture(event.pointerId);
      } catch (e) {
        // Synthetic events have no active pointer to capture.
      }
    }
  });

  /**
   * A double-click on `el` at (x, y): an image asks the app to pick another one for it; text
   * starts typing at the pointer, and on a card or layout around several texts, typing goes into
   * the one under the pointer, if any, never into all of them as one.
   */
  function editAt(el, x, y) {
    if (isImage(el)) {
      if (!isLocked(el)) askApp("replace-image");
      return;
    }
    var text = textLeafAt(el, x, y);
    if (text) startEditing(text, x, y);
  }

  /**
   * Whether the spot (x, y) of the slide shows dark: the first color painted under it, of the
   * elements there or the slide behind them. What the editor adds in the default ink (see
   * readable) would not show there.
   */
  function darkAt(x, y) {
    var stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    var layers = stack.filter(function (el) {
      return slide.contains(el) && !el.closest("[" + ADDED + "]");
    });
    if (layers.indexOf(slide) < 0) layers.push(slide);
    for (var el = slide.parentElement; el; el = el.parentElement) layers.push(el);
    for (var i = 0; i < layers.length; i++) {
      var computed = getComputedStyle(layers[i]);
      var color = parseColor(computed.backgroundColor) || parseColor((/rgba?\([^)]*\)/.exec(computed.backgroundImage || "") || [""])[0]);
      if (color && color.a > 0.5) return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b < 110;
    }
    return false;
  }

  /**
   * The style `value` a new element gets for `key`, as it shows: on a dark ground (see darkAt),
   * the default ink (the toolbar's, DEFAULT_INK) of a text box without a fill, and of lines and
   * drawings, is white instead. A shape's text and border sit on its own fill, and a color picked
   * on purpose, black among them, stays.
   */
  function readable(key, value) {
    if (!darkGround || RADIUS[tool] || FIGURES[tool] || !DEFAULT_INK.test(String(value || ""))) return value;
    if (key === "stroke" || (key === "color" && !toolStyle.fill)) return INK_ON_DARK;
    return value;
  }

  /** A computed rgb or rgba color as its channels; null for anything else. */
  function parseColor(value) {
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(String(value || ""));
    if (!m) return null;
    var a = m[4] === undefined ? 1 : /%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a: a };
  }

  /** A CSS selector for `el` that also finds it in the saved slide. */
  function selectorOf(el) {
    var parts = [];
    for (var node = el; node !== slide; node = node.parentElement) {
      var index = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ":nth-child(" + index + ")");
    }
    return ["#" + slide.id].concat(parts).join(" > ");
  }

  /** What the app's menu and the agent are told about `el` (see `slop:edit-menu` in 00-header.js). */
  function menuElement(el) {
    return {
      path: selectorOf(el),
      markup: cleanCopy(el).outerHTML,
      name: nameOf(el),
      added: !!el.closest("[" + ADDED + "], [" + DROPPED + "]"),
    };
  }

  /**
   * The locked element at (x, y) on `target`, the outermost one that is locked: what a click
   * there would pick were it not locked. Null where nothing locked shows.
   */
  function lockedAt(target, x, y) {
    var stack = document.elementsFromPoint && x !== undefined ? document.elementsFromPoint(x, y) : [];
    if (!stack.length) {
      for (var node = target && target.nodeType === 1 ? target : target && target.parentElement; node; node = node.parentElement) {
        stack.push(node);
      }
    }
    for (var i = 0; i < stack.length; i++) {
      if (stack[i] === slide) return null;
      var el = selectable(stack[i]);
      if (!el || !paints(el) || !isLocked(el)) continue;
      var lock = el;
      for (var up = el; up && up !== slide; up = up.parentElement) {
        if (up.hasAttribute(LOCK_ATTR)) lock = up;
      }
      return lock;
    }
    return null;
  }

  // A right-click selects what is under it and the app shows its menu; with a tool in hand, the
  // tool goes back to Select first. Where nothing else is, it selects the locked element there, so
  // the menu can unlock it. While typing, the webview's own menu stays, for its spelling suggestions.
  listen(document, "contextmenu", function (event) {
    if (editing && editing.contains(event.target)) return;
    event.preventDefault();
    if (tool !== "select") {
      cancelCreating();
      clearDragMarks();
      useTool("select", true);
    }
    // On macOS, Control-click starts out as a primary press.
    endDrag();
    finishEditing();
    saveNudges();
    var el = pickable(event.target, event.clientX, event.clientY) || lockedAt(event.target, event.clientX, event.clientY);
    // A member of a multi-selection, or what is inside the selection (it may be a parent, picked
    // with ⇧Enter), leaves it selected.
    if (!isSelected(el) && (!selected || !el || !selected.contains(el))) select(el);
    var group = selected ? inDocumentOrder(allSelected()) : [];
    var parent = group.length === 1 && selected.parentElement !== slide ? selected.parentElement : null;
    tellApp({
      type: "slop:edit-menu",
      slide: slide.id,
      x: event.clientX,
      y: event.clientY,
      element: selected && menuElement(selected),
      // Every selected element, in the slide's order, for what the menu does to them all.
      elements: group.map(menuElement),
      // The one selected element holds text that can be edited.
      editable: group.length === 1 && canEditText(selected),
      // Something on the slide is locked, so the menu can unlock it all.
      locked: !!slide.querySelector("[" + LOCK_ATTR + "]"),
      // What lies at the pointer, the top-most first, for the menu to select any of, and what
      // holds the one selected element.
      under: stackAt(event.target, event.clientX, event.clientY).map(function (item) {
        return { path: pathOf(item), name: layerName(item), selected: isSelected(item) };
      }),
      parent: parent ? { path: pathOf(parent), name: layerName(parent) } : null,
    });
  });

  listen(document, "pointermove", function (event) {
    pointer = { x: event.clientX, y: event.clientY };
    if (create) {
      createTo(event);
      return;
    }
    if (marquee) {
      marqueeTo(event);
      return;
    }
    if (!drag) {
      scheduleHover(event);
      return;
    }
    if (drag.mode === "point") {
      pointTo(event);
      return;
    }
    if (drag.mode !== "move") {
      if (!drag.moved) startTransform();
      drag.moved = true;
      transformTo(event);
      followStuck(drag.followers);
      showReadout(event);
      return;
    }
    var dx = event.clientX - drag.x;
    var dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < onScreen(DRAG_THRESHOLD) && Math.abs(dy) < onScreen(DRAG_THRESHOLD)) return;
    drag.moved = true;
    lastDown = { el: null, at: 0 };
    dropHover();
    moveDrag(event, dx, dy);
  });

  /**
   * Keeps `els` as they are for `state` (a drag), to put back should the drag be called off:
   * their attributes, and with `deep`, what they hold (a line's path, a group's members, a
   * drawing's shapes), and whether each had left a slot in the layout already.
   */
  function keepForCancel(state, els, deep) {
    state.kept = state.kept || [];
    els.forEach(function (el) {
      var known = state.kept.some(function (item) {
        return item.el === el;
      });
      if (!known) state.kept.push({ el: el, attrs: attributesOf(el), html: deep ? el.innerHTML : null, slot: !!placeholderOf(el) });
    });
  }

  /** Puts everything `state` kept (see keepForCancel) back as it was. */
  function restoreKept(state) {
    (state.kept || []).forEach(function (item) {
      var el = item.el;
      attributesOf(el).forEach(function (attr) {
        el.removeAttribute(attr[0]);
      });
      item.attrs.forEach(function (attr) {
        el.setAttribute(attr[0], attr[1]);
      });
      if (item.html !== null && el.innerHTML !== item.html) el.innerHTML = item.html;
      // The slot a resize had the element leave in the layout goes with the resize.
      var slot = item.slot ? null : placeholderOf(el);
      if (slot) slot.parentNode.removeChild(slot);
    });
  }

  /**
   * Escape in the middle of a drag or a marquee calls it off: what was moved, resized or turned
   * is back as it was before the press, a copy dragged out with Alt is gone, and the selection
   * is what it was before the marquee. Nothing is saved. False when nothing was under way: a
   * press that has not moved yet is no gesture, and Escape then does what it always does.
   */
  function cancelGesture() {
    if (!(drag && drag.moved) && !(marquee && marquee.moved)) return false;
    lastDown = { el: null, at: 0 };
    if (marquee) {
      var before = marquee.before;
      marquee = null;
      marqueeBox.style.display = "none";
      selectMany(before);
    }
    if (drag) {
      var was = drag;
      drag = null;
      if (was.copies) {
        was.copies.forEach(function (copy) {
          if (copy.parentNode) copy.parentNode.removeChild(copy);
        });
        selectMany(was.originals);
      }
      restoreKept(was);
      if (was.mode === "point") previewStick(null);
      clearDragMarks();
      (was.kept || []).forEach(function (item) {
        refit(item.el);
      });
      placeHandles();
      report();
    }
    resumeSlideChecks();
    return true;
  }

  /** The pointer let go (or was taken away): whatever it was in the middle of ends. */
  function endDrag() {
    if (create) {
      finishCreating();
      clearDragMarks();
    }
    if (marquee) finishMarquee();
    if (drag) finishDrag();
    resumeSlideChecks();
  }

  function finishDrag() {
    var moved = drag.moved;
    var el = drag.el;
    // A click on one of several selected elements leaves just that one selected.
    var click = !moved && drag.mode === "move" && extras.length > 0;
    var point = drag.mode === "point";
    var end = point && moved && !drag.insert ? endAt(drag.index, drag.points.length) : null;
    if (end) {
      if (drag.stick) stick(el, end, drag.stick);
      else unstick(el, end);
      previewStick(null);
    }
    var changed = drag.members
      ? drag.members.map(function (member) {
          return member.el;
        })
      : [el];
    drag = null;
    clearDragMarks();
    // The handles to add points, away during a drag, are back.
    if (moved || point) placeHandles();
    if (moved) {
      changed.forEach(refit);
      commit();
    }
    if (click) select(el);
  }
  listen(document, "pointerup", endDrag);
  listen(document, "pointercancel", endDrag);
  listen(document.documentElement, "pointerleave", function () {
    pointer = null;
    dropHover();
  });
  listen(window, "resize", cameraMoved);
  // What overflows is looked for right away, and once more when the page's images and fonts are
  // all in, which may lay it out anew.
  scheduleOverflow();
  whenSettled(scheduleOverflow);
  listen(document, "input", function (event) {
    // Typing over everything can take the body away, or leave text beside it.
    if (editing && !event.isComposing) ensureBody(editing);
    // Fitting the text again lays it out several times over: it waits for a pause in the typing.
    if (editing) refitDue = true;
    placeHandles();
    if (editing) scheduleReport();
  });
  listen(document, "selectionchange", function () {
    if (editing && editRange()) scheduleReport();
  });
  // Clicking the app's toolbar keeps the text being edited, and its selection, for the toolbar
  // to restyle; a click elsewhere in the app ends editing ({ type: "slop:edit-finish" }).
  listen(window, "blur", function () {
    if (editing) editRange();
  });
  listen(window, "focus", function () {
    var range = editRange();
    if (range) useRange(range);
  });
  // Links on the slide do not go anywhere while editing it.
  listen(
    document,
    "click",
    function (event) {
      var link = event.target && event.target.closest ? event.target.closest("a") : null;
      if (link && slide.contains(link)) event.preventDefault();
    },
    true,
  );
  listen(document, "dblclick", function (event) {
    if (tool !== "select" || editing || Date.now() - enteredAt < DOUBLE_CLICK_MS) return;
    var el = pickable(event.target, event.clientX, event.clientY);
    // An image's double-click was the press's to take (see editAt).
    if (el && !isImage(el)) {
      var text = textLeafAt(el, event.clientX, event.clientY);
      if (text) startEditing(text, event.clientX, event.clientY);
    }
  });

  // Pasted text keeps its formatting (cleaned, see pastedFragment), or with ⌘⇧V comes as plain text.
  listen(document, "paste", function (event) {
    if (!editing) return;
    event.preventDefault();
    var data = event.clipboardData;
    var html = data && !plainPaste ? data.getData("text/html") : "";
    var text = data ? data.getData("text/plain") : "";
    plainPaste = false;
    var content = html ? pastedFragment(html) : textFragment(text);
    if (!content.childNodes.length && text) content = textFragment(text);
    var before = textState();
    insertAtCaret(content);
    textStepDone(before);
  });
  listen(document, "drop", function (event) {
    if (editing) event.preventDefault();
  });

  /**
   * Adds dropped images (`assets/…` files) on top of the slide, centered on (x, y) and fit to
   * the slide, then selects the last one and saves. Each sits at the slide's top left with an
   * inline `translate` to where it was dropped, so it moves like any hand-moved element.
   */
  function insertImages(images, x, y) {
    finishEditing();
    saveNudges();
    var view = camera();
    var maxW = (slide.offsetWidth || 1920) / 3;
    var maxH = (slide.offsetHeight || 1080) / 2;
    var last = null;
    var placed = 0;
    (Array.isArray(images) ? images : []).forEach(function (image) {
      if (!image || typeof image.src !== "string" || !/^assets\//.test(image.src)) return;
      var w = image.w > 0 ? image.w : DROP_WIDTH;
      var h = image.h > 0 ? image.h : 0;
      var fit = Math.min(1, maxW / w, h ? maxH / h : 1);
      w = Math.round(w * fit);
      h = Math.round(h * fit);
      var img = document.createElement("img");
      img.setAttribute("src", image.src);
      img.setAttribute("alt", "");
      img.setAttribute(DROPPED, "");
      img.style.position = "absolute";
      img.style.left = "0px";
      img.style.top = "0px";
      img.style.width = w + "px";
      slide.appendChild(img);
      var shift = DROP_CASCADE * placed++;
      moveTo(img, (x - view.left) / view.k - w / 2 + shift, (y - view.top) / view.k - h / 2 + shift);
      mark(img, MOVED, true);
      last = img;
    });
    if (!last) return;
    select(last);
    commit();
  }

  /**
   * Posts the selection for the app to put on the clipboard (and with `cut`, removes it). The
   * header says where it came from: the slide, its path, whether it floats freely (absolutely
   * positioned) and its box and text styles, for pasting it elsewhere.
   */
  function copySelected(cut) {
    if (!selected || !slide.contains(selected)) return;
    finishEditing();
    saveNudges();
    var group = inDocumentOrder(allSelected());
    if (!group.length) return;
    var headers = group.map(clipHeader);
    var header = headers.length > 1 ? Object.assign({}, headers[0], { group: headers }) : headers[0];
    // `>` only appears inside JSON strings, where `\u003e` stands for it, so `-->` cannot end the comment early.
    var markup = group.map(function (el) {
      return cleanCopy(el).outerHTML;
    }).join("");
    var html = CLIP_MARKER + JSON.stringify(header).replace(/>/g, "\\u003e") + "-->" + markup;
    var text = group.map(function (el) {
      return (typeof el.innerText === "string" ? el.innerText : el.textContent).trim();
    }).join("\n");
    tellApp({ type: "slop:edit-copied", slide: slide.id, html: html, text: text });
    if (cut) removeSelected();
  }

  /** What a copy of `el` needs to know of where it came from (see copySelected). */
  function clipHeader(el) {
    var computed = getComputedStyle(el);
    var center = centerOf(el);
    var size = sizeOf(el);
    var view = camera();
    var look = {};
    LOOK.forEach(function (prop) {
      if (computed[prop]) look[prop] = computed[prop];
    });
    return {
      slide: slide.id,
      path: pathOf(el),
      free: /^(absolute|fixed)$/.test(computed.position),
      box: {
        x: Math.round((center.x - view.left) / view.k - size.w / 2),
        y: Math.round((center.y - view.top) / view.k - size.h / 2),
        w: Math.round(size.w),
        h: Math.round(size.h),
      },
      look: look,
    };
  }

  /** The header and element of markup copied by copySelected; null for anything else. */
  function parseClip(html) {
    if (typeof html !== "string" || html.indexOf(CLIP_MARKER) !== 0) return null;
    var end = html.indexOf("-->");
    if (end < 0) return null;
    var header;
    try {
      header = JSON.parse(html.slice(CLIP_MARKER.length, end));
    } catch (e) {
      return null;
    }
    var template = document.createElement("template");
    template.innerHTML = html.slice(end + 3).trim();
    var el = template.content.firstElementChild;
    if (!el || !header || typeof header !== "object") return null;
    return { header: header, el: el, els: Array.prototype.slice.call(template.content.children), markup: el.outerHTML };
  }

  /**
   * Where a paste goes, in this window's pixels: the pointer when it is over the slide, or
   * else the middle of the view.
   */
  function pastePoint() {
    var rect = slide.getBoundingClientRect();
    var over = pointer && pointer.x >= rect.left && pointer.x <= rect.right && pointer.y >= rect.top && pointer.y <= rect.bottom;
    return over ? { x: pointer.x, y: pointer.y } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  }

  /** The point (x, y) in this window's pixels the app gave for a paste, or null when it gave none. */
  function givenPoint(data) {
    return data && isFinite(data.x) && isFinite(data.y) && data.x !== null && data.y !== null
      ? { x: Number(data.x), y: Number(data.y) }
      : null;
  }

  /** Whether a copied element's header says where its box was on its slide. */
  function hasPlace(header) {
    var box = header && header.box;
    return !!box && typeof box === "object" && typeof box.x === "number" && typeof box.y === "number" && isFinite(box.x) && isFinite(box.y);
  }

  /**
   * Whether the element a header was copied from still sits on this slide where it was copied:
   * a paste then lands a step away from it, so the copy shows.
   */
  function originalInPlace(header, el) {
    if (!header || header.slide !== slide.id || !hasPlace(header)) return false;
    var original = atPath(header.path);
    if (!original || original === el || original.tagName !== el.tagName) return false;
    var box = clipHeader(original).box;
    return box.x === header.box.x && box.y === header.box.y;
  }

  /**
   * Pastes an element copied by copySelected on top of the slide (see 00-header.js): where it
   * was on the slide it came from, a step down and right of the original when that still sits
   * there (and of every copy already there). With `at` (a point in this window's pixels, from
   * the context menu), centered on that point instead; so is a copy that does not say where it was.
   */
  function pasteElement(html, at) {
    var clip = parseClip(html);
    if (!clip) return;
    finishEditing();
    saveNudges();
    if (Array.isArray(clip.header.group) && clip.header.group.length === clip.els.length && clip.els.length > 1) {
      pasteGroup(clip, at);
      return;
    }
    var el = document.importNode(clip.el, true);
    // Ids stay unique; a copy takes one only when the original is gone.
    restickCopies([el], idTaken);
    var box = clip.header.box && typeof clip.header.box === "object" ? clip.header.box : {};
    var inPlace = !at && hasPlace(clip.header);
    var corner;
    if (inPlace) {
      corner = { x: box.x, y: box.y };
    } else {
      var point = at || pastePoint();
      var center = slidePoint(point.x, point.y);
      corner = { x: center.x - (box.w > 0 ? box.w : 0) / 2, y: center.y - (box.h > 0 ? box.h : 0) / 2 };
    }
    slide.appendChild(el);
    placeFree(el, clip.header, corner);
    cascade(el, inPlace && originalInPlace(clip.header, el) ? DROP_CASCADE : 0);
    select(el);
    commit();
  }

  /**
   * Moves a pasted copy `from` slide pixels down and right, and further past any element of its
   * kind already at the same spot.
   */
  function cascade(el, from) {
    var at = offsetOf(el);
    var x = at.x + (from || 0);
    var y = at.y + (from || 0);
    for (var i = 0; i < 50 && spotTaken(el, x, y, [el]); i++) {
      x += DROP_CASCADE;
      y += DROP_CASCADE;
    }
    moveTo(el, x, y);
  }

  /** Whether an element of `el`'s kind, other than those in `skip`, sits where `el` would at offset (x, y). */
  function spotTaken(el, x, y, skip) {
    return Array.prototype.some.call(el.parentElement.children, function (other) {
      if (skip.indexOf(other) >= 0 || other.tagName !== el.tagName) return false;
      var o = offsetOf(other);
      return other.style.left === el.style.left && other.style.top === el.style.top && o.x === x && o.y === y;
    });
  }

  /** Puts a copied element on the slide with its top left at `at`, sized and styled as it looked. */
  function placeFree(el, header, at) {
    var box = header.box && typeof header.box === "object" ? header.box : {};
    var num = function (n) {
      return isFinite(n) ? Math.round(n) : 0;
    };
    el.style.position = "absolute";
    el.style.margin = "0px";
    el.style.left = num(at.x) + "px";
    el.style.top = num(at.y) + "px";
    el.style.right = el.style.bottom = "auto";
    el.style.boxSizing = "border-box";
    if (box.w > 0) el.style.width = num(box.w) + "px";
    // Text may wrap differently here, so only boxes without text keep their height.
    if (box.h > 0 && !el.textContent.trim()) el.style.height = num(box.h) + "px";
    var look = header.look && typeof header.look === "object" ? header.look : {};
    LOOK.forEach(function (prop) {
      if (typeof look[prop] === "string" && !el.style[prop]) el.style[prop] = look[prop];
    });
    // Its place is all in left and top.
    moveTo(el, 0, 0);
  }

  /** Adds a text box with pasted `text` where pastes go (or centered on `at`), styled like new text boxes. */
  function pasteText(text, style, at) {
    text = String(text || "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    if (!text.trim()) return;
    finishEditing();
    saveNudges();
    var toolStyleBefore = toolStyle;
    toolStyle = style && typeof style === "object" ? style : {};
    var point = at || pastePoint();
    darkGround = darkAt(point.x, point.y);
    var el = newText(0, 0);
    toolStyle = toolStyleBefore;
    el.removeAttribute("data-slop-empty");
    var body = textRoot(el);
    body.textContent = "";
    text.split("\n").forEach(function (line, i) {
      if (i) body.appendChild(document.createElement("br"));
      body.appendChild(document.createTextNode(line));
    });
    var maxW = Math.round((slide.offsetWidth || 1920) * PASTE_TEXT_WIDTH);
    if (sizeOf(el).w > maxW) el.style.width = maxW + "px";
    var center = slidePoint(point.x, point.y);
    var size = sizeOf(el);
    place(el, Math.round(center.x - size.w / 2), Math.round(center.y - size.h / 2), null, null);
    select(el);
    commit();
  }

