  // ---- Keys and the app's messages.

  // Capture phase, so keys the editor handles never reach the player (which forwards keys
  // to the app for slide navigation).
  window.addEventListener(
    "keydown",
    function (event) {
      var mod = event.metaKey || event.ctrlKey;
      var letter = String(event.key).toLowerCase();
      if (editing) {
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
        event.stopImmediatePropagation();
        return;
      }
      if (tool !== "select" && event.key === "Escape") {
        cancelCreating();
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
        // The app pastes: the player forwards the key. Nothing here takes a native paste.
        if (letter === "v") event.preventDefault();
      }
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
      if (!selected) return;
      if (event.metaKey || event.ctrlKey) {
        // Undo, paste and other shortcuts go to the app, after any pending nudge is saved.
        saveNudges();
        return;
      }
      var step = event.shiftKey ? 10 : 1;
      var nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
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
      } else if (event.key === "Escape") {
        select(extras.length || selected.parentElement === slide ? null : selected.parentElement);
      } else if (event.key === "Enter") {
        startEditing(selected);
      } else if (event.key === "Backspace" || event.key === "Delete") {
        removeSelected();
      } else {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data) return;
    if (arrangeMessage(data) || groupMessage(data) || commandMessage(data)) return;
    if (data.type === "slop:edit-select") {
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
  });

