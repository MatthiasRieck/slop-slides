import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { observerCount, type Place, placeElements } from "../test/intersection";
import { type InView, useInView } from "./useInView";

const seen = new Map<string, InView>();

function Row({ name, watching = true }: { name: string; watching?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  seen.set(name, useInView(ref, watching));
  return <div ref={ref} data-row={name} />;
}

/** Puts the rows where `places` says, by name. */
const scroll = (places: Record<string, Place>) =>
  act(() =>
    placeElements((element) => {
      const name = (element as HTMLElement).dataset.row ?? "";
      return name in places ? places[name]! : 0;
    }),
  );

describe("useInView", () => {
  it("tells in view from near it, further off and far away", () => {
    scroll({ shown: 0, next: 0.5, further: 2, far: 6 });
    render(
      <div>
        {["shown", "next", "further", "far"].map((name) => (
          <Row key={name} name={name} />
        ))}
      </div>,
    );
    expect(Object.fromEntries(seen)).toEqual({ shown: "visible", next: "near", further: "held", far: "away" });
    scroll({ shown: 6, next: 2, further: 0.5, far: 0 });
    expect(Object.fromEntries(seen)).toEqual({ shown: "away", next: "held", further: "near", far: "visible" });
  });

  it("holds an element that takes no space: it is neither near nor away", () => {
    scroll({ row: null });
    render(<Row name="row" />);
    expect(seen.get("row")).toBe("held");
  });

  it("takes an element that is not watched to be in view", () => {
    scroll({ row: 6 });
    const before = observerCount();
    render(<Row name="row" watching={false} />);
    expect(seen.get("row")).toBe("visible");
    expect(observerCount()).toBe(before);
  });

  it("watches all the elements of a scroller with the same observers, and stops with the last", () => {
    const before = observerCount();
    const names = Array.from({ length: 20 }, (_, i) => `row ${i}`);
    const { unmount } = render(
      <div>
        {names.map((name) => (
          <Row key={name} name={name} />
        ))}
      </div>,
    );
    // One for each distance told apart, not one for each element.
    expect(observerCount() - before).toBe(3);
    unmount();
    expect(observerCount()).toBe(before);
  });
});
