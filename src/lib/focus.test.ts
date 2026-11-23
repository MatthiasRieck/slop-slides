import { describe, expect, it } from "vitest";

import { keepFocus, quietFocus } from "./focus";

describe("keepFocus", () => {
  it("keeps a press from moving the focus", () => {
    const event = new MouseEvent("mousedown", { cancelable: true });
    keepFocus(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("quietFocus", () => {
  it("keeps a field's focus from what is around it, such as the tooltip it is in", () => {
    const around = document.createElement("div");
    const field = around.appendChild(document.createElement("input"));
    document.body.append(around);
    let heard = 0;
    around.addEventListener("focusin", () => heard++);
    field.addEventListener("focusin", quietFocus);
    field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(heard).toBe(0);
    field.removeEventListener("focusin", quietFocus);
    field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(heard).toBe(1);
    around.remove();
  });
});
