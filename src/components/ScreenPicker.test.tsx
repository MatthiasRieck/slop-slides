import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Screen } from "../lib/api";
import { ScreenPicker } from "./ScreenPicker";

const screens: Screen[] = [
  {
    index: 0,
    name: "Built-in",
    x: 0,
    y: 0,
    width: 1512,
    height: 982,
    pixelWidth: 3024,
    pixelHeight: 1964,
    primary: true,
  },
  {
    index: 1,
    name: "Projector",
    x: 1512,
    y: 0,
    width: 1920,
    height: 1080,
    pixelWidth: 1920,
    pixelHeight: 1080,
    primary: false,
  },
];

describe("ScreenPicker", () => {
  it("shows every screen and starts with the show on the last one", () => {
    const onStart = vi.fn();
    render(<ScreenPicker screens={screens} onStart={onStart} onCancel={() => {}} />);
    expect(screen.getByTestId("screen-0").dataset.role).toBe("presenter");
    expect(screen.getByTestId("screen-1").dataset.role).toBe("audience");
    expect(screen.getByText("Screen 1")).toBeTruthy();
    expect(screen.getByText("Screen 2")).toBeTruthy();
    expect(screen.getByText("Audience · slides")).toBeTruthy();
    expect(screen.getByText("Presenter · notes")).toBeTruthy();
    expect(screen.getByText("1920×1080")).toBeTruthy();
    expect(screen.getByText("3024×1964 · main")).toBeTruthy();
    fireEvent.click(screen.getByText("Start presenting"));
    expect(onStart).toHaveBeenCalledWith({ audience: 1, presenter: 0 });
  });

  it("swaps the roles when the show is put on the presenter's screen", () => {
    const onStart = vi.fn();
    render(<ScreenPicker screens={screens} onStart={onStart} onCancel={() => {}} />);
    fireEvent.click(screen.getByLabelText("Slides on Built-in"));
    fireEvent.click(screen.getByText("Start presenting"));
    expect(onStart).toHaveBeenCalledWith({ audience: 0, presenter: 1 });
  });

  it("can go without a presenter view", () => {
    const onStart = vi.fn();
    render(<ScreenPicker screens={screens} onStart={onStart} onCancel={() => {}} />);
    fireEvent.click(screen.getByLabelText("No presenter view"));
    fireEvent.click(screen.getByText("Start presenting"));
    expect(onStart).toHaveBeenCalledWith({ audience: 1, presenter: null });
  });

  it("cancels with Escape", () => {
    const onCancel = vi.fn();
    render(<ScreenPicker screens={screens} onStart={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
