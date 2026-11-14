import { afterEach, describe, expect, it, vi } from "vitest";

import { dismissTopLayer, hasOpenLayer, openLayer } from "./layers";

const closers: (() => void)[] = [];
/** A layer whose `close` is a spy; taken off the stack after the test. */
function layer(options?: { base?: boolean }) {
  const close = vi.fn();
  const remove = openLayer(close, options);
  closers.push(remove);
  return { close, remove };
}

function press(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function frame() {
  const element = document.createElement("iframe");
  document.body.append(element);
  const post = vi.spyOn(element.contentWindow!, "postMessage");
  return { element, post };
}

afterEach(() => {
  for (const remove of closers.splice(0)) remove();
  document.body.innerHTML = "";
});

describe("the stack of what is open", () => {
  it("closes only what is on top, and says whether anything was open", () => {
    expect(dismissTopLayer()).toBe(false);
    const under = layer();
    const over = layer();
    expect(hasOpenLayer()).toBe(true);
    expect(dismissTopLayer()).toBe(true);
    expect([under.close, over.close].map((close) => close.mock.calls.length)).toEqual([0, 1]);
    over.remove();
    expect(dismissTopLayer()).toBe(true);
    expect(under.close).toHaveBeenCalledOnce();
    under.remove();
    expect(hasOpenLayer()).toBe(false);
    expect(dismissTopLayer()).toBe(false);
  });

  it("keeps a base layer under the others, whenever it opened", () => {
    const first = layer();
    const toasts = layer({ base: true });
    expect(dismissTopLayer()).toBe(true);
    expect(toasts.close).not.toHaveBeenCalled();
    first.remove();
    // It does not count as something open over the app, but Escape still reaches it.
    expect(hasOpenLayer()).toBe(false);
    expect(dismissTopLayer()).toBe(true);
    expect(toasts.close).toHaveBeenCalledOnce();
  });

  it("answers every handler of one event the same, closing one layer only", () => {
    const under = layer();
    const over = layer();
    const event = new MessageEvent("message", { data: { type: "slop:key", key: "Escape" } });
    expect(dismissTopLayer(event)).toBe(true);
    over.remove();
    expect(dismissTopLayer(event)).toBe(true);
    expect(under.close).not.toHaveBeenCalled();
    const next = new MessageEvent("message");
    expect(dismissTopLayer(next)).toBe(true);
    expect(under.close).toHaveBeenCalledOnce();
    under.remove();
    const none = new MessageEvent("message");
    expect(dismissTopLayer(none)).toBe(false);
    expect(dismissTopLayer(none)).toBe(false);
  });

  it("takes a layer off once, however often asked", () => {
    const one = layer();
    const two = layer();
    one.remove();
    one.remove();
    expect(hasOpenLayer()).toBe(true);
    two.remove();
    expect(hasOpenLayer()).toBe(false);
  });
});

describe("Escape in the window", () => {
  it("goes to the top layer before anything else sees it, and no further", () => {
    const inner = vi.fn();
    const page = vi.fn();
    const button = document.createElement("button");
    document.body.append(button);
    button.addEventListener("keydown", inner);
    window.addEventListener("keydown", page);
    const { close, remove } = layer();
    const event = press(button);
    expect(close).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(inner).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    // Other keys, and Escape with nothing open, are the page's.
    press(button, { key: "Enter" });
    remove();
    press(button);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(page).toHaveBeenCalledTimes(2);
    window.removeEventListener("keydown", page);
  });

  it("leaves Escape that ends composing a character alone", () => {
    const { close } = layer();
    press(document.body, { isComposing: true });
    expect(close).not.toHaveBeenCalled();
  });

  it("lets a text field have Escape first, then closes the layer and stops the key", () => {
    const order: string[] = [];
    const page = vi.fn();
    const field = document.createElement("input");
    document.body.append(field);
    field.addEventListener("keydown", () => order.push("field"));
    window.addEventListener("keydown", page);
    layer().close.mockImplementation(() => order.push("layer"));
    press(field);
    expect(order).toEqual(["field", "layer"]);
    expect(page).not.toHaveBeenCalled();
    window.removeEventListener("keydown", page);
  });

  it("stays open when the field keeps Escape to itself", () => {
    const field = document.createElement("textarea");
    document.body.append(field);
    field.addEventListener("keydown", (event) => event.stopPropagation());
    const { close } = layer();
    press(field);
    expect(close).not.toHaveBeenCalled();
  });

  it("dismisses what lies under everything only on an Escape the field had no use for", () => {
    const field = document.createElement("input");
    document.body.append(field);
    const used = (event: Event) => event.preventDefault();
    field.addEventListener("keydown", used);
    const toasts = layer({ base: true });
    press(field);
    expect(toasts.close).not.toHaveBeenCalled();
    field.removeEventListener("keydown", used);
    press(field);
    expect(toasts.close).toHaveBeenCalledOnce();
    // A layer over the app closes either way, as its fields' Escape did before.
    field.addEventListener("keydown", used);
    const { close } = layer();
    press(field);
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("the slide previews", () => {
  const told = (post: ReturnType<typeof frame>["post"]) => post.mock.calls.map(([data]) => data);

  it("are told while something is open over the app, not for what lies under everything", () => {
    const { post } = frame();
    const toasts = layer({ base: true });
    expect(told(post)).toEqual([]);
    const one = layer();
    const two = layer();
    expect(told(post)).toEqual([{ type: "slop:layer", open: true }]);
    one.remove();
    expect(told(post)).toHaveLength(1);
    two.remove();
    expect(told(post)).toEqual([
      { type: "slop:layer", open: true },
      { type: "slop:layer", open: false },
    ]);
    toasts.remove();
    expect(told(post)).toHaveLength(2);
  });

  it("learn of it when they load with something open", () => {
    layer();
    const { element, post } = frame();
    element.dispatchEvent(new Event("load"));
    expect(told(post)).toEqual([{ type: "slop:layer", open: true }]);
  });

  it("hand over their Escape, which closes the top layer; other windows are not heard", () => {
    const { element } = frame();
    const { close } = layer();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:dismiss" }, source: null }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:key" }, source: element.contentWindow }));
    expect(close).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "slop:dismiss" }, source: element.contentWindow }),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
