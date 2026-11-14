import { beforeEach, describe, expect, it } from "vitest";

import { dismissToast, reportingErrors, showError, showInfo, showSuccess, useApp } from "../store";
import {
  lastError,
  readableError,
  reportingErrorsIn,
  showErrorIn,
  showInfoIn,
  showSuccessIn,
  toastTexts,
  UNREADABLE_ERROR,
} from "./errors";

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

describe("saying what went wrong", () => {
  const error = () => useApp.getState().toasts.at(-1)!;

  it("says what was being done, then what happened", () => {
    showError(new Error("The folder is gone."), { doing: "Could not open the deck" });
    expect(error().text).toBe("Could not open the deck: The folder is gone.");
    expect(error().details).toBeUndefined();
    expect(error().action).toBeUndefined();
  });

  it("offers a way on from it", async () => {
    let tries = 0;
    const retry = { label: "Retry", run: () => void tries++ };
    await reportingErrors(
      async () => {
        throw new Error("offline");
      },
      { doing: "Could not load the voices", action: retry },
    );
    expect(error().text).toBe("Could not load the voices: offline");
    error().action!.run();
    expect(tries).toBe(1);
  });

  it("marks an error about the slide show, which shows during it", () => {
    showError("No second screen", { duringShow: true });
    expect(error().duringShow).toBe(true);
    showError("disk full");
    expect(error().duringShow).toBeUndefined();
  });

  it("leaves an ordinary message as it is", () => {
    for (const plain of ["disk full", "The slides changed while reordering; try again.", "No slide {id} here"]) {
      expect(readableError(plain)).toEqual({ text: plain });
    }
    expect(readableError(new Error("gone"))).toEqual({ text: "gone" });
  });

  it("never shows a service's raw answer: its message in words, the rest as details", () => {
    const raw = 'API error 429: {"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}';
    expect(readableError(raw)).toEqual({ text: "API error 429: Too many requests", details: raw });
    expect(readableError('{"message":"Voice not found"}')).toEqual({
      text: "Voice not found",
      details: '{"message":"Voice not found"}',
    });
    expect(readableError('request failed: {"error":"quota exceeded"}').text).toBe("request failed: quota exceeded");
    expect(readableError('{"code":17}')).toEqual({ text: UNREADABLE_ERROR, details: '{"code":17}' });
    const page = "502 Bad Gateway <!DOCTYPE html><html><body>nginx</body></html>";
    expect(readableError(page)).toEqual({ text: "502 Bad Gateway", details: page });
    expect(readableError("<html><body>Oops</body></html>").text).toBe(UNREADABLE_ERROR);
  });

  it("shows the first line of a stack trace or a wall of text, the whole as details", () => {
    const trace = "TypeError: x is not a function\n    at render (app.js:1:2)\n    at run (app.js:3:4)";
    expect(readableError(trace)).toEqual({ text: "TypeError: x is not a function", details: trace });
    const wall = "word ".repeat(200).trim();
    const read = readableError(wall);
    expect(read.details).toBe(wall);
    expect(read.text.length).toBeLessThanOrEqual(401);
    expect(read.text.endsWith("…")).toBe(true);
  });

  it("says something for an error that says nothing", () => {
    expect(readableError("")).toEqual({ text: UNREADABLE_ERROR });
    showError("  ", { doing: "Could not export" });
    expect(error().text).toBe(`Could not export: ${UNREADABLE_ERROR}`);
  });

  it("keeps the raw answer with the toast, for its Details", () => {
    const raw = 'HTTP 500: {"detail":"model crashed"}';
    showErrorIn(useApp, raw, { doing: "Could not make the audio" });
    expect(error().text).toBe("Could not make the audio: HTTP 500: model crashed");
    expect(error().details).toBe(raw);
    // A plain prefix still goes before the message as it is.
    showErrorIn(useApp, raw, "Narration: ");
    expect(error().text).toBe("Narration: HTTP 500: model crashed");
  });
});
