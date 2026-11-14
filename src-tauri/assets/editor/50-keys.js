  // ---- Keys and the app's messages.

  // Capture phase, so keys the editor handles never reach the player (which forwards keys
  // to the app for slide navigation).
  window.addEventListener(
    "keydown",
    function (event) {
      var mod = event.metaKey || event.ctrlKey;
      var letter = String(event.key).toLowerCase();
      if (editing) {
        if (mod && !event.altKey && (letter === "z" || letter === "y")) {
          var redo = letter === "y" || event.shiftKey;
          if (stepText(redo)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }
          event.preventDefault();
          if (redo) {
            event.stopImmediatePropagation();
            return;
          }
          // Nothing of the typing left to undo: the text is done, and the key goes on to the
          // app, which undoes what came before it.
          finishEditing();
          return;
        }
        var before = textState();
        typingKey(event, mod, letter);
        textStepDone(before);
        event.stopImmediatePropagation();
        return;
      }
      // Escape first calls off what the pointer is in the middle of.
      if (event.key === "Escape" && cancelGesture()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (tool !== "select" && event.key === "Escape") {
        cancelCreating();
        clearDragMarks();
        useTool("select", true);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (runShortcut(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (mod && !event.altKey && !event.shiftKey) {
        if (TOGGLES[letter] && selected && describe(selected).text) {
          saveNudges();
          toggleStyle(TOGGLES[letter]);
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if ((letter === "c" || letter === "x") && selected) {
          copySelected(letter === "x");
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (letter === "a" || letter === "d" || letter === "g") {
          if (letter === "a") selectAll();
          else if (letter === "d") duplicate();
          else groupSelection();
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
      // The app pastes (⇧ as plain text): the player forwards the key. Nothing here takes a native paste.
      if (mod && !event.altKey && letter === "v") event.preventDefault();
      if (mod && event.shiftKey && !event.altKey && letter === "g") {
        ungroupSelection();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (event.key === "Tab" && !mod && tool === "select") {
        cycleSelection(event.shiftKey ? -1 : 1);
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (zoomToSelectionKey(event)) {
        if (selected) frameSelection();
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!selected) return;
      if (event.metaKey || event.ctrlKey) {
        // Undo, paste and other shortcuts go to the app, after any pending nudge is saved.
        saveNudges();
        return;
      }
      if (typeToEdit(event) || selectionKey(event.key, event.shiftKey)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  /** A key pressed while typing (but undo and redo), which may change the text. */
  function typingKey(event, mod, letter) {
    var item = event.key === "Enter" || event.key === "Tab" ? caretItem() : null;
    if (mod && !event.altKey && !event.shiftKey && TOGGLES[letter]) {
      event.preventDefault();
      toggleStyle(TOGGLES[letter]);
    } else if (runShortcut(event)) {
      event.preventDefault();
    } else if (mod && event.shiftKey && letter === "v") {
      // The app reads the clipboard's text and answers with slop:edit-insert-text.
      event.preventDefault();
      editRange();
      window.parent.postMessage({ type: "slop:edit-paste-request", slide: slide.id, plain: true }, "*");
    } else if (event.key === "Escape" || (event.key === "Enter" && mod && !event.shiftKey)) {
      event.preventDefault();
      finishEditing();
    } else if (event.key === "Enter" && item && !event.shiftKey) {
      event.preventDefault();
      newItem(item);
    } else if (event.key === "Enter") {
      event.preventDefault();
      insertLineBreak();
    } else if (event.key === "Backspace" && !mod && !event.altKey && itemAtCaretStart()) {
      // At the start of an item, Backspace takes its bullet away before it joins lines.
      event.preventDefault();
      unlistItem(itemAtCaretStart());
    } else if (event.key === "Tab" && !mod) {
      // Focus stays in the text; in a list, Tab indents the item.
      event.preventDefault();
      if (item) changeText(editing, function () {
        if (event.shiftKey) outdent(item);
        else indent(item);
      });
      report();
    }
  }

  /**
   * What a plain key does to the selection: the arrows nudge it, Escape lets go of it (out of a
   * group gone into, back to the group), ⇧Enter selects its parent, Enter edits its text, and
   * Delete or Backspace removes it. The same whether the key was pressed in the slide or, with
   * the focus in the app, sent on as { type: "slop:edit-key", key, shift }. False for any other key.
   */
  function selectionKey(key, shift) {
    if (!selected) return false;
    var step = shift ? 10 : 1;
    var nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
    if (nudge) {
      var moving = movable();
      moving.forEach(function (el) {
        moveBy(el, nudge[0], nudge[1]);
      });
      followStuck(nudgeFollowers(moving));
      // A run of nudges of the same elements is one step to undo, however many saves it takes.
      saveSoon("nudge:" + moving.map(function (el) {
        return pathOf(el).join(".");
      }).join(","));
    } else if (key === "Escape") {
      var inGroup = enteredGroup && selected !== enteredGroup && enteredGroup.contains(selected);
      select(inGroup ? enteredGroup : null);
    } else if (key === "Enter" && shift) {
      selectParent();
    } else if (key === "Enter") {
      startEditing(selected);
    } else if (key === "Backspace" || key === "Delete") {
      removeSelected();
    } else {
      return false;
    }
    return true;
  }

  /**
   * Typing a character with one element that holds text selected types it there: its text is
   * edited, the character goes in at its end, and the key is no tool's shortcut. Space and 0
   * stay the pasteboard's, and ⇧2 / ⇧0 are the zoom's.
   */
  function typeToEdit(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;
    if (String(event.key).length !== 1 || event.key === " " || event.key === "0") return false;
    if (extras.length || !canEditText(selected) || zoomKeyCode(event)) return false;
    var el = selected;
    saveNudges();
    startEditing(el);
    if (editing !== el) return false;
    var range = document.createRange();
    range.selectNodeContents(textRoot(el));
    range.collapse(false);
    useRange(range);
    var before = textState();
    insertAtCaret(textFragment(event.key));
    textStepDone(before);
    return true;
  }

  /**
   * ⇧ with 2 or 0, by their place on the keyboard, whatever it types (but the digit itself, where
   * Shift types it): the view's own keys.
   */
  function zoomKeyCode(event) {
    if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey || /^[02]$/.test(event.key)) return false;
    return event.code === "Digit2" || event.code === "Digit0" || (!event.code && (event.key === "@" || event.key === ")"));
  }

  /** ⇧2: the view zooms to what is selected (see frameSelection). */
  function zoomToSelectionKey(event) {
    return zoomKeyCode(event) && (event.code === "Digit2" || event.key === "@");
  }

  /** Has the pasteboard zoom to fit the selection in the view and center it (⇧2). */
  function frameSelection() {
    if (!selected || typeof pasteboard.frameBox !== "function") return;
    var box = boundsOf(allSelected());
    pasteboard.frameBox({ x: box.left, y: box.top, w: box.right - box.left, h: box.bottom - box.top });
  }

  // ---- Undo while typing: the text's own steps, the toolbar's formatting among them, in the
  // order they were made. A run of typing is one step (until it pauses or turns from typing to
  // deleting); ⌘Z / ⇧⌘Z (or ⌘Y, or { type: "slop:edit-undo", redo }) go back and forth through
  // them, and once there is nothing left to undo, the text is done and the app undoes what came
  // before it. The steps end with the typing.

  // A pause this long in the typing starts a new step.
  var TYPING_STEP_MS = 1000;
  var MAX_TEXT_STEPS = 200;

  /** The text being edited as it is now, with its caret, to go back to; null when nothing is edited. */
  function textState() {
    if (!editing) return null;
    var range = editRange();
    return { el: editing, html: editing.innerHTML, style: editing.getAttribute("style"), at: range ? textOffsets(editing, range) : null };
  }

  function sameText(a, b) {
    return !!a && !!b && a.el === b.el && a.html === b.html && a.style === b.style;
  }

  /** The steps of the text being edited, from its first. */
  function stepsOf(el) {
    if (!textSteps || textSteps.el !== el) textSteps = { el: el, past: [], future: [], typedAt: 0, kind: "" };
    return textSteps;
  }

  /** Keeps `state` (see textState) as a step to go back to, when the text is no longer that. */
  function textStepDone(state) {
    if (!state || editing !== state.el || sameText(state, textState())) return;
    keepStep(state);
    textSteps.kind = "";
  }

  function keepStep(state) {
    var steps = stepsOf(state.el);
    if (sameText(steps.past[steps.past.length - 1], state)) return;
    steps.past.push(state);
    if (steps.past.length > MAX_TEXT_STEPS) steps.past.shift();
    steps.future = [];
  }

  /** Goes a step back (or with `redo`, forward) in the text being edited; false when there is none. */
  function stepText(redo) {
    if (!editing) return false;
    var steps = stepsOf(editing);
    var from = redo ? steps.future : steps.past;
    var to = redo ? steps.past : steps.future;
    var state = from.pop();
    if (!state) return false;
    to.push(textState());
    steps.kind = "";
    var el = editing;
    changeText(el, function () {
      el.innerHTML = state.html;
      if (state.style === null) el.removeAttribute("style");
      else el.setAttribute("style", state.style);
    });
    var range = rangeAt(el, state.at || { start: Infinity, end: Infinity });
    if (!state.at) range.collapse(false);
    useRange(range);
    report();
    return true;
  }

  // Each run of typing (or of deleting) is a step, kept as the text was before it.
  document.addEventListener(
    "beforeinput",
    function (event) {
      if (!editing || event.isComposing) return;
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        stepText(event.inputType === "historyRedo");
        return;
      }
      var steps = stepsOf(editing);
      var kind = /^delete/.test(event.inputType || "") ? "delete" : "insert";
      var now = Date.now();
      if (steps.kind !== kind || now - steps.typedAt > TYPING_STEP_MS) keepStep(textState());
      steps.kind = kind;
      steps.typedAt = now;
    },
    true,
  );

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data) return;
    // What the toolbar does to the text being typed is a step to undo, like the typing; going
    // through those steps is none.
    var before = data.type === "slop:edit-undo" ? null : textState();
    takeMessage(data);
    textStepDone(before);
  });

  /** Does what a message of the app asks. */
  function takeMessage(data) {
    if (arrangeMessage(data) || groupMessage(data) || commandMessage(data)) return;
    if (data.type === "slop:edit-key" && typeof data.key === "string") {
      // A key pressed with the focus in the app, for the selection (see selectionKey).
      if (!editing) selectionKey(data.key, !!data.shift);
    } else if (data.type === "slop:edit-undo") {
      // ⌘Z pressed in the app while typing: the typing's steps first, then the app's.
      if (!stepText(!!data.redo) && !data.redo) {
        finishEditing();
        window.parent.postMessage({ type: "slop:key", key: "z", mod: true, shift: false }, "*");
      }
    } else if (data.type === "slop:edit-select") {
      finishEditing();
      select(atPath(data.path));
      if (Array.isArray(data.also)) selectMany([selected].concat(data.also.map(atPath)));
      // Clearing the selection for a screenshot hides the wires too, until the next interaction.
      if (data.quiet) mark(wires, "data-quiet", true);
    } else if (data.type === "slop:edit-open-svg") {
      openSvg(selected);
    } else if (data.type === "slop:edit-keep-ratio") {
      keepRatio = !!data.on;
      ui.querySelectorAll('[data-handle="scale"]').forEach(function (handle) {
        handle.title = keepRatio
          ? "Resize, keeping the aspect ratio (Shift frees it, Alt resizes from the center)"
          : "Resize (Shift keeps the aspect ratio, Alt resizes from the center)";
      });
    } else if (data.type === "slop:edit-size-mode") {
      if (data.mode !== "resize" && data.mode !== "stretch") return;
      sizeMode = data.mode;
      ui.querySelectorAll('[data-handle="scale"]').forEach(function (handle) {
        handle.title = sizeMode === "resize"
          ? "Resize (Shift keeps the aspect ratio, Alt resizes from the center)"
          : "Stretch (Shift keeps the aspect ratio, Alt scales from the center, double-click resets)";
      });
    } else if (data.type === "slop:edit-tool") {
      toolStyle = data.style && typeof data.style === "object" ? data.style : {};
      if (data.tool !== tool) {
        cancelCreating();
        clearDragMarks();
        finishEditing();
        useTool(String(data.tool));
      }
    } else if (data.type === "slop:edit-style" && data.style && typeof data.style === "object") {
      if (data.preview) {
        previewStyle(data.style);
        return;
      }
      // What a preview showed is saved with this, as one change.
      endPreview();
      if (editing) styleText(data.style);
      else applyToSelection(data.style);
    } else if (data.type === "slop:edit-list") {
      toggleList(String(data.list));
    } else if (data.type === "slop:edit-link" && (data.href === null || typeof data.href === "string")) {
      setLink(data.href);
    } else if (data.type === "slop:edit-finish") {
      finishEditing();
    } else if (data.type === "slop:edit-insert-text" && typeof data.text === "string") {
      if (editing) insertAtCaret(textFragment(data.text));
    } else if (data.type === "slop:edit-order") {
      finishEditing();
      // From the Layers panel: that layer, past the next one whether or not they overlap.
      if (Array.isArray(data.path) && atPath(data.path)) select(atPath(data.path));
      forEachSelected(function () {
        restack(String(data.to), !!data.any);
      });
    } else if (data.type === "slop:edit-delete") {
      finishEditing();
      if (selected) removeSelected();
    } else if (data.type === "slop:edit-insert-images" && isFinite(data.x) && isFinite(data.y)) {
      insertImages(data.images, data.x, data.y);
    } else if (data.type === "slop:edit-copy") {
      copySelected(!!data.cut);
    } else if (data.type === "slop:edit-paste-images") {
      var at = givenPoint(data) || pastePoint();
      insertImages(data.images, at.x, at.y);
    } else if (data.type === "slop:edit-paste") {
      pasteElement(data.html, givenPoint(data));
    } else if (data.type === "slop:edit-paste-text" && typeof data.text === "string") {
      pasteText(data.text, data.style, givenPoint(data));
    } else if (data.type === "slop:edit-replace-image" && typeof data.src === "string") {
      replaceImage(data.src);
    } else if (data.type === "slop:edit-background" && (data.color === null || typeof data.color === "string")) {
      setBackground(data.color);
    }
  }

