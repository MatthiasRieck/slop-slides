import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Switch } from "./Switch";

describe("Switch", () => {
  it("is a switch that says whether it is on", () => {
    const view = render(<Switch checked label="Codex" onChange={() => {}} />);
    const control = screen.getByRole("switch", { name: "Codex" });
    expect(control.getAttribute("aria-checked")).toBe("true");
    view.rerender(<Switch checked={false} label="Codex" onChange={() => {}} />);
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("asks for the other state on a click, on Space and on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Switch checked={false} label="Codex" onChange={onChange} />);
    await user.click(screen.getByRole("switch"));
    await user.tab();
    await user.tab({ shift: true });
    screen.getByRole("switch").focus();
    await user.keyboard(" ");
    await user.keyboard("{Enter}");
    expect(onChange.mock.calls).toEqual([[true], [true], [true]]);
  });

  it("cannot be flipped while disabled", async () => {
    const onChange = vi.fn();
    render(<Switch checked label="Codex" disabled onChange={onChange} />);
    const control = screen.getByRole("switch") as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    await userEvent.setup().click(control);
    expect(onChange).not.toHaveBeenCalled();
  });
});
