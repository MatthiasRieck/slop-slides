import { afterEach, describe, expect, it, vi } from "vitest";

import { useApp } from "../../store";
import { reportingErrors, showError } from "./errors";
import { readChoice, writeChoice } from "./storedChoice";

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

describe("stored choices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("remembers a choice", () => {
    expect(readChoice("test.choice")).toBeNull();
    writeChoice("test.choice", "lasso");
    expect(readChoice("test.choice")).toBe("lasso");
  });

  it("goes without when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeChoice("test.choice", "rect")).not.toThrow();
    expect(readChoice("test.choice")).toBeNull();
  });
});
