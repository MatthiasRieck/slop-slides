  // ---- Pointer and clipboard: presses, drags and hover, the context menu, focus, pasted and dropped
  // text and images, and copying and pasting elements.

  document.addEventListener("pointerdown", function (event) {
    // The pasteboard takes the middle button and Space+drag before this sees them.
    if (event.button !== 0) return;
    wires.removeAttribute("data-quiet");
    if (editing && editing.contains(event.target)) return;
    finishEditing();
    if (nudgeTimer) commit();
    if (tool !== "select") {
      event.preventDefault();
      startCreating(event);
      return;
    }
    var el = pickable(event.target, event.clientX, event.clientY);
    if (addsToSelection(event)) {
      event.preventDefault();
      lastDown = { el: null, at: 0 };
      if (el) toggleSelected(el);
      else startMarquee(event, null, true);
      return;
    }
    // On a Mac, Ctrl-click is a right click, which leaves the selection it lands on alone.
    if (event.ctrlKey && isSelected(el)) return;
    var now = Date.now();
    var double = el && el === lastDown.el && now - lastDown.at < DOUBLE_CLICK_MS;
    lastDown = { el: el, at: double ? 0 : now };
    if (!isSelected(el) && (!el || isBackdrop(el)) && startMarquee(event, el, false)) return;
    if (!isSelected(el)) select(el);
    if (!el) {
      pasteboard.startPan(event);
      return;
    }
    if (double && isGroup(el)) {
      // Into the group: what it holds is picked now.
      event.preventDefault();
      enteredGroup = el;
      var inner = pickable(event.target, event.clientX, event.clientY);
      if (inner && inner !== el) select(inner);
      lastDown = { el: inner, at: 0 };
      return;
    }
    if (double) {
      // Otherwise the browser moves focus to what was clicked, which may be an overlay.
      event.preventDefault();
      startEditing(el, event.clientX, event.clientY);
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

  /** A CSS selector for `el` that also finds it in the saved slide. */
  function selectorOf(el) {
    var parts = [];
    for (var node = el; node !== slide; node = node.parentElement) {
      var index = Array.prototype.indexOf.call(node.parentElement.children, node) + 1;
      parts.unshift(node.tagName.toLowerCase() + ":nth-child(" + index + ")");
    }
    return ["#" + slide.id].concat(parts).join(" > ");
  }

  // A right-click selects what is under it and the app shows its menu. While typing, the
  // webview's own menu stays, for its spelling suggestions.
  document.addEventListener("contextmenu", function (event) {
    if (editing && editing.contains(event.target)) return;
    event.preventDefault();
    if (tool !== "select") return;
    // On macOS, Control-click starts out as a primary press.
    endDrag();
    finishEditing();
    if (nudgeTimer) commit();
    var el = pickable(event.target, event.clientX, event.clientY);
    // A member of a multi-selection, or what is inside the selection (it may be a parent, picked
    // with Escape), leaves it selected.
    if (!isSelected(el) && (!selected || !el || !selected.contains(el))) select(el);
    window.parent.postMessage(
      {
        type: "slop:edit-menu",
        slide: slide.id,
        x: event.clientX,
        y: event.clientY,
        element: selected && {
          path: selectorOf(selected),
          markup: cleanCopy(selected).outerHTML,
          name: nameOf(selected),
          added: !!selected.closest("[" + ADDED + "], [" + DROPPED + "]"),
        },
      },
      "*",
    );
  });

  document.addEventListener("pointermove", function (event) {
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
      var onHandle = ui.contains(event.target) || pointUi.contains(event.target);
      hover(editing || onHandle || tool !== "select" ? null : pickable(event.target, event.clientX, event.clientY));
      return;
    }
    if (drag.mode === "point") {
      pointTo(event);
      return;
    }
    if (drag.mode !== "move") {
      drag.moved = true;
      transformTo(event);
      followLines([drag.el]);
      showReadout(event);
      return;
    }
    var dx = event.clientX - drag.x;
    var dy = event.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    lastDown = { el: null, at: 0 };
    hover(null);
    moveDrag(event, dx, dy);
  });

  function endDrag() {
    if (create) finishCreating();
    if (marquee) finishMarquee();
    if (!drag) return;
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
    drag = null;
    clearDragMarks();
    // The handles to add points are away during a drag.
    if (point) placeHandles();
    if (moved) {
      refit(el);
      commit();
    }
    if (click) select(el);
  }
  document.addEventListener("pointerup", endDrag);
  document.addEventListener("pointercancel", endDrag);
  document.documentElement.addEventListener("pointerleave", function () {
    pointer = null;
    hover(null);
  });
  window.addEventListener("resize", placeHandles);
  window.addEventListener("load", scheduleOverflow);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleOverflow);
  scheduleOverflow();
  document.addEventListener("input", function (event) {
    // Typing over everything can take the body away, or leave text beside it.
    if (editing && !event.isComposing) ensureBody(editing);
    if (editing) refit(editing);
    placeHandles();
    if (editing) scheduleReport();
  });
  document.addEventListener("selectionchange", function () {
    if (editing && editRange()) scheduleReport();
  });
  // Clicking the app's toolbar keeps the text being edited, and its selection, for the toolbar
  // to restyle; a click elsewhere in the app ends editing ({ type: "slop:edit-finish" }).
  window.addEventListener("blur", function () {
    if (editing) editRange();
  });
  window.addEventListener("focus", function () {
    var range = editRange();
    if (range) useRange(range);
  });
  // Links on the slide do not go anywhere while editing it.
  document.addEventListener(
    "click",
    function (event) {
      var link = event.target && event.target.closest ? event.target.closest("a") : null;
      if (link && slide.contains(link)) event.preventDefault();
    },
    true,
  );
  document.addEventListener("dblclick", function (event) {
    if (tool !== "select") return;
    var el = pickable(event.target, event.clientX, event.clientY);
    if (el && !editing) startEditing(el, event.clientX, event.clientY);
  });

  // Pasted text keeps its formatting (cleaned, see pastedFragment), or with ⌘⇧V comes as plain text.
  document.addEventListener("paste", function (event) {
    if (!editing) return;
    event.preventDefault();
    var data = event.clipboardData;
    var html = data && !plainPaste ? data.getData("text/html") : "";
    var text = data ? data.getData("text/plain") : "";
    plainPaste = false;
    var content = html ? pastedFragment(html) : textFragment(text);
    if (!content.childNodes.length && text) content = textFragment(text);
    insertAtCaret(content);
  });
  document.addEventListener("drop", function (event) {
    if (editing) event.preventDefault();
  });

  /**
   * Adds dropped images (`assets/…` files) on top of the slide, centered on (x, y) and fit to
   * the slide, then selects the last one and saves. Each sits at the slide's top left with an
   * inline `translate` to where it was dropped, so it moves like any hand-moved element.
   */
  function insertImages(images, x, y) {
    finishEditing();
    if (nudgeTimer) commit();
    var rect = slide.getBoundingClientRect();
    var k = zoom();
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
      moveTo(img, (x - rect.left) / k - w / 2 + shift, (y - rect.top) / k - h / 2 + shift);
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
    if (nudgeTimer) commit();
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
    window.parent.postMessage({ type: "slop:edit-copied", slide: slide.id, html: html, text: text }, "*");
    if (cut) removeSelected();
  }

  /** What a copy of `el` needs to know of where it came from (see copySelected). */
  function clipHeader(el) {
    var computed = getComputedStyle(el);
    var center = centerOf(el);
    var size = sizeOf(el);
    var rect = slide.getBoundingClientRect();
    var k = zoom();
    var look = {};
    LOOK.forEach(function (prop) {
      if (computed[prop]) look[prop] = computed[prop];
    });
    return {
      slide: slide.id,
      path: pathOf(el),
      free: /^(absolute|fixed)$/.test(computed.position),
      box: {
        x: Math.round((center.x - rect.left) / k - size.w / 2),
        y: Math.round((center.y - rect.top) / k - size.h / 2),
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

  /** Pastes an element copied by copySelected on top of the slide (see 00-header.js). */
  function pasteElement(html) {
    var clip = parseClip(html);
    if (!clip) return;
    finishEditing();
    if (nudgeTimer) commit();
    if (Array.isArray(clip.header.group) && clip.header.group.length === clip.els.length && clip.els.length > 1) {
      pasteGroup(clip);
      return;
    }
    var el = document.importNode(clip.el, true);
    // Ids stay unique; a copy takes one only when the original is gone.
    restickCopies([el], idTaken);
    var box = clip.header.box && typeof clip.header.box === "object" ? clip.header.box : {};
    var w = box.w > 0 ? box.w : 0;
    var h = box.h > 0 ? box.h : 0;
    var at = pastePoint();
    var center = slidePoint(at.x, at.y);
    slide.appendChild(el);
    placeFree(el, clip.header, { x: center.x - w / 2, y: center.y - h / 2 });
    cascade(el);
    select(el);
    commit();
  }

  /** Moves a pasted copy down and right of any element of its kind already at the same spot. */
  function cascade(el) {
    var at = offsetOf(el);
    var x = at.x;
    var y = at.y;
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

  /** Adds a text box with pasted `text` where pastes go, styled like new text boxes. */
  function pasteText(text, style) {
    text = String(text || "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    if (!text.trim()) return;
    finishEditing();
    if (nudgeTimer) commit();
    var toolStyleBefore = toolStyle;
    toolStyle = style && typeof style === "object" ? style : {};
    var el = newText(0, 0);
    toolStyle = toolStyleBefore;
    var body = textRoot(el);
    body.textContent = "";
    text.split("\n").forEach(function (line, i) {
      if (i) body.appendChild(document.createElement("br"));
      body.appendChild(document.createTextNode(line));
    });
    var maxW = Math.round((slide.offsetWidth || 1920) * PASTE_TEXT_WIDTH);
    if (sizeOf(el).w > maxW) el.style.width = maxW + "px";
    var at = pastePoint();
    var center = slidePoint(at.x, at.y);
    var size = sizeOf(el);
    place(el, Math.round(center.x - size.w / 2), Math.round(center.y - size.h / 2), null, null);
    select(el);
    commit();
  }

