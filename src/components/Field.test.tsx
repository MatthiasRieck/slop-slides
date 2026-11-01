import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CheckboxRow, DraftInput, Field, inputClass, NumberField, selectClass } from "./Field";

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
