import { afterEach, describe, expect, it, vi } from "vitest";
import { loadFlag, loadJson, loadText, saveFlag, saveJson, saveText, trySaveText } from "./storage";

const asNumbers = (saved: unknown) => {
  if (!Array.isArray(saved) || !saved.every((n) => typeof n === "number")) throw new Error("not numbers");
  return saved as number[];
};

/** Makes every `localStorage` read and write fail, as in a private window. */
function blockStorage() {
  for (const method of ["getItem", "setItem", "removeItem"] as const) {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error("SecurityError");
    });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadJson", () => {
  it("reads what saveJson stored, through the check", () => {
    saveJson("numbers", [1, 2]);
    expect(localStorage.getItem("numbers")).toBe("[1,2]");
    expect(loadJson("numbers", [], asNumbers)).toEqual([1, 2]);
  });

  it("hands the check stored nulls, leaving them to it", () => {
    localStorage.setItem("value", "null");
    expect(loadJson<string | null>("value", "fallback", (saved) => saved as null)).toBeNull();
  });

  it.each([
    ["nothing is stored", null],
    ["what is stored is not JSON", "{oops"],
    ["the check refuses it", '["a"]'],
  ])("falls back when %s", (_, stored) => {
    if (stored !== null) localStorage.setItem("numbers", stored);
    expect(loadJson("numbers", [7], asNumbers)).toEqual([7]);
  });

  it("falls back when storage is unavailable", () => {
    blockStorage();
    expect(loadJson("numbers", [7], asNumbers)).toEqual([7]);
  });
});

describe("flags", () => {
  it.each([true, false])("reads a flag that defaults to %s as saved, and anything else as the default", (fallback) => {
    expect(loadFlag("f", fallback)).toBe(fallback);
    saveFlag("f", !fallback);
    expect(localStorage.getItem("f")).toBe(String(!fallback));
    expect(loadFlag("f", fallback)).toBe(!fallback);
    localStorage.setItem("f", "bogus");
    expect(loadFlag("f", fallback)).toBe(fallback);
  });

  it.each([true, false])("defaults to %s when storage is unavailable", (fallback) => {
    localStorage.setItem("f", String(!fallback));
    blockStorage();
    expect(loadFlag("f", fallback)).toBe(fallback);
  });
});

describe("texts", () => {
  it("remembers a text, and forgets it when saved as null", () => {
    expect(loadText("choice")).toBeNull();
    saveText("choice", "lasso");
    expect(localStorage.getItem("choice")).toBe("lasso");
    expect(loadText("choice")).toBe("lasso");
    saveText("choice", null);
    expect(localStorage.getItem("choice")).toBeNull();
    trySaveText("choice", "rect");
    expect(loadText("choice")).toBe("rect");
    trySaveText("choice", null);
    expect(loadText("choice")).toBeNull();
  });

  it("reads nothing when storage is unavailable; only trySaveText goes without saving", () => {
    localStorage.setItem("choice", "lasso");
    blockStorage();
    expect(loadText("choice")).toBeNull();
    expect(() => trySaveText("choice", "rect")).not.toThrow();
    expect(() => trySaveText("choice", null)).not.toThrow();
    expect(() => saveText("choice", "rect")).toThrow("SecurityError");
    expect(() => saveText("choice", null)).toThrow("SecurityError");
    expect(() => saveJson("numbers", [1])).toThrow("SecurityError");
    expect(() => saveFlag("f", true)).toThrow("SecurityError");
  });
});
