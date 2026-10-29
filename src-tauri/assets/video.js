/* SlopSlide video export helper (src-tauri/src/video.rs). The app runs it in the hidden window
   that records a deck; it never becomes part of a deck. Each step answers by navigating to
   /.video-signal?<answer>, which the app catches and cancels.

   The video has its own clock. Every animation the page runs (CSS animations and transitions,
   the player's slide fades, hero morphs) is paused when it first appears and moved to where
   the video's clock says it is, so each frame shows its exact moment however long capturing
   it takes. `busy=0` tells the app that nothing shown will move any more, so the rest of the
   slide's time can repeat the last frame.

   A hidden page skips view transitions, which the player morphs heroes with, so there it
   would only fade. The helper morphs them itself (`morph`), as the player's view transition
   does: each matched hero moves from the other's place, size and pose to its own, while the
   slides cross-fade. */
(function () {
  // Tests answer through __slopVideoSignal; jsdom cannot navigate.
  var signal =
    window.__slopVideoSignal ||
    function (answer) {
      location.assign(location.origin + "/.video-signal?" + answer);
    };

  /** The video's time, in milliseconds. */
  var clock = 0;
  /** Each animation seen, with the video time it started at. */
  var births = new Map();
  /** Animations played to their end. */
  var done = new WeakSet();
  var root = document.documentElement;

  // The player's morph timing (runtime.css): heroes move for 550 ms while the slides
  // cross-fade in 220 ms.
  var MORPH_MS = 550;
  var MORPH_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
  var FADE_MS = 220;

  // Without view transitions the player switches slides at once, and `morph` takes over.
  document.startViewTransition = undefined;
  var style = document.createElement("style");
  style.setAttribute("data-slop-video", "");
  style.textContent =
    "html[data-slop-video-morph] .deck > .slide { transition: opacity " + FADE_MS + "ms ease, visibility 0s linear " +
    FADE_MS + "ms !important; }\n" +
    "html[data-slop-video-morph] .deck > .slide.active { transition: opacity " + FADE_MS + "ms ease !important; }";
  document.head.appendChild(style);

  /** The slides the video shows, in order: those the player shows. */
  function slides() {
    return Array.prototype.slice.call(document.querySelectorAll(".deck > .slide:not([data-hidden])"));
  }

  /** The slide's heroes by name, as the player names them: the first of each valid name. */
  function heroes(slide) {
    var found = Object.create(null);
    var seen = Object.create(null);
    Array.prototype.forEach.call(slide.querySelectorAll("[data-morph]"), function (el) {
      var key = el.getAttribute("data-morph");
      if (/^[a-z][a-z0-9-]*$/.test(key) && !seen[key] && typeof el.offsetWidth === "number") found[key] = el;
      seen[key] = true;
    });
    return found;
  }

  /** The heroes `from` and `to` share, as [old, new] pairs; none where the player would not morph. */
  function matches(from, to) {
    if (root.hasAttribute("data-slop-static") || typeof DOMMatrix !== "function") return [];
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return [];
    var before = heroes(from);
    var after = heroes(to);
    return Object.keys(before)
      .filter(function (key) {
        return after[key];
      })
      .map(function (key) {
        return [before[key], after[key]];
      });
  }

  /** A computed length, resolving percentages against `size`. */
  function px(value, size) {
    if (!value) return "0px";
    return /%$/.test(value) ? (parseFloat(value) * size) / 100 + "px" : value;
  }

  /** `el`'s own transform: its `translate`, `rotate`, `scale` and `transform`, in that order. */
  function ownTransform(el, box) {
    var cs = getComputedStyle(el);
    var list = [];
    var t = cs.translate;
    if (t && t !== "none") {
      var tp = t.split(/\s+/);
      list.push("translate3d(" + px(tp[0], box.width) + "," + px(tp[1], box.height) + "," + (tp[2] || "0px") + ")");
    }
    var r = cs.rotate;
    if (r && r !== "none") {
      var rp = r.split(/\s+/);
      if (rp.length === 1) list.push("rotate(" + rp[0] + ")");
      else if (rp.length === 2) list.push("rotate" + rp[0].toUpperCase() + "(" + rp[1] + ")");
      else list.push("rotate3d(" + rp.slice(0, 3).join(",") + "," + rp[3] + ")");
    }
    var sc = cs.scale;
    if (sc && sc !== "none") {
      var sp = sc.split(/\s+/).map(function (v) {
        return /%$/.test(v) ? parseFloat(v) / 100 : parseFloat(v);
      });
      list.push("scale3d(" + sp[0] + "," + (sp.length > 1 ? sp[1] : sp[0]) + "," + (sp.length > 2 ? sp[2] : 1) + ")");
    }
    if (cs.transform && cs.transform !== "none") list.push(cs.transform);
    return list.length ? new DOMMatrix(list.join(" ")) : new DOMMatrix();
  }

  /** Where `el` is drawn on its slide: its layout box, transform origin, own transform, and
   *  the matrix taking its box to the slide. */
  function placement(el, slide) {
    var box = { x: 0, y: 0, width: el.offsetWidth, height: el.offsetHeight };
    for (var node = el; node && node !== slide; node = node.offsetParent) {
      box.x += node.offsetLeft;
      box.y += node.offsetTop;
    }
    var origin = (getComputedStyle(el).transformOrigin || "").split(/\s+/).map(function (v, i) {
      return parseFloat(px(v, i ? box.height : box.width)) || 0;
    });
    while (origin.length < 3) origin.push(0);
    var own = ownTransform(el, box);
    var matrix = new DOMMatrix()
      .translate(box.x + origin[0], box.y + origin[1], origin[2])
      .multiply(own)
      .translate(-origin[0], -origin[1], -origin[2]);
    return { box: box, origin: origin, own: own, matrix: matrix };
  }

  /** The transform that draws the element placed at `p` exactly over `q`, stretched to its box. */
  function posedAs(p, q) {
    return new DOMMatrix()
      .translate(-p.box.x - p.origin[0], -p.box.y - p.origin[1], -p.origin[2])
      .multiply(q.matrix)
      .scale(q.box.width / (p.box.width || 1), q.box.height / (p.box.height || 1), 1)
      .translate(p.origin[0], p.origin[1], p.origin[2]);
  }

  /** Animates `el`'s transform from `from` to `to` over the morph. */
  function pose(el, from, to) {
    // Its own translate, rotate and scale are in the poses; an !important one would outrank
    // the animation.
    ["transform", "translate", "rotate", "scale"].forEach(function (name) {
      if (el.style.getPropertyPriority(name)) el.style.setProperty(name, el.style.getPropertyValue(name));
    });
    var frame = function (matrix) {
      return { transform: matrix.toString(), translate: "none", rotate: "none", scale: "none" };
    };
    el.animate([frame(from), frame(to)], { duration: MORPH_MS, easing: MORPH_EASING });
  }

  /** Moves on from slide `from` to `to` with the player's → key, morphing their shared heroes. */
  function morph(from, to) {
    var pairs = from && to ? matches(from, to) : [];
    var before = [];
    pairs = pairs.filter(function (pair) {
      try {
        before.push(placement(pair[0], from));
        return true;
      } catch (e) {
        return false;
      }
    });
    if (pairs.length) root.setAttribute("data-slop-video-morph", "");
    else root.removeAttribute("data-slop-video-morph");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    pairs.forEach(function (pair, i) {
      try {
        var a = before[i];
        var b = placement(pair[1], to);
        pose(pair[0], a.own, posedAs(a, b));
        pose(pair[1], posedAs(b, a), b.own);
      } catch (e) {
        // A pose the browser cannot read: that hero only fades.
      }
    });
  }

  /** When `animation` ends, in its own time; Infinity when it repeats forever. */
  function endOf(animation) {
    var effect = animation.effect;
    if (!effect || !effect.getComputedTiming) return 0;
    var end = effect.getComputedTiming().endTime;
    return typeof end === "number" ? end : Number(end) || 0;
  }

  /** Whether `animation` moves something the frame shows (not on a slide hidden behind). */
  function onScreen(animation) {
    var target = animation.effect && animation.effect.target;
    var slide = target && target.closest ? target.closest(".deck > .slide") : null;
    return !slide || getComputedStyle(slide).visibility !== "hidden";
  }

  /** Moves every animation to the clock; answers whether any shown one is still moving. */
  function sync() {
    var busy = false;
    var animations = document.getAnimations ? document.getAnimations() : [];
    animations.forEach(function (animation) {
      if (done.has(animation)) return;
      if (!births.has(animation)) {
        births.set(animation, clock);
        animation.pause();
      }
      var local = clock - births.get(animation);
      var end = endOf(animation);
      if (local >= end) {
        // Finished rather than paused at the end, so whatever waits on it (a morph) ends too.
        done.add(animation);
        animation.finish();
        return;
      }
      animation.currentTime = local;
      if (onScreen(animation)) busy = true;
    });
    return busy;
  }

  /** Where the first slide is, in CSS pixels, as `rect=x,y,w,h&view=w,h`. */
  function geometry() {
    var r = slides()[0].getBoundingClientRect();
    return (
      "rect=" + [r.left, r.top, r.width, r.height].join(",") +
      "&view=" + [window.innerWidth, window.innerHeight].join(",")
    );
  }

  window.__slopVideo = {
    /** Waits for fonts and images (a few seconds at most), then starts the clock at 0. */
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
        // The window may be smaller than asked (macOS keeps windows within the screen); have
        // the player fit the slide to it, so all of it is on screen to capture.
        window.dispatchEvent(new Event("resize"));
        setTimeout(function () {
          var count = slides().length;
          // What played while loading starts over: the video begins with the first entrance.
          clock = 0;
          sync();
          signal("ready&slides=" + count + (count ? "&" + geometry() : ""));
        }, 150);
      });
    },

    /** Moves on to the next slide at video time `at`, as the presenter's → key does. */
    next: function (at) {
      clock = at;
      sync();
      var all = slides();
      var from = all.filter(function (el) {
        return el.classList.contains("active");
      })[0];
      morph(from, from ? all[all.indexOf(from) + 1] : null);
      sync();
      signal("next");
    },

    /** Shows the moment `at` of the video. */
    frame: function (at) {
      clock = at;
      signal("frame&busy=" + (sync() ? 1 : 0));
    },
  };

  window.__slopVideo.ready();
})();
