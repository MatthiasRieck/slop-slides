import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { tooltipOf } from "../test/ui";
import { DraftInput } from "./DraftInput";

const digits = (text: string) => text.replace(/[^\d]/g, "");
const parse = (text: string) => (text === "" ? null : Number(text));

function draft(value: number | null = 12, more: Partial<Parameters<typeof DraftInput>[0]> = {}) {
  const onChange = vi.fn();
  const onDone = vi.fn();
  const field = (shown: number | null) => (
    <DraftInput
      aria-label="Size"
      className="w-9"
      value={shown}
      parse={parse}
      sanitize={digits}
      onChange={onChange}
      onDone={onDone}
      {...more}
    />
  );
  const view = render(field(value));
  const input = screen.getByLabelText("Size") as HTMLInputElement;
  return { input, onChange, onDone, rerender: (next: number | null) => view.rerender(field(next)) };
}

describe("DraftInput", () => {
  it("is a shadcn/ui input, compact, that shows the value and a dash for none", () => {
    const { input, rerender } = draft();
    expect(input.dataset.slot).toBe("input");
    expect(input.value).toBe("12");
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("numeric");
    // Its width is the caller's; its height the ribbon's, unless the caller sets another.
    expect(input.className.split(" ")).toEqual(expect.arrayContaining(["w-9", "h-6", "text-xs", "tabular-nums"]));
    expect(input.className.split(" ")).not.toContain("w-full");
    rerender(null);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("–");
  });

  it("sanitizes keystrokes", () => {
    const { input, onChange } = draft();
    fireEvent.change(input, { target: { value: "3a4px" } });
    expect(input.value).toBe("34");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies on blur", () => {
    const { input, onChange, onDone } = draft();
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(20);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("applies on Enter and hands focus back", () => {
    const { input, onChange, onDone } = draft();
    fireEvent.change(input, { target: { value: "24" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(24);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("puts the value back on Escape and hands focus back", () => {
    const { input, onChange, onDone } = draft();
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("12");
    expect(onChange).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("steps with the arrows, by ten with Shift, applying each step and keeping the focus", () => {
    const { input, onChange, onDone } = draft();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(13);
    expect(input.value).toBe("13");
    fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(3);
    // With a modifier the arrows are not the field's.
    onChange.mockClear();
    fireEvent.keyDown(input, { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(input, { key: "ArrowUp", ctrlKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("does not apply an unchanged or unparsable value, and shows the value again", () => {
    const { input, onChange } = draft();
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("12");
  });

  it("follows a value changed from outside", () => {
    const { input, rerender } = draft();
    fireEvent.change(input, { target: { value: "5" } });
    rerender(40);
    expect(input.value).toBe("40");
  });

  it("has no tooltip unless given one", () => {
    const { input } = draft();
    expect(tooltipOf(input)).toBeNull();
    expect(input.parentElement?.dataset.slot).toBeUndefined();
  });

  it("says what it is for under the pointer, also while it is off, and not for as long as it is typed in", () => {
    const { input } = draft(null, { tooltip: "Size to type", disabled: true });
    expect(input.disabled).toBe(true);
    // The box around the field shows the tooltip: a disabled field takes no pointer.
    const box = input.parentElement!;
    expect(box.dataset.slot).toBe("tooltip-trigger");
    expect(tooltipOf(box)).toBe("Size to type");
    // The field taking the focus opens none.
    fireEvent.focus(input);
    expect(document.querySelector("[data-slot=tooltip-content]")).toBeNull();
  });

  it("still tells a caller of its focus", () => {
    const onFocus = vi.fn();
    const { input } = draft(12, { tooltip: "Size to type", onFocus });
    fireEvent.focus(input);
    expect(onFocus).toHaveBeenCalledOnce();
  });
});
