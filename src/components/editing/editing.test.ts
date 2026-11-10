import { afterEach, describe, expect, it } from "vitest";

import { useApp } from "../../store";
import { reportingErrors, showError } from "./errors";

describe("reporting errors", () => {
  afterEach(() => useApp.setState({ error: null }));

  it("hands back what the action gives", async () => {
    expect(await reportingErrors(async () => 42)).toBe(42);
    expect(useApp.getState().error).toBeNull();
  });

  it("shows what went wrong, after a prefix, and gives nothing back", async () => {
    expect(
      await reportingErrors(async () => {
        throw new Error("disk full");
      }, "Could not save: "),
    ).toBeUndefined();
    expect(useApp.getState().error).toBe("Could not save: disk full");
    showError("plain");
    expect(useApp.getState().error).toBe("plain");
  });
});
