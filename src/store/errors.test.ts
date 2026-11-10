import { beforeEach, describe, expect, it } from "vitest";

import { reportingErrors, showError, useApp } from "../store";
import { reportingErrorsIn, showErrorIn } from "./errors";

beforeEach(() => useApp.setState({ error: null }));

describe("showing errors", () => {
  it("shows what went wrong in the error banner, after a prefix", () => {
    showErrorIn(useApp, new Error("disk full"), "Could not save: ");
    expect(useApp.getState().error).toBe("Could not save: disk full");
    showErrorIn(useApp, "plain");
    expect(useApp.getState().error).toBe("plain");
  });

  it("hands back what the action gives, leaving the banner alone", async () => {
    expect(await reportingErrorsIn(useApp, async () => 42)).toBe(42);
    expect(useApp.getState().error).toBeNull();
  });

  it("shows what the action threw, after a prefix, and gives nothing back", async () => {
    const failing = async () => {
      throw new Error("disk full");
    };
    expect(await reportingErrorsIn(useApp, failing, "Could not save: ")).toBeUndefined();
    expect(useApp.getState().error).toBe("Could not save: disk full");
  });

  it("is bound to the app's store for the components", async () => {
    showError(new Error("gone"), "Could not open: ");
    expect(useApp.getState().error).toBe("Could not open: gone");
    expect(
      await reportingErrors(async () => {
        throw new Error("busy");
      }),
    ).toBeUndefined();
    expect(useApp.getState().error).toBe("busy");
    expect(await reportingErrors(async () => "done")).toBe("done");
  });
});
