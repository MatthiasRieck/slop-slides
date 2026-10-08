import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import SCRIPT from "../../src-tauri/assets/image-menu.js?raw";

it("replaces the broken image menu with an app request, leaving other context menus alone", () => {
  const dom = new JSDOM('<img src="assets/photo.png"><p>Text</p>', { url: "https://deck.test/talk/deck.html", runScripts: "outside-only" });
  try {
    const postMessage = vi.fn();
    Object.defineProperty(dom.window, "parent", { value: { postMessage } });
    dom.window.eval(SCRIPT);
    const image = dom.window.document.querySelector("img")!;
    Object.defineProperty(image, "currentSrc", { value: "https://deck.test/talk/assets/large.png" });
    const event = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    image.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: "slop:image-menu", src: image.currentSrc, x: 0, y: 0 }, "*");
    const other = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    dom.window.document.querySelector("p")!.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
  } finally { dom.window.close(); }
});

it("leaves exported standalone presentations alone", () => {
  const dom = new JSDOM('<img src="photo.png">', { runScripts: "outside-only" });
  try {
    dom.window.eval(SCRIPT);
    const event = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    dom.window.document.querySelector("img")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  } finally { dom.window.close(); }
});
