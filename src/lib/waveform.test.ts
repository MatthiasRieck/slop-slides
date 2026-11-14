// @vitest-environment node
import { describe, expect, it } from "vitest";

import { wavePath } from "./waveform";

describe("wavePath", () => {
  it("draws one bar per peak, mirrored around the middle", () => {
    expect(wavePath([0.5, 1])).toBe("M0 0.5V1.5M1 0V2");
    expect(wavePath([])).toBe("");
  });
});
