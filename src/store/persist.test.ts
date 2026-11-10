import { describe, expect, it } from "vitest";

import { loadFlag, loadJson, saveFlag, saveJson } from "./persist";

describe("saved preferences", () => {
  it("reads back saved JSON, and null for nothing saved or what is not JSON", () => {
    expect(loadJson("k")).toBeNull();
    saveJson("k", { tabs: ["chat"] });
    expect(localStorage.getItem("k")).toBe('{"tabs":["chat"]}');
    expect(loadJson("k")).toEqual({ tabs: ["chat"] });
    localStorage.setItem("k", "not json");
    expect(loadJson("k")).toBeNull();
  });

  it.each([true, false])("reads a flag that defaults to %s as saved, and anything else as the default", (fallback) => {
    expect(loadFlag("f", fallback)).toBe(fallback);
    saveFlag("f", !fallback);
    expect(localStorage.getItem("f")).toBe(String(!fallback));
    expect(loadFlag("f", fallback)).toBe(!fallback);
    localStorage.setItem("f", "bogus");
    expect(loadFlag("f", fallback)).toBe(fallback);
  });
});
