  // ----- Commands: what the toolbar's buttons, the context menu and the keyboard shortcuts ask for
  // beyond a plain restyle: flips, text size steps, copying a look, clearing formatting, unlocking,
  // and previewing a restyle while a slider is dragged (see 00-header.js). -----

  /** Runs `change` with each of `targets` in turn as the selection, and saves them together. */
  function withEach(targets, change) {
    var primary = selected;
    var others = extras;
    batching = true;
    extras = [];
    targets.forEach(function (el) {
      selected = el;
      change(el);
    });
    selected = primary;
    extras = others;
    batching = false;
    restyled();
    commit();
  }

  /** Restyles the selection as the toolbar would: the selected text while typing, else every selected element. */
  function restyle(changes) {
    if (editing) {
      styleText(changes);
      return;
    }
    saveNudges();
    applyToSelection(changes);
  }

  /** Whether double-click or Enter would edit `el`'s text. */
  function canEditText(el) {
    if (!el || /^(img|svg|video|canvas|iframe|hr|br)$/i.test(el.tagName) || isGroup(el) || isLocked(el)) return false;
    return holdsOwnText(el);
  }

  /**
   * Mirrors every selected element that can flip, each in its own place, left to right ("x") or
   * top to bottom ("y"); a second flip puts it back. What cannot flip (text, plain boxes) stays.
   */
  function flipSelection(axis) {
    if (axis !== "x" && axis !== "y") return;
    finishEditing();
    saveNudges();
    var targets = leavesOf(movable()).filter(flippable);
    if (!targets.length) return;
    withEach(targets, function (el) {
      var now = lookOf(el, getComputedStyle(el));
      applyStyle(axis === "x" ? { flipX: !now.flipX } : { flipY: !now.flipY });
    });
  }

  // What the toolbar shows of a selection beyond its colors, each reported as mixed when several
  // selected elements do not share it (see describeSelection).
  var MIXABLE = [
    "fontFamily", "fontSize", "weight", "bold", "italic", "underline", "strike", "textCase", "align", "valign", "lineHeight",
    "letterSpacing", "spaceBefore", "spaceAfter", "autofit", "strokeWidth", "dash", "opacity", "shadow", "radius",
  ];

  /** The font size a step up (`step` 1) or down (-1) from `size`; null at either end of the steps. */
  function fontStep(size, step) {
    var sizes = FONT_STEPS.filter(function (other) {
      return step > 0 ? other > size : other < size;
    });
    return sizes.length ? (step > 0 ? sizes[0] : sizes[sizes.length - 1]) : null;
  }

  /**
   * Takes `el`'s text a size up or down: the element from its own size, and each run of text in
   * it that has a size of its own from that, so a large word stays larger than the rest.
   */
  function stepSizesIn(el, step) {
    if (autofit) autofit.unfit(el);
    var sized = [el].concat(Array.prototype.filter.call(el.querySelectorAll("[style*='font-size']"), function (inner) {
      return INLINE.test(inner.tagName) && inner.namespaceURI !== SVG_NS;
    }));
    // All the sizes first: one given in `em` changes with the element's.
    var next = sized.map(function (node) {
      return fontStep(Math.round(parseFloat(getComputedStyle(node).fontSize)), step);
    });
    sized.forEach(function (node, i) {
      if (next[i]) node.style.fontSize = next[i] + "px";
    });
    refit(el);
  }

  /**
   * The next font size up (`step` 1) or down (-1), each text from the size it has: every
   * selected element, and what a group holds, from its own; while typing, each run of the
   * selected text from its own (with only a caret, the whole element).
   */
  function stepFontSize(step) {
    if (!selected) return;
    var range = editing ? editRange() : null;
    if (editing && range && !range.collapsed) {
      ensureBody(editing, true);
      range = editRange();
      changeText(editing, function () {
        var root = editing;
        var at = textOffsets(root, range);
        coveredText(range, root).forEach(function (t) {
          var size = fontStep(Math.round(parseFloat(getComputedStyle(t.parentNode).fontSize)), step);
          if (size) formatText(t, { fontSize: size }, root);
        });
        tidy(root);
        useRange(rangeAt(root, at));
      });
      report();
      return;
    }
    if (editing) {
      stepSizesIn(editing, step);
      placeHandles();
      report();
      return;
    }
    saveNudges();
    var targets = leavesOf(movable()).filter(function (el) {
      var now = describe(el);
      return now.text && !!now.fontSize;
    });
    if (!targets.length) return;
    withEach(targets, function (el) {
      stepSizesIn(el, step);
    });
  }

  /** Turns every selected element a quarter turn clockwise (`step` 1) or counterclockwise (-1), each around its own center. */
  function rotateSelection(step) {
    finishEditing();
    saveNudges();
    var targets = movable();
    if (!targets.length) return;
    targets.forEach(function (el) {
      rotateTo(el, Math.round(angleOf(el)) + (step > 0 ? 90 : -90));
      refit(el);
    });
    placeHandles();
    commit();
  }

  /** Locks the selection, or unlocks it when its primary element is locked. */
  function toggleLock() {
    if (!selected) return;
    lockElements(allSelected(), !selected.hasAttribute(LOCK_ATTR));
  }

  /** Unlocks everything locked on the slide. */
  function unlockAll() {
    var locked = Array.prototype.slice.call(slide.querySelectorAll("[" + LOCK_ATTR + "]"));
    if (locked.length) lockElements(locked, false);
  }

  /**
   * Hands the selection's look to the app, to give to other elements later, also on another
   * slide: { type: "slop:edit-style-copied", slide, style }.
   */
  function copyStyle() {
    if (!selected || !slide.contains(selected)) return;
    var source = leavesOf([selected])[0];
    if (!source) return;
    tellApp({ type: "slop:edit-style-copied", slide: slide.id, style: paintableStyle(source) });
  }

  /** Gives every selected element the look `taken` (from copyStyle); fill and line only go between likes. */
  function pasteStyle(taken) {
    var part = function (value) {
      return !!value && typeof value === "object" && !Array.isArray(value);
    };
    if (!part(taken) || !part(taken.shared) || !part(taken.paint) || !part(taken.text)) return;
    finishEditing();
    saveNudges();
    var targets = leavesOf(movable());
    if (!targets.length) return;
    withEach(targets, function (el) {
      applyStyle(paintChanges(el, taken));
    });
  }

  /**
   * Takes the formatting off `el`'s text: the inline elements and styles around runs of it, but
   * not its links. An element of the deck's also drops the text styles set on it by hand, going
   * back to the deck's; a text box or shape the user added keeps them, as they are its whole look.
   */
  function clearText(el) {
    if (autofit) autofit.unfit(el);
    Array.prototype.slice.call(el.querySelectorAll("*")).reverse().forEach(function (inner) {
      if (INLINE.test(inner.tagName) && inner.namespaceURI !== SVG_NS) stripFormatting(inner, CLEARED);
    });
    if (!el.hasAttribute(ADDED)) {
      CLEARED_PROPS.forEach(function (prop) {
        el.style.removeProperty(prop);
      });
      if (!el.getAttribute("style")) el.removeAttribute("style");
    }
    colorMarkers(textRoot(el));
    tidy(textRoot(el));
    refit(el);
  }

  /** "Clear formatting": of the selected text while typing, else of all the text in the selection. */
  function clearFormatting() {
    if (editing) {
      var range = editRange();
      if (range && !range.collapsed) {
        ensureBody(editing, true);
        range = editRange();
        changeText(editing, function () {
          var root = editing;
          var at = textOffsets(root, range);
          coveredText(range, root).forEach(function (t) {
            isolate(t, root).forEach(function (el) {
              stripFormatting(el, CLEARED);
            });
          });
          colorMarkers(root);
          tidy(root);
          useRange(rangeAt(root, at));
        });
      } else {
        clearText(editing);
        placeHandles();
      }
      report();
      return;
    }
    saveNudges();
    var targets = leavesOf(movable()).filter(function (el) {
      return vectorsOf(el).length === 0 && !isImage(el);
    });
    if (targets.length) withEach(targets, clearText);
  }

  /** Every attribute of `el` but the editor's own marks, to put back later. */
  function attributesOf(el) {
    return Array.prototype.filter.call(el.attributes, function (attr) {
      return EDITOR_ATTRS.indexOf(attr.name) < 0;
    }).map(function (attr) {
      return [attr.name, attr.value];
    });
  }

  /**
   * Shows the selection restyled with `changes` without saving it, for a slider being dragged:
   * the first preview keeps how the elements were, and nothing saves until the restyle is applied
   * for good ({ type: "slop:edit-style" } without `preview`) or cancelled.
   */
  function previewStyle(changes) {
    if (editing || !selected) return;
    if (!preview) {
      preview = leavesOf(allSelected()).map(function (el) {
        return { el: el, attrs: attributesOf(el) };
      });
    }
    applyToSelection(changes);
  }

  /** Ends a preview, keeping what it shows: it saves with the next change. */
  function endPreview() {
    preview = null;
  }

  /** Puts the elements a preview restyled back as they were. */
  function cancelPreview() {
    var was = preview;
    if (!was) return;
    preview = null;
    was.forEach(function (item) {
      var el = item.el;
      attributesOf(el).forEach(function (attr) {
        el.removeAttribute(attr[0]);
      });
      item.attrs.forEach(function (attr) {
        el.setAttribute(attr[0], attr[1]);
      });
      refit(el);
    });
    placeHandles();
    report();
  }
  // Anything done on the slide itself ends a preview the app never finished.
  listen(document, "pointerdown", endPreview, true);
  listen(window, "keydown", endPreview, true);

  /** Asks the app for something only it can do: open its Link popover, or hand back the copied look. */
  function askApp(what) {
    tellApp({ type: "slop:edit-request", slide: slide.id, what: what });
  }

  /** The letter of a key. With Alt held a key types something else, so there it goes by its place on the keyboard. */
  function keyLetter(event) {
    var code = event.altKey ? /^Key([A-Z])$/.exec(event.code || "") : null;
    return code ? code[1].toLowerCase() : String(event.key).toLowerCase();
  }

  /** Which of a pair of keys was pressed (1 for the second, -1 for the first, 0 for neither), shifted or not. */
  function keyOfPair(event, first, second, firstCode, secondCode) {
    if (second.indexOf(event.key) >= 0 || event.code === secondCode) return 1;
    if (first.indexOf(event.key) >= 0 || event.code === firstCode) return -1;
    return 0;
  }

  /**
   * The shortcuts with ⌘ / Ctrl that work on the selection (see 00-header.js): restacking, text
   * alignment and size, flips, locking, the link popover and copying a look. Those for text also
   * work while typing. True when the key was one of them and there was something to do it to.
   */
  function runShortcut(event) {
    if (!(event.metaKey || event.ctrlKey) || !selected) return false;
    var letter = keyLetter(event);
    var shift = event.shiftKey;
    if (event.altKey) {
      if (editing) return false;
      // ⌥⇧H / ⌥⇧V flip: ⇧⌘V is pasting as plain text, on the slide as in its text.
      if (shift) {
        if (letter !== "h" && letter !== "v") return false;
        flipSelection(letter === "h" ? "x" : "y");
        return true;
      }
      if (letter === "l") toggleLock();
      else if (letter === "c") copyStyle();
      else if (letter === "v") askApp("paste-style");
      else if (letter === "r") rotateSelection(1);
      else return false;
      return true;
    }
    var bracket = keyOfPair(event, "[{", "]}", "BracketLeft", "BracketRight");
    if (bracket) {
      if (editing) return false;
      saveNudges();
      var to = shift ? (bracket > 0 ? "front" : "back") : bracket > 0 ? "forward" : "backward";
      forEachSelected(function () {
        restack(to, false);
      });
      return true;
    }
    if (!shift) {
      if (letter !== "k") return false;
      // The text selection stays for the link to go on.
      editRange();
      askApp("link");
      return true;
    }
    var align = { l: "left", e: "center", r: "right", j: "justify" }[letter];
    var size = keyOfPair(event, ",<", ".>", "Comma", "Period");
    if (align || size || letter === "x") {
      var text = describe(selected);
      if (!text.text) return false;
      if (align) restyle({ align: align });
      else if (size) stepFontSize(size);
      else toggleStyle("strike");
      return true;
    }
    return false;
  }

  /** Handles the app's messages for this section; true when `data` was one. */
  function commandMessage(data) {
    if (data.type === "slop:edit-flip") flipSelection(String(data.axis));
    // The tool named stays in hand once it is picked (it may come after this), until Select is.
    else if (data.type === "slop:edit-tool-keep") keptTool = data.on === true && TOOLS.indexOf(data.tool) > 0 ? data.tool : null;
    else if (data.type === "slop:edit-rotate") rotateSelection(data.step > 0 ? 1 : -1);
    else if (data.type === "slop:edit-toggle-style" && /^(bold|italic|underline|strike)$/.test(data.key)) toggleStyle(data.key);
    else if (data.type === "slop:edit-indent") indentSelection(data.step > 0 ? 1 : -1);
    else if (data.type === "slop:edit-font-step") stepFontSize(data.step > 0 ? 1 : -1);
    else if (data.type === "slop:edit-copy-style") copyStyle();
    else if (data.type === "slop:edit-paste-style") pasteStyle(data.style);
    else if (data.type === "slop:edit-clear-formatting") clearFormatting();
    else if (data.type === "slop:edit-unlock-all") unlockAll();
    else if (data.type === "slop:edit-edit-text") startEditing(selected);
    else if (data.type === "slop:edit-snap") snapping = data.on !== false;
    else if (data.type === "slop:edit-style-cancel") cancelPreview();
    else return false;
    return true;
  }

