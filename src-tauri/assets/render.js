/* SlopSlide render helper (src-tauri/src/render.rs). The app runs it, after assets/overflow.js,
   in the hidden window that renders slides for the agent; it never becomes part of a deck. Each
   step answers by navigating to /.render-signal?<answer>, which the app catches and cancels. */
(function () {
  // The most overflow findings a slide reports; an answer travels in a URL.
  var MAX_FINDINGS = 20;

  // Tests answer through __slopRenderSignal; jsdom cannot navigate.
  var signal =
    window.__slopRenderSignal ||
    function (answer) {
      location.assign(location.origin + "/.render-signal?" + answer);
    };

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

    /** Shows the slide `id`; answers where it is and what overflows on it. */
    show: function (id) {
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
