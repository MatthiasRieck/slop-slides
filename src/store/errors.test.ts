import { beforeEach, describe, expect, it } from "vitest";

import { dismissToast, reportingErrors, showError, showInfo, showSuccess, useApp } from "../store";
import { lastError, reportingErrorsIn, showErrorIn, showInfoIn, showSuccessIn, toastTexts } from "./errors";

beforeEach(() => useApp.setState({ toasts: [] }));

describe("showing errors", () => {
  it("shows what went wrong in the error banner, after a prefix", () => {
    showErrorIn(useApp, new Error("disk full"), "Could not save: ");
    expect(lastError(useApp.getState())).toBe("Could not save: disk full");
    showErrorIn(useApp, "plain");
    expect(lastError(useApp.getState())).toBe("plain");
  });

  it("hands back what the action gives, leaving the banner alone", async () => {
    expect(await reportingErrorsIn(useApp, async () => 42)).toBe(42);
    expect(lastError(useApp.getState())).toBeNull();
  });

  it("shows what the action threw, after a prefix, and gives nothing back", async () => {
    const failing = async () => {
      throw new Error("disk full");
    };
    expect(await reportingErrorsIn(useApp, failing, "Could not save: ")).toBeUndefined();
    expect(lastError(useApp.getState())).toBe("Could not save: disk full");
  });

  it("is bound to the app's store for the components", async () => {
    showError(new Error("gone"), "Could not open: ");
    expect(lastError(useApp.getState())).toBe("Could not open: gone");
    expect(
      await reportingErrors(async () => {
        throw new Error("busy");
      }),
    ).toBeUndefined();
    expect(lastError(useApp.getState())).toBe("busy");
    expect(await reportingErrors(async () => "done")).toBe("done");
  });
});

describe("toasts", () => {
  const toasts = () => useApp.getState().toasts.map(({ kind, text }) => [kind, text]);

  it("stacks what the app says, newest last, each with an id of its own", () => {
    showErrorIn(useApp, "disk full");
    showInfoIn(useApp, "Imported, with changes");
    showSuccessIn(useApp, "Exported");
    expect(toasts()).toEqual([
      ["error", "disk full"],
      ["info", "Imported, with changes"],
      ["success", "Exported"],
    ]);
    const ids = useApp.getState().toasts.map((toast) => toast.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps the three newest, dropping the older ones", () => {
    for (const text of ["one", "two", "three", "four"]) showErrorIn(useApp, text);
    expect(toasts().map(([, text]) => text)).toEqual(["two", "three", "four"]);
  });

  it("moves a message said again to the end rather than showing it twice", () => {
    showErrorIn(useApp, "disk full");
    showInfoIn(useApp, "disk full");
    showErrorIn(useApp, "busy");
    const first = useApp.getState().toasts[0]!.id;
    showErrorIn(useApp, "disk full");
    expect(toasts()).toEqual([
      ["info", "disk full"],
      ["error", "busy"],
      ["error", "disk full"],
    ]);
    expect(useApp.getState().toasts.some((toast) => toast.id === first)).toBe(false);
  });

  it("dismisses one toast by its id, leaving the others", () => {
    showError("disk full");
    showInfo("Imported");
    const [error, info] = useApp.getState().toasts;
    dismissToast(error!.id);
    expect(useApp.getState().toasts).toEqual([info]);
    dismissToast(error!.id);
    expect(useApp.getState().toasts).toEqual([info]);
  });

  it("carries an action for the toast's button", () => {
    const run = () => {};
    showInfo("The agent made notes.html.", { label: "Open", run });
    showSuccess("Exported", { label: "Show", run });
    expect(useApp.getState().toasts.map((toast) => toast.action)).toEqual([
      { label: "Open", run },
      { label: "Show", run },
    ]);
    showInfo("Plain");
    expect("action" in useApp.getState().toasts.at(-1)!).toBe(false);
  });

  it("tells errors from the rest", () => {
    showInfo("Imported");
    expect(lastError(useApp.getState())).toBeNull();
    showError("busy");
    showSuccess("Exported");
    expect(lastError(useApp.getState())).toBe("busy");
    expect(toastTexts(useApp.getState(), "info")).toEqual(["Imported"]);
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Exported"]);
  });
});
