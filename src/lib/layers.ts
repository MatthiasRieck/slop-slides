// What is open over the app (menus, popovers, dialogs), as a stack: Escape closes only the one on
// top, and nothing under it sees the key. The slide previews run in frames of their own, so they
// are told while something is open, and hand their Escape over (src-tauri/assets/pasteboard.js).
//
// Escape pressed in a text field is the field's first (it takes the typing back, say): the layer
// gets it once the field and what is around it have seen it, unless they keep it to themselves
// (`stopPropagation`). Pressed anywhere else, the layer gets it before anything does.
import { isTextField } from "./keys";

interface Layer {
  close: () => void;
  /** Under every other layer, whenever it opened: the toasts, which Escape dismisses last. */
  base: boolean;
}

const layers: Layer[] = [];

/** The event the last Escape came with, and whether a layer took it. */
let answered: { event: Event; took: boolean } | null = null;

const top = () => layers.findLast((layer) => !layer.base) ?? layers.at(-1);

/** Whether something is open over the app, not counting what lies under everything (the toasts). */
export function hasOpenLayer(): boolean {
  return layers.some((layer) => !layer.base);
}

/**
 * Closes what is on top; false when nothing is open. Called by whatever gets an Escape that did
 * not come as a key pressed in this window (one a slide preview forwards as `slop:key`), before
 * acting on it. `event` is what the key came with: handlers of the same event get the same
 * answer, and only one layer closes.
 */
export function dismissTopLayer(event?: Event): boolean {
  if (event && answered?.event === event) return answered.took;
  const layer = top();
  if (event) answered = { event, took: layer !== undefined };
  layer?.close();
  return layer !== undefined;
}

/**
 * Puts a layer on the stack while it is open: `close` runs when Escape is pressed with it on top
 * (it need not close: a layer that stays open still keeps the key from what is under it).
 * Returns what takes it off again. A `base` layer stays under all the others.
 */
export function openLayer(close: () => void, options: { base?: boolean } = {}): () => void {
  const layer: Layer = { close, base: options.base ?? false };
  const covered = hasOpenLayer();
  if (layers.length === 0) listen(true);
  layers.push(layer);
  if (!covered && hasOpenLayer()) tellFrames(true);
  return () => {
    const at = layers.indexOf(layer);
    if (at < 0) return;
    layers.splice(at, 1);
    if (layers.length === 0) listen(false);
    if (!layer.base && !hasOpenLayer()) tellFrames(false);
  };
}

/** Escape pressed in this window, on its way down: no further when a layer takes it. */
function onKeyDown(event: KeyboardEvent) {
  // Escape that ends composing a character (an input method's) is not for the app.
  if (event.key !== "Escape" || event.isComposing || isTextField(event.target)) return;
  if (!dismissTopLayer(event)) return;
  event.preventDefault();
  event.stopPropagation();
}

/** Escape pressed in a text field, on its way back up, the field having had its say. */
function onFieldKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing || !isTextField(event.target)) return;
  // What lies under everything (a toast) only takes an Escape the field had no use for.
  if (!hasOpenLayer() && event.defaultPrevented) return;
  if (!dismissTopLayer(event)) return;
  event.preventDefault();
  event.stopPropagation();
}

const isFrame = (source: MessageEventSource | null) =>
  Array.from(document.querySelectorAll("iframe")).some((frame) => frame.contentWindow === source);

/** Escape pressed in a slide preview that was told something is open here. */
function onMessage(event: MessageEvent) {
  if (event.data?.type === "slop:dismiss" && isFrame(event.source)) dismissTopLayer(event);
}

/** A preview that loads while something is open learns of it too. */
function onLoad(event: Event) {
  if (event.target instanceof HTMLIFrameElement && hasOpenLayer()) tell(event.target, true);
}

function listen(on: boolean) {
  const change = on ? "addEventListener" : "removeEventListener";
  document[change]("keydown", onKeyDown as EventListener, true);
  document[change]("keydown", onFieldKeyDown as EventListener);
  window[change]("message", onMessage as EventListener);
  // `load` does not bubble, but it can be caught on its way down.
  document[change]("load", onLoad, true);
}

const tell = (frame: HTMLIFrameElement, open: boolean) =>
  frame.contentWindow?.postMessage({ type: "slop:layer", open }, "*");

function tellFrames(open: boolean) {
  for (const frame of document.querySelectorAll("iframe")) tell(frame, open);
}
