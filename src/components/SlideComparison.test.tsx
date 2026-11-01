import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));

import { useChanges } from "../changesStore";
import { DEFAULT_DIVIDER, revealMask } from "../lib/compare";
import { SlideComparison } from "./SlideComparison";

const box = { width: 960, height: 540 };
const show = () => render(<SlideComparison box={box} scale={0.5} before={<p>before</p>} after={<p>after</p>} />);
const divider = () => useChanges.getState().divider;
const surface = () => screen.getByTestId("comparison-surface");

beforeEach(() => {
  useChanges.setState({ divider: DEFAULT_DIVIDER });
  HTMLElement.prototype.setPointerCapture = vi.fn();
});

describe("SlideComparison", () => {
  it("shows both versions, with the new one cut along the divider", () => {
    useChanges.setState({ divider: { x: 0.25, y: 0.5, angle: 30, feather: 50 } });
    show();
    expect(screen.getByText("before")).toBeTruthy();
    const after = screen.getByTestId("comparison-after");
    expect(after.textContent).toBe("after");
    expect(after.dataset.mask).toBe(revealMask(divider(), box, 0.5));
    expect(screen.getByText("Old")).toBeTruthy();
    expect(screen.getByText("New")).toBeTruthy();
  });

  it("moves the divider with a drag anywhere on the slide", () => {
    show();
    fireEvent.pointerDown(surface(), { clientX: 240, clientY: 135, button: 0, pointerId: 1 });
    expect(divider()).toMatchObject({ x: 0.25, y: 0.25 });
    fireEvent.pointerMove(surface(), { clientX: 720, clientY: 135 });
    expect(divider()).toMatchObject({ x: 0.75, y: 0.25 });
  });

  it("stops following the pointer on release", () => {
    show();
    fireEvent.pointerDown(surface(), { clientX: 240, clientY: 270, button: 0, pointerId: 1 });
    fireEvent.pointerUp(surface());
    fireEvent.pointerMove(surface(), { clientX: 720, clientY: 270 });
    expect(divider().x).toBe(0.25);
  });

  it("ignores other buttons", () => {
    show();
    fireEvent.pointerDown(surface(), { clientX: 240, clientY: 270, button: 2, pointerId: 1 });
    expect(divider().x).toBe(0.5);
  });

  it("rotates the divider around its point with the handle, without moving it", () => {
    show();
    const knob = screen.getByRole("slider", { name: "Rotate the divider" });
    fireEvent.pointerDown(knob, { clientX: 480, clientY: 198, button: 0, pointerId: 1 });
    expect(divider().angle).toBe(0);
    fireEvent.pointerMove(surface(), { clientX: 580, clientY: 270 });
    expect(divider()).toMatchObject({ angle: 90, x: 0.5, y: 0.5 });
  });

  it("snaps the rotation with Shift held", () => {
    show();
    const knob = screen.getByRole("slider", { name: "Rotate the divider" });
    fireEvent.pointerDown(knob, { clientX: 480, clientY: 198, button: 0, pointerId: 1 });
    fireEvent.pointerMove(surface(), { clientX: 580, clientY: 180, shiftKey: true });
    expect(divider().angle).toBe(45);
  });

  it("moves and rotates by keyboard", () => {
    show();
    const move = screen.getByRole("slider", { name: "Move the divider" });
    fireEvent.keyDown(move, { key: "ArrowRight", shiftKey: true });
    expect(divider().x).toBeGreaterThan(0.5);
    const rotate = screen.getByRole("slider", { name: "Rotate the divider" });
    fireEvent.keyDown(rotate, { key: "ArrowRight" });
    expect(divider().angle).toBe(1);
    fireEvent.keyDown(rotate, { key: "ArrowLeft", shiftKey: true });
    expect(divider().angle).toBe(-14);
  });
});
