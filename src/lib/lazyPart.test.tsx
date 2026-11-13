import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { lazyPart } from "./lazyPart";

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      {label} {count}
    </button>
  );
}

describe("lazyPart", () => {
  it("loads nothing until it renders, holds its place meanwhile, and loads once", async () => {
    const load = vi.fn(async () => Counter);
    const Part = lazyPart(load, <div data-testid="placeholder" />);
    expect(load).not.toHaveBeenCalled();
    render(
      <>
        <Part label="a" />
        <Part label="b" />
      </>,
    );
    expect(screen.getAllByTestId("placeholder")).toHaveLength(2);
    expect(await screen.findByText("a 0")).toBeTruthy();
    expect(screen.getByText("b 0")).toBeTruthy();
    expect(screen.queryByTestId("placeholder")).toBeNull();
    expect(load).toHaveBeenCalledOnce();
  });

  it("renders at once, without its fallback, once preloaded", async () => {
    const load = vi.fn(async () => Counter);
    const Part = lazyPart(load, <div data-testid="placeholder" />);
    await Part.preload();
    await Part.preload();
    expect(load).toHaveBeenCalledOnce();
    render(<Part label="ready" />);
    expect(screen.getByText("ready 0")).toBeTruthy();
    expect(screen.queryByTestId("placeholder")).toBeNull();
  });

  it("keeps what a part mounted before its code arrived holds, when it renders again after", async () => {
    const Part = lazyPart(async () => Counter);
    const { rerender } = render(<Part label="n" />);
    const button = await screen.findByText("n 0");
    act(() => button.click());
    expect(screen.getByText("n 1")).toBeTruthy();
    // Rendered again with the code loaded: the same component still, its state kept.
    rerender(<Part label="m" />);
    expect(screen.getByText("m 1")).toBeTruthy();
  });
});
