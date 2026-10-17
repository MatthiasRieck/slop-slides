/* SlopSlide PDF export helper (src-tauri/src/pdf.rs). The app runs it in the hidden window that
   prints a deck; it never becomes part of a deck. Each step answers by navigating to
   /.pdf-signal?<answer>, which the app catches and cancels.

   Where the engine cannot print transparency (macOS), each slide's look is captured as an
   image with its text hidden (`decor`, `show`), then printed as that image with only the
   text on top (`paint`, `text`): the text stays real and selectable. */
(function () {
  var root = document.documentElement;

  // Tests answer through __slopPdfSignal; jsdom cannot navigate.
  var signal =
    window.__slopPdfSignal ||
    function (answer) {
      location.assign(location.origin + "/.pdf-signal?" + answer);
    };

  /** The slides the PDF holds, in order: those the print stylesheet shows. */
  function slides() {
    return Array.prototype.slice.call(document.querySelectorAll(".deck > .slide:not([data-hidden])"));
  }

  var css = [
    /* Decor: everything but the text. `-webkit-text-fill-color` hides glyphs and leaves
       `color`, so borders and icons drawn in currentColor stay. */
    'html[data-slop-pdf="decor"] *, html[data-slop-pdf="decor"] *::before, html[data-slop-pdf="decor"] *::after {',
    "  -webkit-text-fill-color: transparent !important;",
    "  -webkit-text-stroke-color: transparent !important;",
    "  text-shadow: none !important;",
    "  text-decoration-color: transparent !important;",
    "  text-emphasis-color: transparent !important;",
    "  caret-color: transparent !important;",
    "}",
    'html[data-slop-pdf="decor"] ::marker { color: transparent !important; }',
    /* Text filled with its background shows nothing of that background in the decor. */
    'html[data-slop-pdf="decor"] [data-slop-pdf-cliptext] { background: none !important; }',
    /* Text: only the text, over each slide's decor image. Nothing here changes layout. */
    'html[data-slop-pdf="text"] *:not([data-slop-pdf-cliptext]), html[data-slop-pdf="text"] *::before, html[data-slop-pdf="text"] *::after {',
    "  background-color: transparent !important;",
    "  background-image: none !important;",
    "}",
    'html[data-slop-pdf="text"] *, html[data-slop-pdf="text"] *::before, html[data-slop-pdf="text"] *::after {',
    "  border-color: transparent !important;",
    "  border-image: none !important;",
    "  outline-color: transparent !important;",
    "  box-shadow: none !important;",
    "  backdrop-filter: none !important;",
    "  -webkit-backdrop-filter: none !important;",
    "  -webkit-mask: none !important;",
    "  mask: none !important;",
    "}",
    'html[data-slop-pdf="text"] :is(img, svg, video, canvas, iframe, object, embed, picture) {',
    "  visibility: hidden !important;",
    "}",
  ].join("\n");

  var decorImages = [];

  window.__slopPdf = {
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

    /** Hides the text, to capture each slide's decor. */
    decor: function () {
      var style = document.createElement("style");
      style.setAttribute("data-slop-pdf", "");
      style.textContent = css;
      document.head.appendChild(style);
      Array.prototype.forEach.call(document.querySelectorAll("*"), function (el) {
        var clip = getComputedStyle(el).webkitBackgroundClip || getComputedStyle(el).backgroundClip || "";
        if (clip.indexOf("text") >= 0) el.setAttribute("data-slop-pdf-cliptext", "");
      });
      root.setAttribute("data-slop-pdf", "decor");
      signal("decor");
    },

    /** Shows slide `index` alone and reports where it is, in CSS pixels. */
    show: function (index) {
      var all = slides();
      all.forEach(function (el, i) {
        el.classList.toggle("active", i === index);
      });
      // The window may be smaller than asked (macOS keeps windows within the screen); have
      // the player fit the slide to it, so all of it is on screen to capture.
      window.dispatchEvent(new Event("resize"));
      setTimeout(function () {
        var r = all[index].getBoundingClientRect();
        signal(
          "shown=" + index +
            "&rect=" + [r.left, r.top, r.width, r.height].join(",") +
            "&view=" + [window.innerWidth, window.innerHeight].join(","),
        );
      }, 150);
    },

    /** Keeps `url`, an image of slide `index`'s decor, for the printed page. */
    paint: function (index, url) {
      decorImages[index] = url;
    },

    /** Puts each slide's decor image behind its text, and leaves only the text to print. */
    text: function () {
      var loads = slides().map(function (el, i) {
        var url = decorImages[i];
        if (!url) return null;
        el.style.setProperty("background", 'url("' + url + '") 0 0 / 100% 100% no-repeat', "important");
        var img = new Image();
        img.src = url;
        return img.decode ? img.decode().catch(function () {}) : null;
      });
      root.setAttribute("data-slop-pdf", "text");
      Promise.all(loads).then(function () {
        setTimeout(function () {
          signal("text");
        }, 100);
      });
    },
  };

  window.__slopPdf.ready();
})();
