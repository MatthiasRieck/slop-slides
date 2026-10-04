(function () {
  if (/[?&]static\b/.test(location.search)) {
    document.documentElement.setAttribute("data-slop-static", "");
  }
  // Slides run in iframes; forward navigation keys so the host can drive presenting.
  window.addEventListener("keydown", function (event) {
    if (window.parent === window) return;
    window.parent.postMessage({ type: "slop:key", key: event.key }, "*");
  });
})();
