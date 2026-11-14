/* SlopSlide player. Keys, none of them with ⌘, Ctrl or Alt held:
   →/↓, Space, PageDown, Enter: next slide; ←/↑, PageUp, Backspace, Shift+Space: previous slide;
   Home/End: first/last slide; a number then Enter: that slide (shown while typed; Backspace
   corrects it, Escape gives it up); B or . blanks the screen to black, W to white (a navigation
   key or a click brings the slide back); R: review marks.
   In a file of its own (not in the app's frames) also N/P for next/previous, F for full screen,
   O for all slides at once, K to play by itself or pause, and ? for the list of keys; a strip of
   controls shows while the pointer moves. A press on the slide goes on; on a touch screen a
   swipe does too, and a tap in the left quarter goes back. In the address, ?autoplay plays by
   itself from the start (each slide for its data-duration seconds, or ?autoplay=8 for 8 seconds
   each) and ?loop starts over after the last slide. In full screen, or while it plays, the
   display is kept awake where the browser can.
   In the app's show the keys are forwarded to the app too, which has the controls (see
   "slop:go" below). */
(function () {
  var root = document.documentElement;
  // The runtime-css block sets this before the body renders; without it the stylesheet lists
  // the slides for viewers that run no JavaScript.
  root.setAttribute("data-slop-player", "");
  var params = new URLSearchParams(location.search);
  var embed = params.has("embed");
  var framed = window.parent !== window;
  if (params.has("static")) root.setAttribute("data-slop-static", "");
  if (embed && params.has("static")) root.setAttribute("data-slop-thumbnail", "");

  // Rendered for a still or a capture (thumbnails, PDF, video, images): nothing to operate.
  var still = params.has("static") || params.has("print");
  // After the last slide the first one follows.
  var loop = params.has("loop");

  var deck = document.querySelector(".deck");
  var all = Array.prototype.filter.call(document.querySelectorAll(".slide"), function (el) {
    return !el.parentElement || !el.parentElement.closest(".slide");
  });
  // Hidden slides (data-hidden) are skipped by the show; the editor still embeds them.
  var slides = embed
    ? all
    : all.filter(function (el) {
        return !el.hasAttribute("data-hidden");
      });
  if (!deck || slides.length === 0) return;
  var current = -1;
  // The stage's size in slide pixels (the deck's slide size, 1920×1080 unless it names another).
  var W = deck.offsetWidth || 1920;
  var H = deck.offsetHeight || 1080;

  function fit() {
    var scale = Math.min(window.innerWidth / W, window.innerHeight / H);
    var x = (window.innerWidth - W * scale) / 2;
    var y = (window.innerHeight - H * scale) / 2;
    deck.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
  }

  /** Says `message` to the app, in its frames. */
  function tell(message) {
    if (framed) window.parent.postMessage(message, "*");
  }

  /** Where the first slide shown at or after place `from` among all slides is among those shown; the last one without. */
  function shownFrom(from) {
    for (var j = from; j < all.length; j++) {
      var index = slides.indexOf(all[j]);
      if (index >= 0) return index;
    }
    return slides.length - 1;
  }

  function indexFor(ref) {
    if (!ref) return 0;
    // A hidden slide's id lands on the next shown slide (or the last one).
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === ref) return shownFrom(i);
    }
    // The editor addresses slides without an id by position, as "#2".
    var n = parseInt(ref.replace(/^#/, ""), 10);
    return isNaN(n) ? 0 : Math.min(slides.length - 1, Math.max(0, n - 1));
  }

  // What a file of its own does besides: as a slide shows, as the number typed changes, and with
  // the keys that are its own (see the end of this file).
  var onShow = null;
  var onTyped = null;
  var ownKey = null;
  // When the slide on screen showed, on the document's animation clock (see keepTime).
  var shownAt = null;
  var transition = null;
  function morphNames(slide, enabled) {
    var seen = Object.create(null);
    Array.prototype.forEach.call(slide.querySelectorAll("[data-morph]"), function (el) {
      var key = el.getAttribute("data-morph");
      // Invalid or duplicate names must not break the whole browser transition.
      var valid = /^[a-z][a-z0-9-]*$/.test(key) && !seen[key];
      seen[key] = true;
      el.style.viewTransitionName = enabled && valid ? "slop-" + key : "";
    });
  }

  function show(index) {
    index = Math.min(slides.length - 1, Math.max(0, index));
    if (index === current) return;
    var previous = current;
    current = index;
    if (transition) transition.skipTransition();
    var motion = !window.matchMedia || !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var canMorph = previous >= 0 && !embed && !params.has("static") && motion &&
      document.startViewTransition && slides[index].querySelector("[data-morph]") &&
      slides[previous].querySelector("[data-morph]");
    function update() {
      if (current !== index) return;
      slides.forEach(function (el, i) {
        morphNames(el, !!canMorph && i === index);
        el.classList.toggle("active", i === index);
      });
      shownAt = document.timeline ? document.timeline.currentTime : null;
    }
    if (canMorph) {
      morphNames(slides[previous], true);
      var next = document.startViewTransition(update);
      transition = next;
      // A rejected snapshot (e.g. duplicate author CSS names) still switches the slide.
      next.ready.catch(function () {});
      next.finished.catch(function () {}).then(function () {
        if (transition !== next) return;
        transition = null;
        slides.forEach(function (el) { morphNames(el, false); });
      });
    } else update();
    if (embed) return;
    var id = slides[index].id || String(index + 1);
    try {
      history.replaceState(null, "", "#" + id);
    } catch (e) {
      // Sandboxed frames and some file:// contexts refuse URL updates; navigation still works.
    }
    tell({ type: "slop:slide", id: slides[index].id || null, index: index });
    if (onShow) onShow();
  }

  // Review marks drawn in the editor (the slopslide:review block), hidden until R or ?review
  // shows them. The editor draws them itself, so embedded previews leave them out, and the
  // app's show (?show) is for the audience, who never see them.
  var review = null;
  var reviewData = document.getElementById("slopslide-review");
  if (reviewData && !embed && !params.has("show")) {
    try {
      review = JSON.parse(reviewData.textContent);
    } catch (e) {
      review = null;
    }
  }
  var SVG = "http://www.w3.org/2000/svg";
  // Widths in screen pixels, as the editor draws them.
  var INK = { pen: { width: 4, opacity: 1 }, highlighter: { width: 28, opacity: 0.4 } };

  // SVG path data for a smooth curve through a stroke's points (fractions of the slide), as the
  // app draws it: from the first point to halfway to the next, then from halfway to halfway,
  // bent by each point between as a quadratic Bézier control point, to the last point.
  function smoothPath(points) {
    var xy = points.map(function (p) {
      return [p[0] * W, p[1] * H];
    });
    var at = function (x, y) {
      return Math.round(x * 10) / 10 + " " + Math.round(y * 10) / 10;
    };
    var halfway = function (i) {
      return at((xy[i][0] + xy[i + 1][0]) / 2, (xy[i][1] + xy[i + 1][1]) / 2);
    };
    var last = xy.length - 1;
    if (last < 2) {
      return xy
        .map(function (p, i) {
          return (i ? "L" : "M") + at(p[0], p[1]);
        })
        .join("");
    }
    var d = "M" + at(xy[0][0], xy[0][1]) + "L" + halfway(0);
    for (var i = 1; i < last; i++) {
      d += "Q" + at(xy[i][0], xy[i][1]) + " " + (i === last - 1 ? at(xy[last][0], xy[last][1]) : halfway(i));
    }
    return d;
  }

  function drawReview(slide, strokes) {
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "slop-review");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    strokes.forEach(function (stroke) {
      var ink = stroke && INK[stroke.tool];
      var points = stroke && stroke.points;
      if (!ink || !Array.isArray(points) || points.length === 0) return;
      var d = smoothPath(points);
      // A tap never moves; a tiny step makes the round cap draw it as a dot.
      if (points.every(function (p) { return p[0] === points[0][0] && p[1] === points[0][1]; })) d += "l0.01 0";
      var path = document.createElementNS(SVG, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", String(stroke.color));
      path.setAttribute("stroke-width", String(ink.width));
      path.setAttribute("stroke-opacity", String(ink.opacity));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(path);
    });
    slide.appendChild(svg);
  }

  /** Shows or hides the review marks; false when the deck has none. */
  function toggleReview(on) {
    if (!review || typeof review !== "object") return false;
    if (on) {
      all.forEach(function (slide) {
        var strokes = slide.id && review[slide.id];
        if (Array.isArray(strokes) && !slide.querySelector(":scope > .slop-review")) drawReview(slide, strokes);
      });
    }
    if (on) root.setAttribute("data-slop-review", "");
    else root.removeAttribute("data-slop-review");
    return true;
  }
  if (params.has("review")) toggleReview(true);

  // Text boxes with data-autofit="shrink" shrink their text until it fits their box. Every
  // font size in the box scales by the same factor, set inline; `original` gives back what the
  // inline font size was before, so the slide editor saves the markup without the fit.
  // Scales are tried in hundredths, down to FIT_MIN of them.
  var FIT_MIN = 20;
  var fitted = typeof Map === "function" ? new Map() : null;
  var fitScales = typeof Map === "function" ? new Map() : null;
  // The hundredths each box was last shrunk to, which is where the next search for it begins.
  var fitHints = fitted && new WeakMap();

  function overflows(el) {
    return el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
  }

  function fitNodes(el) {
    return [el].concat(
      Array.prototype.filter.call(el.querySelectorAll("*"), function (node) {
        return !node.closest("svg") || node.tagName.toLowerCase() === "svg";
      }),
    );
  }

  /** Puts back the font sizes `fitText` changed in `el`. */
  function unfitText(el) {
    if (!fitted) return;
    fitNodes(el).forEach(function (node) {
      var before = fitted.get(node);
      if (!before) return;
      fitted.delete(node);
      if (before.value) node.style.setProperty("font-size", before.value, before.priority);
      else node.style.removeProperty("font-size");
      if (!node.getAttribute("style")) node.removeAttribute("style");
    });
    fitScales.delete(el);
  }

  /**
   * The most hundredths, from FIT_MIN up, at which `fits` holds, given that it does not at 100
   * and holds for everything under the answer. Every question lays the box out again, so the
   * search begins at `near`, the answer the box had last time, and steps away from it, twice as
   * far each time, until the answer lies between two steps: text that is typed into, or that is
   * fitted again once a font arrived, mostly still fits where it did, or nearly.
   */
  function searchFit(fits, near) {
    var lo = FIT_MIN;
    var hi = 100;
    if (near > lo && near < hi) {
      var grows = fits(near);
      if (grows) lo = near;
      else hi = near;
      for (var step = 1; hi - lo > step; step *= 2) {
        var probe = grows ? lo + step : hi - step;
        var fitsThere = fits(probe);
        if (fitsThere) lo = probe;
        else hi = probe;
        if (fitsThere !== grows) break;
      }
    }
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Shrinks the text of a `data-autofit="shrink"` box until it fits; false when it already does. */
  function fitText(el) {
    if (!fitted) return false;
    unfitText(el);
    if (el.getAttribute("data-autofit") !== "shrink" || (!el.clientHeight && !el.clientWidth) || !overflows(el)) {
      return false;
    }
    var nodes = fitNodes(el);
    var sizes = nodes.map(function (node) {
      return parseFloat(getComputedStyle(node).fontSize) || 0;
    });
    nodes.forEach(function (node) {
      fitted.set(node, {
        value: node.style.getPropertyValue("font-size"),
        priority: node.style.getPropertyPriority("font-size"),
      });
    });
    var scaleTo = function (k) {
      nodes.forEach(function (node, i) {
        if (sizes[i]) node.style.setProperty("font-size", Math.round(sizes[i] * k * 100) / 100 + "px", "important");
      });
    };
    // The scale last tried, so the answer is not set twice when the search ends on it.
    var set = 0;
    var best = searchFit(function (hundredths) {
      set = hundredths;
      scaleTo(hundredths / 100);
      return !overflows(el);
    }, fitHints.get(el));
    if (set !== best) scaleTo(best / 100);
    fitHints.set(el, best);
    fitScales.set(el, best / 100);
    return true;
  }

  // What has arrived since the last fit of all boxes that changes how text measures: an image or
  // a style sheet (`arrived`), or a web font (more of them loaded than `fontsFitted`).
  var arrived = false;
  var fontsFitted = 0;

  /** How many web fonts are loaded; -1 where the browser does not say. */
  function fontsLoaded() {
    if (!document.fonts || !document.fonts.forEach) return -1;
    var loaded = 0;
    document.fonts.forEach(function (face) {
      if (face.status === "loaded") loaded += 1;
    });
    return loaded;
  }

  function fitAll() {
    arrived = false;
    fontsFitted = fontsLoaded();
    // An embedded preview shows one slide and never another, so only that one is fitted.
    var within = embed ? slides[current] : document;
    Array.prototype.forEach.call(within.querySelectorAll('.slide [data-autofit="shrink"]'), fitText);
  }

  /** Fits every box again if anything arrived that the last fit did not see. */
  function refit() {
    if (arrived || fontsFitted < 0 || fontsLoaded() !== fontsFitted) fitAll();
  }

  window.slopAutofit = {
    fit: fitText,
    unfit: unfitText,
    fitAll: fitAll,
    /** What `node`'s inline font size was before a fit: { value, priority }, or null when not fitted. */
    original: function (node) {
      return (fitted && fitted.get(node)) || null;
    },
    /** How far the box `el` is shrunk (1 when it is not). */
    scale: function (el) {
      return (fitScales && fitScales.get(el)) || 1;
    },
  };

  window.addEventListener("resize", fit);
  fit();
  show(indexFor(embed ? params.get("slide") : decodeURIComponent(location.hash.slice(1))));
  // Fitted before the first paint, and again once web fonts are in and once the page has loaded,
  // if something arrived by then. An image's or a style sheet's `load` and `error` do not bubble,
  // so they are caught on the way down; the page's own `load` is no arrival.
  fitAll();
  ["load", "error"].forEach(function (type) {
    document.addEventListener(
      type,
      function (event) {
        if (event.target !== document) arrived = true;
      },
      true,
    );
  });
  window.addEventListener("load", refit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen && root.requestFullscreen();
  }

  // The screen blanked to black or white, the slide staying where it is underneath. The app's
  // show hears of it ({ type: "slop:blank", color }, null once the slide is back) and asks for it
  // the same way.
  function setBlank(color) {
    if (color === root.getAttribute("data-slop-blank")) return;
    if (color) root.setAttribute("data-slop-blank", color);
    else root.removeAttribute("data-slop-blank");
    if (!embed) tell({ type: "slop:blank", color: color });
  }
  function blank(color) {
    setBlank(root.getAttribute("data-slop-blank") === color ? null : color);
  }
  /** Brings the slide back when the screen is blank; false when it was not. */
  function unblank() {
    if (!root.hasAttribute("data-slop-blank")) return false;
    setBlank(null);
    return true;
  }

  // In the app's show, going on from the last slide ends on a dark screen (the app writes "End of
  // show" over it), as the show is not over by surprise: { type: "slop:end", ended }. Going on
  // from there asks the app to end the show ({ type: "slop:exit" }); going back shows the last
  // slide again.
  var ended = false;
  function setEnded(on) {
    if (on === ended) return;
    ended = on;
    if (on) root.setAttribute("data-slop-end", "");
    else root.removeAttribute("data-slop-end");
    tell({ type: "slop:end", ended: on });
  }
  /** Where the show is among the slides: the end screen counts as one more, after the last. */
  function place() {
    return ended ? slides.length : current;
  }
  /** Goes to slide `to`; past the last one it starts over (?loop), or ends the app's show. */
  function move(to) {
    if (to >= slides.length) {
      if (loop) to = 0;
      else if (framed) {
        if (ended) tell({ type: "slop:exit" });
        else setEnded(true);
        return;
      }
    }
    setEnded(false);
    show(to);
  }

  // The digits typed so far of a slide number, which Enter jumps to; forgotten after a pause.
  // They are shown while typed: in the strip of a file of its own, and by the app in its show
  // ({ type: "slop:typed", typed }).
  var typed = "";
  var typedTimer = null;
  var TYPED_MS = 3000;
  function setTyped(value) {
    clearTimeout(typedTimer);
    if (value) typedTimer = setTimeout(forget, TYPED_MS);
    if (value === typed) return;
    typed = value;
    tell({ type: "slop:typed", typed: value });
    if (onTyped) onTyped();
  }
  function forget() {
    setTyped("");
  }
  // For the app's pasteboard, which takes 0 to fit a zoomed slide unless it is a digit of a number.
  window.slopPlayer = {
    typing: function () {
      return typed !== "";
    },
  };

  /**
   * The slide numbered `n`. A file of its own counts the slides it shows. The app's show counts
   * all of them, as the app's slide list does, and a hidden one stands for the next one shown.
   */
  function numbered(n) {
    if (!framed) return n - 1;
    return shownFrom(Math.min(all.length, Math.max(1, n)) - 1);
  }

  /** Where a navigation key goes: a slide index, or null when `key` is none. */
  function destination(key, shift) {
    var lower = key.length === 1 ? key.toLowerCase() : key;
    var at = place();
    if (key === " ") return shift ? at - 1 : at + 1;
    // A file of its own also takes N and P; in the app those letters are the presenter's.
    if (!framed && lower === "n") return at + 1;
    if (!framed && lower === "p") return at - 1;
    if (shift) return null;
    if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown" || key === "Enter") return at + 1;
    if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp" || key === "Backspace") return at - 1;
    if (key === "Home") return 0;
    if (key === "End") return slides.length - 1;
    return null;
  }

  /** Acts on a key pressed without ⌘, Ctrl or Alt; false when it is none of the player's. */
  function navigate(key, shift) {
    var lower = key.length === 1 ? key.toLowerCase() : key;
    if (/^[0-9]$/.test(key)) {
      setTyped((typed + key).slice(-4));
      return true;
    }
    // A number being typed is corrected with Backspace and given up with Escape.
    if (typed && (key === "Backspace" || key === "Escape")) {
      setTyped(key === "Escape" ? "" : typed.slice(0, -1));
      return true;
    }
    var number = typed;
    forget();
    if (lower === "b" || key === ".") blank("black");
    else if (lower === "w") blank("white");
    else if (lower === "f" && !framed) toggleFullscreen();
    else if (key === "Enter" && number && !shift) {
      unblank();
      move(numbered(parseInt(number, 10)));
    } else {
      var to = destination(key, shift);
      if (to === null) return false;
      // On a blank screen the key only brings the slide back.
      if (!unblank()) move(to);
    }
    return true;
  }

  /** Whether a key pressed on `el` is its own: typing in a field, or Enter and Space on a control. */
  function keepsKey(el, key) {
    if (!el || !el.closest) return false;
    if (el.closest("input, textarea, select, [contenteditable]")) return true;
    return (key === "Enter" || key === " ") && !!el.closest("a[href], button, summary, video, audio");
  }

  window.addEventListener("keydown", function (event) {
    if (framed) {
      var mod = event.metaKey || event.ctrlKey;
      var message = { type: "slop:key", key: event.key, mod: mod, shift: event.shiftKey };
      if (event.altKey) message.alt = true;
      window.parent.postMessage(message, "*");
    }
    if (embed) return;
    // With a modifier the key is the browser's (find, back, reload) or the system's.
    if (event.metaKey || event.ctrlKey || event.altKey || keepsKey(event.target, event.key)) return;
    if (ownKey && ownKey(event.key)) event.preventDefault();
    else if (event.key === "r" || event.key === "R") {
      if (toggleReview(!root.hasAttribute("data-slop-review"))) event.preventDefault();
    } else if (navigate(event.key, event.shiftKey)) event.preventDefault();
  });

  // Narration playing in the app keeps the slide's timed animations with it (src/lib/slideClock.ts):
  // { type: "slop:clock", slide, at } puts each CSS animation that began as that slide showed
  // (the ones under `.slide.active`) `at` seconds in, as a video export has them, though the
  // slide may have shown long before the narration started. One that was running before (a
  // loop carrying on across slides) or is paused on purpose is left alone, and one is only
  // moved once it drifted, so nothing stutters. With `paused`, they are held at `at` instead of
  // running on from it (the timeline's playhead while it does not play), and `at: null` lets
  // the ones held so run again.
  var driven = typeof WeakSet === "function" ? new WeakSet() : null;
  var endedAnimations = driven && new WeakSet();
  var held = driven && new WeakSet();
  function releaseTime() {
    if (!held || !document.getAnimations) return;
    document.getAnimations().forEach(function (animation) {
      if (!held.has(animation)) return;
      held.delete(animation);
      animation.play();
    });
  }
  function keepTime(id, at, paused) {
    var slide = slides[current];
    if (!slide || (id && slide.id !== id) || !driven || !document.getAnimations || !(at >= 0)) return;
    var ms = at * 1000;
    document.getAnimations().forEach(function (animation) {
      var effect = animation.effect;
      var target = effect && effect.target;
      // CSS transitions (the slide's fade) are not the slide's timeline.
      if (typeof animation.animationName !== "string" || !target || !slide.contains(target)) return;
      if (animation.playState === "paused" && !endedAnimations.has(animation) && !held.has(animation)) return;
      if (!driven.has(animation)) {
        var began = animation.startTime;
        if (shownAt !== null && began !== null && began < shownAt - 50) return;
        driven.add(animation);
      }
      var end = effect.getComputedTiming().endTime;
      if (ms >= end) {
        // Past its end it rests on its last frame instead of starting over.
        animation.currentTime = end;
        animation.pause();
        endedAnimations.add(animation);
        return;
      }
      endedAnimations.delete(animation);
      if (paused) {
        animation.currentTime = ms;
        animation.pause();
        held.add(animation);
        return;
      }
      held.delete(animation);
      if (Math.abs((animation.currentTime || 0) - ms) > 40) animation.currentTime = ms;
      if (animation.playState === "paused") animation.play();
    });
  }
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!framed || !data || data.type !== "slop:clock") return;
    if (data.at === null) releaseTime();
    else keepTime(data.slide, Number(data.at), !!data.paused);
  });

  if (embed) return;

  /** What a screen reader says of slide `index`: "Slide 3 of 12: its first heading". */
  function describe(index) {
    var title = headingOf(slides[index]);
    return "Slide " + (index + 1) + " of " + slides.length + (title ? ": " + title : "");
  }
  function headingOf(slide) {
    var heading = slide.querySelector("h1, h2, h3, [role=heading]");
    return heading ? (heading.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  }
  // Each slide is a group a screen reader calls a slide, under its number and heading. Only on
  // the page being shown: nothing of it is ever saved, and a capture has no reader.
  if (!still) {
    slides.forEach(function (slide, index) {
      if (!slide.hasAttribute("role")) slide.setAttribute("role", "group");
      slide.setAttribute("aria-roledescription", "slide");
      if (!slide.hasAttribute("aria-label") && !slide.hasAttribute("aria-labelledby")) {
        slide.setAttribute("aria-label", describe(index));
      }
    });
  }

  // The presenter forwards keys pressed while its drawing tools have focus: { type: "slop:go",
  // key, shift }. It goes to a slide picked in its overview with { type: "slop:goto", id } and
  // blanks the screen with { type: "slop:blank", color } (black, white or null). Its controls
  // come and go with the pointer, whose moves over the slide only this page sees: it says so
  // ({ type: "slop:pointer" }, a few times a second at most), and hides the cursor while the
  // presenter says the pointer rests ({ type: "slop:idle", idle }).
  var POINTER_MS = 250;
  var pointerTold = 0;
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!framed || !data) return;
    if (data.type === "slop:go") navigate(String(data.key), !!data.shift);
    if (data.type === "slop:goto") {
      forget();
      unblank();
      setEnded(false);
      show(indexFor(String(data.id)));
    }
    if (data.type === "slop:blank") setBlank(data.color === "black" || data.color === "white" ? data.color : null);
    if (data.type === "slop:idle") {
      if (data.idle) root.setAttribute("data-slop-idle", "");
      else root.removeAttribute("data-slop-idle");
      // The first move after a rest is told at once, so the cursor is back at once.
      if (data.idle) pointerTold = 0;
    }
  });
  if (framed) {
    document.addEventListener("mousemove", function () {
      var now = Date.now();
      // Once told, the moves that follow say nothing new, also while the presenter's answer
      // that the pointer no longer rests is on its way.
      if (now - pointerTold < POINTER_MS) return;
      pointerTold = now;
      window.parent.postMessage({ type: "slop:pointer" }, "*");
    });
  }
  window.addEventListener("hashchange", function () {
    show(indexFor(decodeURIComponent(location.hash.slice(1))));
  });

  // A press on the slide goes on to the next one, unless it is on something with a use of its
  // own or ends a selection of text. A tap in the left quarter of a touch screen goes back; a
  // mouse click there goes on like anywhere else.
  var NOT_ADVANCING =
    "a, button, input, select, textarea, label, summary, video, audio, [contenteditable], [role=button], [onclick], .slop-controls, .slop-help";
  // A click this soon after a touch ended is that touch's tap.
  var TAP_MS = 700;
  var touchedAt = 0;
  document.addEventListener("click", function (event) {
    var link = event.target.closest("a[href]");
    // The app's frames go nowhere: a link out of the deck is the app's to open, in the browser.
    if (framed && link && link.getAttribute("href").charAt(0) !== "#") {
      event.preventDefault();
      tell({ type: "slop:link", href: typeof link.href === "string" ? link.href : link.getAttribute("href") });
      return;
    }
    if (event.target.closest(NOT_ADVANCING)) return;
    var selection = window.getSelection && window.getSelection();
    if (selection && !selection.isCollapsed) return;
    // On a blank screen the click only brings the slide back.
    if (unblank()) return;
    var tapped = event.pointerType === "touch" || Date.now() - touchedAt < TAP_MS;
    move(place() + (tapped && event.clientX < window.innerWidth / 4 ? -1 : 1));
  });
  // A swipe is one finger moving mostly sideways over a page that is not zoomed: a pinch, a
  // second finger and a drag up, down or across are the browser's.
  var SWIPE_PX = 40;
  var touch = null;
  document.addEventListener("touchstart", function (event) {
    touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
  });
  document.addEventListener("touchend", function (event) {
    touchedAt = Date.now();
    var from = touch;
    touch = null;
    if (!from || event.touches.length > 0) return;
    var dx = event.changedTouches[0].clientX - from.x;
    var dy = event.changedTouches[0].clientY - from.y;
    var zoomed = window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.01;
    if (zoomed || Math.abs(dx) <= SWIPE_PX || Math.abs(dx) <= 1.5 * Math.abs(dy)) return;
    // The swipe moved the slide, so it was no tap: the click some browsers still send is not one.
    touchedAt = 0;
    move(place() + (dx < 0 ? 1 : -1));
  });
  document.addEventListener("touchcancel", function () {
    touch = null;
  });

  // A file opened in a browser has nothing saying how to operate it: a small strip of controls
  // (previous, "3 / 12", next, all slides, full screen, the keys) at the bottom shows while the
  // pointer moves, after a touch or a Tab, and goes again after a pause. The app's frames have
  // controls of their own, and a still or a capture is not operated at all. Hidden, the strip
  // takes no press and no focus (runtime.css), and it is never as wide as the slide, so pressing
  // the slide still advances.
  if (framed || still) return;
  var IDLE_MS = 2500;
  var ICONS = {
    previous: "M15 6l-6 6 6 6",
    next: "M9 6l6 6-6 6",
    play: "M8 5l11 7-11 7z",
    pause: "M9 5v14M15 5v14",
    overview: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
    fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    help: "M9 9a3 3 0 1 1 4.6 2.5c-.9.6-1.6 1.2-1.6 2.5M12 17.5v.5",
  };
  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }
  /** Gives a control its name (also its tooltip) and its icon. */
  function dress(button, label, icon) {
    button.setAttribute("aria-label", label);
    button.title = label;
    button.querySelector("path").setAttribute("d", icon);
  }
  function control(label, icon, run) {
    var button = element("button");
    button.type = "button";
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.appendChild(document.createElementNS(SVG, "path"));
    button.appendChild(svg);
    dress(button, label, icon);
    // Pressed with the pointer it leaves the focus where it was, so the strip can go again.
    button.addEventListener("mousedown", function (event) {
      event.preventDefault();
    });
    button.addEventListener("click", run);
    return button;
  }
  var strip = element("div", "slop-controls");
  strip.setAttribute("role", "toolbar");
  strip.setAttribute("aria-label", "Slide controls");
  strip.appendChild(
    control("Previous slide (←)", ICONS.previous, function () {
      if (!unblank()) move(place() - 1);
    }),
  );
  var count = element("span", "slop-controls-count");
  strip.appendChild(count);
  var nextButton = control("Next slide (→)", ICONS.next, function () {
    if (!unblank()) move(place() + 1);
  });
  strip.appendChild(nextButton);
  strip.appendChild(
    control("All slides (O)", ICONS.overview, function () {
      setOverview(!overview);
    }),
  );
  if (root.requestFullscreen) strip.appendChild(control("Full screen (F)", ICONS.fullscreen, toggleFullscreen));
  strip.appendChild(
    control("Keys (?)", ICONS.help, function () {
      setHelp(!helpOpen);
    }),
  );
  document.body.appendChild(strip);

  // Read out by a screen reader as each slide shows, and the page's title names the slide.
  var live = element("div", "slop-live");
  live.setAttribute("aria-live", "polite");
  document.body.appendChild(live);
  var deckTitle = document.title;
  /** Says which slide is on screen: in the strip (or the number being typed), to a screen reader, in the title. */
  function report() {
    count.textContent = typed ? "→ " + typed : current + 1 + " / " + slides.length;
    var said = describe(current);
    if (live.textContent !== said) live.textContent = said;
    var title = deckTitle ? (headingOf(slides[current]) || "Slide " + (current + 1)) + " · " + deckTitle : said;
    if (document.title !== title) document.title = title;
  }

  var idle = null;
  var over = false;
  function hideControls() {
    // It stays while the pointer is on it or the keyboard is in it.
    if (over || strip.contains(document.activeElement)) return;
    root.removeAttribute("data-slop-controls");
  }
  function showControls() {
    root.setAttribute("data-slop-controls", "");
    clearTimeout(idle);
    idle = setTimeout(hideControls, IDLE_MS);
  }
  document.addEventListener("mousemove", showControls);
  document.addEventListener("touchstart", showControls);
  strip.addEventListener("mouseenter", function () {
    over = true;
  });
  strip.addEventListener("mouseleave", function () {
    over = false;
    showControls();
  });
  strip.addEventListener("focusout", showControls);

  // Playing by itself (?autoplay, or K): each slide stays for its `data-duration` seconds, or
  // else for the seconds ?autoplay=… names (5 without), then the next one shows; after the last
  // it stops, or starts over with ?loop. Going to a slide by hand gives that slide its whole
  // time. One timer per slide: nothing runs between two slides.
  var PLAY_SECONDS = 5;
  var playSeconds = parseFloat(params.get("autoplay")) > 0 ? parseFloat(params.get("autoplay")) : PLAY_SECONDS;
  var playing = false;
  var playTimer = null;
  var playButton = null;
  function arm() {
    clearTimeout(playTimer);
    if (!playing) return;
    var own = parseFloat(slides[current].getAttribute("data-duration"));
    playTimer = setTimeout(
      function () {
        // What covers the slide (all slides, the keys, a blank screen) holds it.
        if (overview || helpOpen || root.hasAttribute("data-slop-blank")) return arm();
        if (current >= slides.length - 1 && !loop) return setPlaying(false);
        move(current + 1);
        arm();
      },
      (own > 0 ? own : playSeconds) * 1000,
    );
  }
  function setPlaying(on) {
    playing = on;
    if (!playButton) {
      playButton = control("", "", function () {
        setPlaying(!playing);
      });
      strip.insertBefore(playButton, nextButton.nextSibling);
    }
    dress(playButton, on ? "Pause (K)" : "Play by itself (K)", on ? ICONS.pause : ICONS.play);
    arm();
    keepAwake();
  }

  // In full screen, or playing by itself, the display is kept from going to sleep, where the
  // browser can do that. The browser lets go of it whenever the page is hidden, so it is asked
  // again when the page is back.
  var wake = null;
  function keepAwake() {
    if (!navigator.wakeLock) return;
    var wanted = (!!document.fullscreenElement || playing) && document.visibilityState === "visible";
    if (wanted && !wake) {
      var asked = navigator.wakeLock.request("screen");
      wake = asked;
      var lost = function () {
        if (wake === asked) wake = null;
      };
      asked.then(function (lock) {
        if (lock.addEventListener) lock.addEventListener("release", lost);
      }, lost);
    } else if (!wanted && wake) {
      var holding = wake;
      wake = null;
      holding.then(
        function (lock) {
          lock.release();
        },
        function () {},
      );
    }
  }
  document.addEventListener("fullscreenchange", keepAwake);
  document.addEventListener("visibilitychange", keepAwake);

  // All slides at once (O, or its button): the slides themselves, laid out small in rows by the
  // stylesheet, to pick one from with a press, or with the arrows and Enter. Escape or O closes it.
  var OVERVIEW_GAP = 16;
  var OVERVIEW_EDGE = 24;
  var overview = false;
  var picked = 0;
  var columns = 1;
  function layOutOverview() {
    columns = Math.max(2, Math.min(5, Math.floor(window.innerWidth / 320)));
    var width = (window.innerWidth - 2 * OVERVIEW_EDGE - (columns - 1) * OVERVIEW_GAP) / columns;
    root.style.setProperty("--slop-overview-zoom", String(Math.max(0.02, width / W)));
  }
  function pick(index) {
    slides[picked].removeAttribute("data-slop-picked");
    picked = Math.min(slides.length - 1, Math.max(0, index));
    slides[picked].setAttribute("data-slop-picked", "");
    if (slides[picked].scrollIntoView) slides[picked].scrollIntoView({ block: "nearest" });
  }
  function setOverview(on) {
    if (on === overview) return;
    overview = on;
    forget();
    if (on) {
      unblank();
      setHelp(false);
      layOutOverview();
      root.setAttribute("data-slop-overview", "");
      pick(current);
    } else {
      root.removeAttribute("data-slop-overview");
      root.style.removeProperty("--slop-overview-zoom");
      slides[picked].removeAttribute("data-slop-picked");
      window.scrollTo(0, 0);
    }
  }
  function choose(index) {
    setOverview(false);
    show(index);
  }
  function overviewKey(key) {
    if (key === "ArrowRight") pick(picked + 1);
    else if (key === "ArrowLeft") pick(picked - 1);
    else if (key === "ArrowDown") pick(picked + columns);
    else if (key === "ArrowUp") pick(picked - columns);
    else if (key === "Home") pick(0);
    else if (key === "End") pick(slides.length - 1);
    else if (key === "Enter" || key === " ") choose(picked);
    else if (key === "Escape" || key === "o" || key === "O") setOverview(false);
  }
  window.addEventListener("resize", function () {
    if (overview) layOutOverview();
  });
  // Before the slide's own click handlers and the one that advances: a press picks the slide.
  document.addEventListener(
    "click",
    function (event) {
      if (!overview || event.target.closest(".slop-controls")) return;
      event.preventDefault();
      event.stopPropagation();
      var slide = event.target.closest(".deck > .slide");
      if (slide && slides.indexOf(slide) >= 0) choose(slides.indexOf(slide));
      else setOverview(false);
    },
    true,
  );

  // The keys, listed (?, or its button), with a way to print: nothing else in the file says them.
  var KEYS = [
    ["→  ↓  Space  Enter  N", "Next slide"],
    ["←  ↑  Backspace  P", "Previous slide"],
    ["Home  /  End", "First / last slide"],
    ["A number, then Enter", "Go to that slide"],
    ["O", "All slides"],
    ["K", "Play by itself, or pause"],
    ["B or .  /  W", "Black / white screen"],
    ["F", "Full screen"],
    ["?", "These keys"],
  ];
  var helpOpen = false;
  var helpPanel = null;
  var focusBefore = null;
  function buildHelp() {
    var panel = element("div", "slop-help");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Keys");
    panel.tabIndex = -1;
    panel.appendChild(element("p", "slop-help-title", "Keys"));
    var list = element("dl");
    KEYS.forEach(function (row) {
      if (row[0] === "F" && !root.requestFullscreen) return;
      list.appendChild(element("dt", "", row[0]));
      list.appendChild(element("dd", "", row[1]));
    });
    panel.appendChild(list);
    panel.appendChild(
      element(
        "p",
        "slop-help-note",
        "On a touch screen, swipe, or tap the right or the left of the slide. " +
          "Add ?autoplay to the address to have it play by itself, and ?loop to start over after the last slide.",
      ),
    );
    var buttons = element("div", "slop-help-buttons");
    var print = element("button", "", "Print or save as PDF");
    print.type = "button";
    print.addEventListener("click", function () {
      setHelp(false);
      window.print();
    });
    var close = element("button", "", "Close");
    close.type = "button";
    close.addEventListener("click", function () {
      setHelp(false);
    });
    buttons.appendChild(print);
    buttons.appendChild(close);
    panel.appendChild(buttons);
    document.body.appendChild(panel);
    return panel;
  }
  function setHelp(on) {
    if (on === helpOpen) return;
    helpOpen = on;
    forget();
    if (on) {
      helpPanel = helpPanel || buildHelp();
      root.setAttribute("data-slop-help", "");
      focusBefore = document.activeElement;
      helpPanel.focus();
    } else {
      root.removeAttribute("data-slop-help");
      if (focusBefore && focusBefore.focus && helpPanel.contains(document.activeElement)) focusBefore.focus();
    }
  }
  // A press beside the list closes it and does nothing else.
  document.addEventListener(
    "click",
    function (event) {
      if (!helpOpen || event.target.closest(".slop-help, .slop-controls")) return;
      event.stopPropagation();
      setHelp(false);
    },
    true,
  );
  // Printed as the slides, not as what lay over them.
  window.addEventListener("beforeprint", function () {
    setOverview(false);
    setHelp(false);
  });

  /** The keys of a file of its own that are not the player's everywhere; false for any other. */
  ownKey = function (key) {
    var lower = key.length === 1 ? key.toLowerCase() : key;
    // Tab is the browser's, and the strip has to be in sight to take the focus.
    if (key === "Tab") showControls();
    if (key === "Tab" || key === "Shift") return false;
    if (helpOpen) {
      setHelp(false);
      // Escape and ? only close the list; any other key also does what it does.
      if (key === "Escape" || key === "?") return true;
    }
    if (overview) {
      overviewKey(key);
      return true;
    }
    if (key === "?") setHelp(true);
    else if (lower === "o") setOverview(true);
    else if (lower === "k") setPlaying(!playing);
    else return false;
    forget();
    return true;
  };
  onTyped = function () {
    report();
    showControls();
  };
  onShow = function () {
    report();
    arm();
  };
  report();
  if (params.has("autoplay")) setPlaying(true);

  // A phone held upright shows a wide slide small: said once, for a moment.
  var upright = window.matchMedia && window.matchMedia("(pointer: coarse) and (orientation: portrait)");
  if (upright && upright.matches && W > H) {
    var hint = element("div", "slop-hint", "Turn your phone sideways for a larger view");
    hint.setAttribute("role", "status");
    document.body.appendChild(hint);
    var hintTimer = setTimeout(dropHint, 6000);
    window.addEventListener("resize", dropHint);
  }
  function dropHint() {
    clearTimeout(hintTimer);
    window.removeEventListener("resize", dropHint);
    hint.remove();
  }
})();
