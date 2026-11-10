import { afterEach, describe, expect, it, vi } from "vitest";
import { loadJson, saveJson } from "./storage";

const asNumbers = (saved: unknown) => {
  if (!Array.isArray(saved) || !saved.every((n) => typeof n === "number")) throw new Error("not numbers");
  return saved as number[];
};

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
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(loadJson("numbers", [7], asNumbers)).toEqual([7]);
  });
});
