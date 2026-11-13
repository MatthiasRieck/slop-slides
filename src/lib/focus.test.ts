import { afterEach, describe, expect, it } from "vitest";

import { focusableIn, focusTarget, restoreFocus, usingKeyboard, wrapTab } from "./focus";

function box(html: string): HTMLElement {
  const root = document.createElement("div");
  root.tabIndex = -1;
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusableIn", () => {
  it("lists what Tab stops at, in order, without what is disabled, hidden or out of the tab order", () => {
    const root = box(`
      <a href="#x" id="link">Link</a>
      <a id="anchor">No link</a>
      <button id="go">Go</button>
      <button disabled id="off">Off</button>
      <input id="field">
      <input type="hidden" id="secret">
      <div tabindex="0" id="custom"></div>
      <div tabindex="-1" id="scripted"></div>
      <div hidden><button id="hidden">Hidden</button></div>
      <div inert><button id="inert">Inert</button></div>
      <textarea id="text"></textarea>
      <select id="pick"></select>
    `);
    expect(focusableIn(root).map((element) => element.id)).toEqual(["link", "go", "field", "custom", "text", "pick"]);
  });
});

describe("focusTarget", () => {
  it("prefers the element asked for, then what the markup marks, then nothing", () => {
    const root = box(`<button id="a">A</button><input id="b" data-autofocus><input id="c" autofocus>`);
    const a = root.querySelector<HTMLElement>("#a")!;
    expect(focusTarget(root, { current: a })).toBe(a);
    expect(focusTarget(root)?.id).toBe("b");
    expect(focusTarget(root, { current: null })?.id).toBe("b");
    expect(focusTarget(box("<button>A</button>"))).toBeUndefined();
  });
});

describe("wrapTab", () => {
  const tab = { key: "Tab", shiftKey: false };
  const back = { key: "Tab", shiftKey: true };

  it("goes round from the last stop to the first, and back", () => {
    const root = box(`<button id="a">A</button><button id="b">B</button><button id="c">C</button>`);
    const [a, b, c] = Array.from(root.querySelectorAll("button"));
    c!.focus();
    expect(wrapTab(root, tab)).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(wrapTab(root, back)).toBe(true);
    expect(document.activeElement).toBe(c);
    b!.focus();
    // In between, the browser moves the focus.
    expect(wrapTab(root, tab)).toBe(false);
    expect(wrapTab(root, back)).toBe(false);
    expect(document.activeElement).toBe(b);
  });

  it("brings the focus in from the box itself or from outside", () => {
    const root = box(`<button id="a">A</button><button id="b">B</button>`);
    root.focus();
    expect(wrapTab(root, tab)).toBe(true);
    expect(document.activeElement?.id).toBe("a");
    (document.activeElement as HTMLElement).blur();
    expect(wrapTab(root, back)).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("keeps the focus on a box with nothing to stop at, and leaves other keys alone", () => {
    const root = box("<p>Text</p>");
    expect(wrapTab(root, tab)).toBe(true);
    expect(document.activeElement).toBe(root);
    expect(wrapTab(root, { key: "Enter", shiftKey: false })).toBe(false);
  });
});

describe("usingKeyboard", () => {
  const key = (name: string) => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));

  it("is true after a key and false after a press, wherever the press was", () => {
    key("Enter");
    expect(usingKeyboard()).toBe(true);
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(usingKeyboard()).toBe(false);
    key("Tab");
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(usingKeyboard()).toBe(false);
    key("ArrowDown");
    // A press in a slide preview, which reports it.
    window.dispatchEvent(new MessageEvent("message", { data: { type: "slop:press" } }));
    expect(usingKeyboard()).toBe(false);
  });

  it("does not take a held modifier for a key", () => {
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    for (const held of ["Shift", "Meta", "Control", "Alt"]) key(held);
    expect(usingKeyboard()).toBe(false);
  });
});

describe("restoreFocus", () => {
  it("gives the focus back when it is in what goes away, or nowhere", () => {
    const root = box(`<button id="in">In</button>`);
    const before = document.createElement("button");
    document.body.append(before);
    root.querySelector<HTMLElement>("#in")!.focus();
    restoreFocus(root, before);
    expect(document.activeElement).toBe(before);
    before.blur();
    restoreFocus(null, before);
    expect(document.activeElement).toBe(before);
  });

  it("leaves the focus where it went meanwhile, and gives it to nothing that is gone", () => {
    const root = box(`<button id="in">In</button>`);
    const before = document.createElement("button");
    const other = document.createElement("button");
    document.body.append(before, other);
    other.focus();
    restoreFocus(root, before);
    expect(document.activeElement).toBe(other);
    root.querySelector<HTMLElement>("#in")!.focus();
    before.remove();
    restoreFocus(root, before);
    expect(document.activeElement?.id).toBe("in");
    restoreFocus(root, null);
    restoreFocus(root, document.body);
    expect(document.activeElement?.id).toBe("in");
  });
});
