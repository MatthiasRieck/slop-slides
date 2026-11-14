/* SlopSlide render helper (src-tauri/src/render.rs, src-tauri/src/thumbnails.rs). The app runs
   it, after assets/overflow.js, in the hidden windows that render slides for the agent, for
   image exports and for the thumbnails; it never becomes part of a deck. Each step answers by
   navigating to /.render-signal?<answer>, which the app catches and cancels.

   A slide is captured once it is as it will stay, not after a fixed time: its fonts in, its
   images and background images loaded and decoded, its text boxes fitted, and a frame drawn.
   A short cap keeps a page that never gets there from holding the capture up for long. */
(function () {
  // WebView2 also finishes canceled signal navigations; the page-load callback runs us again.
  if (window.__slopRender) return;

  // The most overflow findings a slide reports; an answer travels in a URL.
  var MAX_FINDINGS = 20;
  // Longest wait for a slide to be ready; then it is captured as it is.
  var CAP = 3000;
  // Longest wait for the frame a capture follows, in milliseconds. A window out of sight draws
  // no frames, so this is how long its page is given to be drawn. The app says how long its
  // platform's capture needs (window.__slopRenderPaint, see render.rs): none on macOS, whose
  // capture draws the page afresh.
  var PAINT = typeof window.__slopRenderPaint === "number" ? window.__slopRenderPaint : 100;
  // What a slide with background images is given at least: a large one is decoded while it is
  // drawn, after the capture would have been made, and no event says when it is.
  var BACKGROUND_PAINT = 50;

  // Tests answer through __slopRenderSignal; jsdom cannot navigate.
  var signal =
    window.__slopRenderSignal ||
    function (answer) {
      location.assign(location.origin + "/.render-signal?" + answer);
    };

  function noop() {}

  /** Resolves after `ms` milliseconds. Timers run in a hidden window; frames may not. */
  function after(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /** Resolves once two frames have been drawn (the slide as it is now is on screen), or after
      `ms` milliseconds, as a window out of sight draws none; at once for 0. */
  function drawn(ms) {
    if (ms <= 0) return Promise.resolve();
    if (!window.requestAnimationFrame) return after(ms);
    var frames = new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(resolve);
      });
    });
    return Promise.race([frames, after(ms)]);
  }

  /** The URLs `value` (a computed `background-image`) loads. */
  function urls(value) {
    var found = [];
    var pattern = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    var match;
    while ((match = pattern.exec(value || ""))) {
      if (match[2] && !/^data:image\/svg/.test(match[2])) found.push(match[2]);
    }
    return found;
  }

  /** Loads and decodes the image at `url`; it is in the page's cache once the slide asked for it. */
  function decoded(url) {
    var img = new Image();
    img.src = url;
    return img.decode ? img.decode().catch(noop) : Promise.resolve();
  }

  /** Waits until `slide`, shown, is as it will stay: the fonts its laid-out text asked for, its
      images and the background images of it and everything in it, loaded and decoded. Resolves
      to how many background images it has. */
  function loaded(slide) {
    // Laid out first: only then has the slide asked for its fonts and background images.
    slide.getBoundingClientRect();
    var waits = [document.fonts ? document.fonts.ready : null];
    Array.prototype.forEach.call(slide.querySelectorAll("img"), function (img) {
      if (img.decode) waits.push(img.decode().catch(noop));
    });
    var seen = Object.create(null);
    var elements = [slide].concat(Array.prototype.slice.call(slide.querySelectorAll("*")));
    elements.forEach(function (el) {
      [null, "::before", "::after"].forEach(function (pseudo) {
        urls(getComputedStyle(el, pseudo).backgroundImage).forEach(function (url) {
          if (seen[url]) return;
          seen[url] = true;
          waits.push(decoded(url));
        });
      });
    });
    return Promise.all(waits).then(function () {
      return Object.keys(seen).length;
    });
  }

  /** Fits the text boxes of `slide` that shrink to fit, now that what they measure with is in.
      The player fits them as the page loads, while a slide not shown first may not be laid out. */
  function fitted(slide) {
    var autofit = window.slopAutofit;
    if (!autofit || !autofit.fit) return;
    Array.prototype.forEach.call(slide.querySelectorAll('[data-autofit="shrink"]'), function (box) {
      autofit.fit(box);
    });
  }

  /** Holds what moves on `slide` `at` seconds after it shows, as that frame of a video export:
      its CSS animations there (each counts from when the slide shows), and everything else,
      as the slide's fade, done. */
  function hold(slide, at) {
    if (!document.getAnimations) return;
    document.getAnimations().forEach(function (animation) {
      var effect = animation.effect;
      var target = effect && effect.target;
      animation.pause();
      if (typeof animation.animationName === "string" && target && slide.contains(target)) {
        animation.currentTime = Math.min(at * 1000, effect.getComputedTiming().endTime);
        return;
      }
      try {
        animation.finish();
      } catch (e) {
        // One that repeats forever has no end; paused, it stays where it is.
      }
    });
  }

  /** Every slide, those the show skips too: the agent works on them as well. */
  function slides() {
    return Array.prototype.slice.call(document.querySelectorAll(".deck > .slide"));
  }

  /** The slides as the player counts them: every `.slide` not inside another. */
  function playerSlides() {
    return Array.prototype.filter.call(document.querySelectorAll(".slide"), function (el) {
      return !el.parentElement || !el.parentElement.closest(".slide");
    });
  }

  /** The slide a preview's `slide` parameter names, as the player's `indexFor` finds it in an
      embedded preview: by id, else by position (`#3`), else the first. */
  function previewed(ref) {
    var all = playerSlides();
    for (var i = 0; i < all.length; i++) {
      if (ref && all[i].id === ref) return all[i];
    }
    var n = parseInt(String(ref || "").replace(/^#/, ""), 10);
    return isNaN(n) ? all[0] : all[Math.min(all.length - 1, Math.max(0, n - 1))];
  }

  /** Shows `slide` alone, at `at` seconds after it shows (null: every animation finished, as the
      page is loaded still for that), and answers `name` once it is ready to capture: where it is
      and, when `overflow`, what overflows on it. */
  function present(slide, all, name, at, overflow) {
    all.forEach(function (el) {
      el.classList.toggle("active", el === slide);
    });
    if (typeof at === "number" && at >= 0) hold(slide, at);
    // The window may be smaller than asked (macOS keeps windows within the screen); have
    // the player fit the slide to it, so all of it is on screen to capture.
    window.dispatchEvent(new Event("resize"));
    var ready = loaded(slide).then(function (backgrounds) {
      fitted(slide);
      return drawn(backgrounds > 0 ? Math.max(PAINT, BACKGROUND_PAINT) : PAINT);
    });
    Promise.race([ready, after(CAP)]).then(function () {
      var r = slide.getBoundingClientRect();
      var answer =
        name +
        "&rect=" + [r.left, r.top, r.width, r.height].join(",") +
        "&view=" + [window.innerWidth, window.innerHeight].join(",");
      if (overflow) {
        var findings = window.__slopOverflow.find(slide).map(window.__slopOverflow.describe);
        answer += "&overflow=" + encodeURIComponent(JSON.stringify(findings.slice(0, MAX_FINDINGS)));
      }
      signal(answer);
    });
  }

  window.__slopRender = {
    /** Reports the slide count. The page has loaded; each slide is waited for as it shows. */
    ready: function () {
      signal("ready&slides=" + slides().length);
    },

    /** Shows the slide `id`, `at` seconds after it shows (null: every animation finished, as
        the page is loaded still for that); answers where it is and what overflows on it. */
    show: function (id, at) {
      var all = slides();
      var slide = all.filter(function (el) {
        return el.id === id;
      })[0];
      var name = "shown=" + encodeURIComponent(id);
      if (!slide) {
        signal(name + "&missing=1");
        return;
      }
      present(slide, all, name, at, true);
    },

    /** Shows the slide an embedded preview's `slide` parameter `ref` names, every animation
        finished, for its thumbnail; answers where it is. A thumbnail's page may hold several
        slides whole (see thumbnails.rs), each shown in turn. */
    preview: function (ref) {
      var slide = previewed(ref);
      var name = "shown=" + encodeURIComponent(ref);
      if (!slide) {
        signal(name + "&missing=1");
        return;
      }
      present(slide, playerSlides(), name, null, false);
    },
  };

  window.__slopRender.ready();
})();
