/* App-only image actions. Sandboxed webview context menus cannot save custom-protocol files. */
(function () {
  if (window.parent === window) return;
  document.addEventListener("contextmenu", function (event) {
    var image = event.target.closest && event.target.closest("img");
    if (!image || !(image.currentSrc || image.src)) return;
    event.preventDefault();
    event.stopPropagation();
    window.parent.postMessage({ type: "slop:image-menu", src: image.currentSrc || image.src, x: event.clientX, y: event.clientY }, "*");
  }, true);
})();
