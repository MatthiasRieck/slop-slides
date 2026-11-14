
  // ---- Its life on the page: going away again, and the slide patched in place.
  //
  // The editor comes and goes with Edit mode, with no page load either way: the app tells the
  // pasteboard ({ type: "slop:edit-attach" }, { type: "slop:edit-detach" }; see pasteboard.js),
  // which runs this script when an editor is wanted and calls `window.slopEditor.detach()` when
  // it no longer is. Detached, the page is the player's again: the editor's marks, overlays,
  // styles and listeners are gone, whatever was under way is dropped unsaved, as a page loaded
  // again would have dropped it, and the slide shows its markup as last saved. Run after the
  // page has loaded, it says so: { type: "slop:edit-attached", slide }, for the app to set it up.
  //
  // { type: "slop:edit-patch", slide, hash, markup } gives the slide the markup it has now in the
  // deck (after an undo, say): it takes the place of what the slide shows, in place, so the view
  // stays where it is, and what was selected is selected again where it is still there (by its
  // id, or else the element of the same kind in its place). The editor then reports everything
  // about the slide again and answers { type: "slop:edit-patched", slide, hash, ok }. Not ok,
  // nothing changed, and the app loads the slide again instead: for markup that is not this
  // slide's, or with scripts in it or in what the slide shows, which only a page load runs.

  /** `markup` as an element of this page, when it is a slide in this one's place; null otherwise. */
  function parseSlide(markup) {
    var holder = document.createElement("template");
    holder.innerHTML = String(markup).trim();
    var next = holder.content.children.length === 1 ? holder.content.firstElementChild : null;
    if (!next || next.tagName !== slide.tagName || !next.classList.contains("slide") || next.id !== slide.id) return null;
    return next;
  }

  /** Makes the slide `next`: its attributes and what it holds. It stays the element it is, which the player and the pasteboard know. */
  function replaceSlide(next) {
    Array.prototype.slice.call(slide.attributes).forEach(function (attr) {
      if (!next.hasAttribute(attr.name)) slide.removeAttribute(attr.name);
    });
    Array.prototype.forEach.call(next.attributes, function (attr) {
      if (slide.getAttribute(attr.name) !== attr.value) slide.setAttribute(attr.name, attr.value);
    });
    // The player shows it.
    slide.classList.add("active");
    while (slide.firstChild) slide.removeChild(slide.firstChild);
    while (next.firstChild) slide.appendChild(next.firstChild);
  }

  /** Drops whatever is under way without saving it: a drag, a marquee, a tool's element, a preview, the typing, the nudges. */
  function dropWorkInHand() {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
    nudgeGroup = null;
    nudgeLines = null;
    clearTimeout(slideChecksTimer);
    slideChecksTimer = null;
    slideChecksDue = false;
    cancelCreating();
    drag = null;
    if (marquee) {
      marquee = null;
      marqueeBox.style.display = "none";
    }
    preview = null;
    clearDragMarks();
    previewStick(null);
    if (editing) {
      ["contenteditable", "spellcheck", "data-slop-editing"].forEach(function (name) {
        editing.removeAttribute(name);
      });
      slide.removeAttribute("data-slop-typing");
      editing = null;
      textRange = null;
      var range = window.getSelection();
      if (range) range.removeAllRanges();
    }
    textSteps = null;
    refitDue = false;
    enteredGroup = null;
    groupFrame = null;
    lastDown = { el: null, at: 0 };
    lastPoint = { index: -1, at: 0 };
    dropHover();
  }

  /** Fits the slide's text again once what it shows has come in: its images, and the fonts it asks for. */
  function fitWhenIn() {
    var waiting = 1;
    var arrived = function () {
      waiting--;
      if (waiting || detached) return;
      if (autofit) autofit.fitAll();
      placeHandles();
      scheduleOverflow();
    };
    Array.prototype.forEach.call(slide.querySelectorAll("img"), function (img) {
      if (img.complete) return;
      waiting++;
      img.addEventListener("load", arrived, { once: true });
      img.addEventListener("error", arrived, { once: true });
    });
    if (document.fonts && document.fonts.ready) {
      waiting++;
      // What the new markup asks for is known once its styles are worked out.
      void slide.offsetWidth;
      document.fonts.ready.then(arrived);
    }
    arrived();
  }

  /** What was `was` ({ id, path, tag, added }) on the slide shown before, if it is still there. */
  function foundAgain(was) {
    if (was.id) {
      return Array.prototype.find.call(slide.querySelectorAll("[id]"), function (el) {
        return el.id === was.id;
      }) || null;
    }
    var el = atPath(was.path);
    return el && !el.id && el.tagName === was.tag && el.getAttribute(ADDED) === was.added ? el : null;
  }

  /** Shows `markup` as the slide, in place (see above); false when only a page load can. */
  function patchSlide(markup) {
    var next = parseSlide(markup);
    if (!next || next.querySelector("script") || slide.querySelector("script")) return false;
    var kept = allSelected().map(function (el) {
      return { id: el.id, path: pathOf(el), tag: el.tagName, added: el.getAttribute(ADDED) };
    });
    dropWorkInHand();
    setSelection(null, []);
    replaceSlide(next);
    saved = serialize();
    if (autofit) autofit.fitAll();
    fitWhenIn();
    selectMany(kept.map(foundAgain));
    // Everything it reports about the slide, as a slide just loaded reports it.
    reportedSelection = null;
    report();
    placeHandles();
    reportBackground();
    if (deckFound) reportFonts();
    reportedLayers = null;
    scheduleLayers();
    reportedOverflow = null;
    scheduleOverflow();
    // The pasteboard marks the search's hits and finds the comments' elements on the slide again.
    if (typeof pasteboard.contentChanged === "function") pasteboard.contentChanged();
    return true;
  }

  /** Takes the editor off the page (see above). */
  function detach() {
    if (detached) return;
    dropWorkInHand();
    setSelection(null, []);
    // What was changed and not saved goes, as it would with the page loaded again.
    var was = saved === null ? null : parseSlide(saved);
    if (was && serialize() !== saved) replaceSlide(was);
    withDescendants(slide).forEach(function (node) {
      EDITOR_ATTRS.forEach(function (name) {
        node.removeAttribute(name);
      });
    });
    document.documentElement.removeAttribute("data-slop-tool");
    if (document.activeElement && slide.contains(document.activeElement)) document.activeElement.blur();
    [handlesFrame, hoverFrame, reportFrame, overflowFrame, geometryFrame, layersFrame, createFrame].forEach(function (frame) {
      if (frame) window.cancelAnimationFrame(frame);
    });
    detached = true;
    listening.forEach(function (entry) {
      entry[0].removeEventListener(entry[1], entry[2], entry[3]);
    });
    listening = [];
    added.forEach(function (el) {
      if (el.parentNode) el.parentNode.removeChild(el);
    });
    added = [];
    pasteboard.busy = idleBusy;
    if (typeof pasteboard.offChange === "function") pasteboard.offChange(cameraMoved);
    if (window.slopEditor === life) window.slopEditor = null;
  }

  var life = { detach: detach };
  window.slopEditor = life;
  if (document.readyState === "complete") tellApp({ type: "slop:edit-attached", slide: slide.id });
})();
