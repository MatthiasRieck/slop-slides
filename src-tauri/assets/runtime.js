/* SlopSlide player. Keys: ←/→, space, PageUp/PageDown, Home/End, F for full screen. */
(function () {
  var root = document.documentElement;
  var params = new URLSearchParams(location.search);
  var embed = params.has("embed");
  var framed = window.parent !== window;
  if (params.has("static")) root.setAttribute("data-slop-static", "");

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

  function fit() {
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    var x = (window.innerWidth - 1920 * scale) / 2;
    var y = (window.innerHeight - 1080 * scale) / 2;
    deck.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
  }

  function indexFor(ref) {
    if (!ref) return 0;
    // A hidden slide's id lands on the next shown slide (or the last one).
    for (var i = 0; i < all.length; i++) {
      if (all[i].id !== ref) continue;
      for (var j = i; j < all.length; j++) {
        var index = slides.indexOf(all[j]);
        if (index >= 0) return index;
      }
      return slides.length - 1;
    }
    var n = parseInt(ref, 10);
    return isNaN(n) ? 0 : Math.min(slides.length - 1, Math.max(0, n - 1));
  }

  function show(index) {
    index = Math.min(slides.length - 1, Math.max(0, index));
    if (index === current) return;
    current = index;
    slides.forEach(function (el, i) {
      el.classList.toggle("active", i === index);
    });
    if (embed) return;
    var id = slides[index].id || String(index + 1);
    try {
      history.replaceState(null, "", "#" + id);
    } catch (e) {
      // Sandboxed frames and some file:// contexts refuse URL updates; navigation still works.
    }
    if (framed) window.parent.postMessage({ type: "slop:slide", id: slides[index].id || null }, "*");
  }

  window.addEventListener("resize", fit);
  fit();
  show(indexFor(embed ? params.get("slide") : decodeURIComponent(location.hash.slice(1))));

  window.addEventListener("keydown", function (event) {
    if (framed) window.parent.postMessage({ type: "slop:key", key: event.key }, "*");
    if (embed) return;
    var key = event.key;
    if (key === "ArrowRight" || key === "ArrowDown" || key === "PageDown" || key === " ") show(current + 1);
    else if (key === "ArrowLeft" || key === "ArrowUp" || key === "PageUp") show(current - 1);
    else if (key === "Home") show(0);
    else if (key === "End") show(slides.length - 1);
    else if ((key === "f" || key === "F") && !framed) {
      if (document.fullscreenElement) document.exitFullscreen();
      else root.requestFullscreen && root.requestFullscreen();
    } else return;
    event.preventDefault();
  });

  if (embed) return;
  window.addEventListener("hashchange", function () {
    show(indexFor(decodeURIComponent(location.hash.slice(1))));
  });
  document.addEventListener("click", function (event) {
    if (event.target.closest("a, button, input, select, textarea, video, [contenteditable]")) return;
    show(event.clientX < window.innerWidth / 4 ? current - 1 : current + 1);
  });
  var touchX = null;
  document.addEventListener("touchstart", function (event) {
    touchX = event.touches[0].clientX;
  });
  document.addEventListener("touchend", function (event) {
    if (touchX === null) return;
    var dx = event.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 40) show(current + (dx < 0 ? 1 : -1));
    touchX = null;
  });
})();
