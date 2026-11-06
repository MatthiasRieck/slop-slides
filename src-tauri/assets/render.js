/* SlopSlide render helper (src-tauri/src/render.rs). The app runs it, after assets/overflow.js,
   in the hidden window that renders slides for the agent; it never becomes part of a deck. Each
   step answers by navigating to /.render-signal?<answer>, which the app catches and cancels. */
(function () {
  // WebView2 also finishes canceled signal navigations; the page-load callback runs us again.
  if (window.__slopRender) return;

  // The most overflow findings a slide reports; an answer travels in a URL.
  var MAX_FINDINGS = 20;

  // Tests answer through __slopRenderSignal; jsdom cannot navigate.
  var signal =
    window.__slopRenderSignal ||
    function (answer) {
      location.assign(location.origin + "/.render-signal?" + answer);
    };

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

  window.__slopRender = {
    /** Waits for fonts and images (a few seconds at most), then reports the slide count. */
    ready: function () {
      var images = Array.prototype.map.call(document.images, function (img) {
        return img.decode ? img.decode().catch(function () {}) : null;
      });
      var fonts = document.fonts ? document.fonts.ready : null;
      // Timers only: a hidden window paints no frames, so requestAnimationFrame never fires.
      var cap = new Promise(function (resolve) {
        setTimeout(resolve, 5000);
      });
      Promise.race([Promise.all(images.concat([fonts])), cap]).then(function () {
        setTimeout(function () {
          signal("ready&slides=" + slides().length);
        }, 100);
      });
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
      all.forEach(function (el) {
        el.classList.toggle("active", el === slide);
      });
      if (typeof at === "number" && at >= 0) hold(slide, at);
      // The window may be smaller than asked (macOS keeps windows within the screen); have
      // the player fit the slide to it, so all of it is on screen to capture.
      window.dispatchEvent(new Event("resize"));
      setTimeout(function () {
        var r = slide.getBoundingClientRect();
        var findings = window.__slopOverflow.find(slide).map(window.__slopOverflow.describe);
        signal(
          name +
            "&rect=" + [r.left, r.top, r.width, r.height].join(",") +
            "&view=" + [window.innerWidth, window.innerHeight].join(",") +
            "&overflow=" + encodeURIComponent(JSON.stringify(findings.slice(0, MAX_FINDINGS))),
        );
      }, 150);
    },
  };

  window.__slopRender.ready();
})();
