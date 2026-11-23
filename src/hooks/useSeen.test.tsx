import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as viewObserver from "../lib/viewObserver";
import { useSeen } from "./useSeen";

function Block() {
  const ref = useRef<HTMLDivElement>(null);
  useSeen(ref);
  return <div ref={ref} />;
}

describe("useSeen", () => {
  afterEach(() => vi.restoreAllMocks());

  it("finds the conversation's scroller by name, without asking for computed styles", () => {
    const scrollerOf = vi.spyOn(viewObserver, "scrollerOf");
    const watch = vi.spyOn(viewObserver, "watchIntersection").mockReturnValue(() => {});
    const { container } = render(
      <div data-slot="message-scroller-viewport">
        <Block />
      </div>,
    );
    expect(scrollerOf).not.toHaveBeenCalled();
    expect(watch.mock.calls[0]?.[1]).toBe(container.firstElementChild);
  });

  it("looks for the scroller around it anywhere else", () => {
    const scrollerOf = vi.spyOn(viewObserver, "scrollerOf").mockReturnValue(null);
    vi.spyOn(viewObserver, "watchIntersection").mockReturnValue(() => {});
    render(<Block />);
    expect(scrollerOf).toHaveBeenCalledTimes(1);
  });
});
