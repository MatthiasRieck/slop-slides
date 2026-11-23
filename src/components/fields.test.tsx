import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Input } from "@/components/ui/input";

import { CheckField, LabeledField, NumberField } from "./fields";
import { QUIET_LABEL } from "./styles";

describe("LabeledField", () => {
  it("names the control it holds with its quiet label", () => {
    render(<LabeledField label="Fill">{(id) => <Input id={id} size="sm" defaultValue="none" />}</LabeledField>);
    const field = screen.getByLabelText("Fill") as HTMLInputElement;
    expect(field.value).toBe("none");
    const label = screen.getByText("Fill");
    for (const name of QUIET_LABEL.split(" ")) expect(label.classList.contains(name)).toBe(true);
    expect(field.closest("[data-slot=field]")?.hasAttribute("data-invalid")).toBe(false);
  });

  it("marks what it holds as not usable when told so", () => {
    render(
      <LabeledField label="Fill" invalid className="w-20">
        {(id) => <Input id={id} />}
      </LabeledField>,
    );
    const box = screen.getByLabelText("Fill").closest("[data-slot=field]")!;
    expect(box.getAttribute("data-invalid")).toBe("true");
    expect(box.classList.contains("w-20")).toBe(true);
  });
});

describe("NumberField", () => {
  it("is a number to type under its label, handing over the text as typed", () => {
    const onChange = vi.fn();
    render(<NumberField label="Seconds per slide" min={1} max={600} value="5" onChange={onChange} />);
    const field = screen.getByRole("spinbutton", { name: "Seconds per slide" }) as HTMLInputElement;
    expect(field.value).toBe("5");
    expect([field.min, field.max, field.step]).toEqual(["1", "600", "any"]);
    expect(field.hasAttribute("aria-invalid")).toBe(false);
    fireEvent.change(field, { target: { value: "7.5" } });
    expect(onChange).toHaveBeenCalledWith("7.5");
  });

  it("takes a name that says more than its label, and says when what it holds cannot be used", () => {
    render(
      <NumberField label="Before" aria-label="Pause before the narration" value="-1" invalid onChange={() => {}} />,
    );
    const field = screen.getByRole("spinbutton", { name: "Pause before the narration" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.closest("[data-slot=field]")?.getAttribute("data-invalid")).toBe("true");
    expect(screen.getByText("Before")).toBeTruthy();
  });
});

describe("CheckField", () => {
  it("is a checkbox named by its title, with a line saying what it does", () => {
    const onChange = vi.fn();
    render(
      <CheckField title="Play animations" description="Each slide plays as in a show" checked onChange={onChange} />,
    );
    const box = screen.getByRole("checkbox", { name: "Play animations" });
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Each slide plays as in a show")).toBeTruthy();
    fireEvent.click(box);
    expect(onChange.mock.calls[0]?.[0]).toBe(false);
    // The title is the checkbox's label: a press on it checks too.
    fireEvent.click(screen.getByText("Play animations"));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
