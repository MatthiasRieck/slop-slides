import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useHandlers } from "./useHandlers";

describe("useHandlers", () => {
  it("gives functions that stay the same and call the handler given last", () => {
    const { result, rerender } = renderHook(({ by }) => useHandlers({ add: (n: number) => n + by }), {
      initialProps: { by: 1 },
    });
    const first = result.current;
    expect(first.add(1)).toBe(2);
    rerender({ by: 10 });
    expect(result.current).toBe(first);
    expect(result.current.add).toBe(first.add);
    expect(first.add(1)).toBe(11);
  });
});
