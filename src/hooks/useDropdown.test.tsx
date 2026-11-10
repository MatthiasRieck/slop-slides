import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useDropdown } from "./useDropdown";

function Dropdown(props: { disabled?: boolean; escape?: boolean; capture?: boolean; onClose?: () => void }) {
  const { open, ref, toggle } = useDropdown(props);
  return (
    <div>
      <div ref={ref}>
        <button type="button" onClick={toggle}>
          Menu
        </button>
        {open && <div role="menu">panel</div>}
      </div>
      <button type="button">Outside</button>
    </div>
  );
}

const menu = () => screen.queryByRole("menu");

describe("useDropdown", () => {
  it("toggles, and closes on a press outside, after onClose", () => {
    const onClose = vi.fn();
    render(<Dropdown onClose={onClose} />);
    fireEvent.click(screen.getByText("Menu"));
    expect(menu()).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("panel"));
    expect(menu()).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(menu()).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Menu"));
    fireEvent.click(screen.getByText("Menu"));
    expect(menu()).toBeNull();
  });

  it("closes on Escape only when asked to", () => {
    const { rerender } = render(<Dropdown />);
    fireEvent.click(screen.getByText("Menu"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(menu()).toBeTruthy();
    rerender(<Dropdown escape />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(menu()).toBeNull();
  });

  it("with capture, takes Escape before the page does, and keeps it from going further", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    render(<Dropdown escape capture />);
    fireEvent.click(screen.getByText("Menu"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(menu()).toBeNull();
    expect(page).not.toHaveBeenCalled();
    window.removeEventListener("keydown", page);
  });

  it("stays closed while disabled", () => {
    const { rerender } = render(<Dropdown />);
    fireEvent.click(screen.getByText("Menu"));
    expect(menu()).toBeTruthy();
    act(() => rerender(<Dropdown disabled />));
    expect(menu()).toBeNull();
    fireEvent.click(screen.getByText("Menu"));
    expect(menu()).toBeNull();
  });
});
