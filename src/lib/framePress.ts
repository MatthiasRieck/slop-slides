// A press in a slide preview never reaches this window: the preview runs in a frame of its own,
// and only reports the press, as `slop:press` (src-tauri/assets/pasteboard.js). The shadcn/ui
// popups (Base UI) close on a press outside them that they see in this document, so the report is
// turned into one, on the frame it came from. A popup that is modal (a dialog, a menu, a select)
// covers the previews and gets the press itself; this is for the ones that are not (a popover, a
// combobox, a menu with `modal={false}`).

const frameOf = (source: MessageEventSource | null) =>
  Array.from(document.querySelectorAll("iframe")).find((frame) => frame.contentWindow === source);

/**
 * A press on `target` as the popups see one: `pointerdown` for those that close as a press starts,
 * and a `click` for those that wait for it to end. Neither bubbles: what listens for presses on
 * their way down (Base UI, and the app's own watch on where the pointer went) sees them, and no
 * `onClick` or `onPointerDown` of what is around `target` takes them for a press of its own.
 */
export function pressOn(target: Element): void {
  const init = { bubbles: false, cancelable: true, button: 0 };
  const Pointer = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  target.dispatchEvent(new Pointer("pointerdown", { ...init, pointerType: "mouse" } as MouseEventInit));
  // No click count: Base UI takes such a click as a press in its own right, whenever it comes.
  target.dispatchEvent(new MouseEvent("click", { ...init, detail: 0 }));
}

/** Lets a press in a slide preview close the popups open in this window. Returns what stops it. */
export function followFramePresses(): () => void {
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type !== "slop:press") return;
    const frame = frameOf(event.source);
    if (frame) pressOn(frame);
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
