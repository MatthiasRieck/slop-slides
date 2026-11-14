import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CheckboxRow, DraftInput, Field, inputClass, NumberBox, NumberField, selectClass } from "./Field";

const digits = (text: string) => text.replace(/[^\d]/g, "");
const parse = (text: string) => (text === "" ? null : Number(text));

function draft(value: number | null = 12) {
  const onChange = vi.fn();
  const onDone = vi.fn();
  const view = render(
    <DraftInput
      aria-label="Size"
      title="Size to type"
      className="w-9"
      value={value}
      parse={parse}
      sanitize={digits}
      onChange={onChange}
      onDone={onDone}
    />,
  );
  const input = screen.getByLabelText("Size") as HTMLInputElement;
  const rerender = (next: number | null) =>
    view.rerender(
      <DraftInput
        aria-label="Size"
        title="Size to type"
        className="w-9"
        value={next}
        parse={parse}
        sanitize={digits}
        onChange={onChange}
        onDone={onDone}
      />,
    );
  return { input, onChange, onDone, rerender };
}

describe("DraftInput", () => {
  it("shows the value, forwards attributes and shows a dash for no value", () => {
    const { input, rerender } = draft();
    expect(input.value).toBe("12");
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("numeric");
    expect(input.title).toBe("Size to type");
    expect(input.className).toBe("w-9");
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
});

describe("Field", () => {
  it("names its control with the label and lays out as asked", () => {
    render(
      <Field label="Unit" className="flex flex-col gap-1">
        <select className={selectClass}>
          <option>px</option>
        </select>
      </Field>,
    );
    const select = screen.getByLabelText("Unit");
    expect(select.tagName).toBe("SELECT");
    expect(select.className).toBe("h-7 rounded-md border bg-background px-1.5");
    expect(select.parentElement?.className).toBe("flex flex-col gap-1");
  });

  it("fills its share of a row by default", () => {
    render(
      <Field label="Name">
        <input />
      </Field>,
    );
    expect(screen.getByLabelText("Name").parentElement?.className).toBe("flex min-w-0 flex-1 flex-col gap-1");
    expect(screen.getByText("Name").className).toBe("text-muted-foreground");
  });
});

describe("NumberField", () => {
  it("forwards its attributes and reports the text typed", () => {
    const onChange = vi.fn();
    render(<NumberField label="Pause (s)" aria-label="Pause" min={0} max={10} value="2" onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: "Pause" }) as HTMLInputElement;
    expect(screen.getByText("Pause (s)")).toBeTruthy();
    expect(input.value).toBe("2");
    expect(input.min).toBe("0");
    expect(input.max).toBe("10");
    expect(input.step).toBe("any");
    expect(input.inputMode).toBe("decimal");
    expect(input.className).toBe(inputClass);
    fireEvent.change(input, { target: { value: "3.5" } });
    expect(onChange).toHaveBeenCalledWith("3.5");
  });

  it("leaves out bounds it is not given", () => {
    render(<NumberField label="Width" aria-label="Width" value="" onChange={() => {}} />);
    const input = screen.getByRole("spinbutton", { name: "Width" });
    expect(input.hasAttribute("min")).toBe(false);
    expect(input.hasAttribute("max")).toBe(false);
  });
});

describe("CheckboxRow", () => {
  it("names the checkbox with its title and description and reports changes", () => {
    const onChange = vi.fn();
    render(<CheckboxRow title="Play animations" description="As when presenting." checked onChange={onChange} />);
    const box = screen.getByRole("checkbox", { name: /Play animations/ }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByText("As when presenting.").className).toBe("text-2xs text-muted-foreground");
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});

describe("DraftInput stepping", () => {
  it("steps by one with the arrows and by ten with Shift, applying at once and keeping the focus", () => {
    const { input, onChange, onDone } = draft(12);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(13);
    expect(input.value).toBe("13");
    fireEvent.keyDown(input, { key: "ArrowDown", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(3);
    expect(input.value).toBe("3");
    // The focus stays for the next step.
    expect(onDone).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
  });

  it("steps from what is typed, and from the value when that is no number", () => {
    const { input, onChange } = draft(12);
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(41);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "ArrowUp", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(22);
  });

  it("does not step a field without a value, or with a modifier held", () => {
    const empty = draft(null);
    fireEvent.keyDown(empty.input, { key: "ArrowUp" });
    expect(empty.onChange).not.toHaveBeenCalled();
    empty.rerender(5);
    fireEvent.keyDown(empty.input, { key: "ArrowUp", ctrlKey: true });
    fireEvent.keyDown(empty.input, { key: "ArrowUp", altKey: true });
    expect(empty.onChange).not.toHaveBeenCalled();
  });

  it("keeps a step within what the field takes", () => {
    const onChange = vi.fn();
    render(
      <DraftInput
        aria-label="Width"
        value={1}
        parse={(text) => (Number(text) >= 1 ? Number(text) : null)}
        sanitize={(text) => text}
        onChange={onChange}
        onDone={() => {}}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("Width"), { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Width") as HTMLInputElement).value).toBe("1");
  });
});

describe("NumberBox", () => {
  const box = (more: Partial<Parameters<typeof NumberBox>[0]> = {}) => {
    const onChange = vi.fn();
    const onDone = vi.fn();
    render(
      <NumberBox
        label="Line height"
        value={1.2}
        min={0.5}
        max={5}
        decimals={2}
        stepBy={0.05}
        presets={[{ value: null, label: "Deck default" }, { value: 1.5 }]}
        onChange={onChange}
        onDone={onDone}
        {...more}
      />,
    );
    return { onChange, onDone, field: screen.getByLabelText("Line height") as HTMLInputElement };
  };

  it("takes any value in its range, and steps by its own step", () => {
    const { onChange, field } = box();
    fireEvent.change(field, { target: { value: "1.33" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(1.33);
    fireEvent.change(field, { target: { value: "9" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(1.25);
  });

  it("offers its usual values, the deck's own among them, and hands the focus back on a pick", () => {
    const { onChange, onDone } = box();
    fireEvent.click(screen.getByRole("button", { name: "Line height: usual values" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Deck default", "1.5"]);
    fireEvent.click(screen.getByRole("option", { name: "Deck default" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(onDone).toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows a dash for no value, and says why it is disabled", () => {
    box({ value: null, disabled: true, disabledReason: "Select text" });
    expect((screen.getByLabelText("Line height") as HTMLInputElement).value).toBe("");
    expect(screen.getByTitle("Select text")).toBeTruthy();
  });
});
