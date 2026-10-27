import { describe, expect, it } from "vitest";
import { setCargoVersion, setJsonVersion, versionFromTag } from "./setVersion.ts";

describe("versionFromTag", () => {
  it("strips the v prefix", () => {
    expect(versionFromTag("v1.2.3")).toBe("1.2.3");
    expect(versionFromTag("1.2.3")).toBe("1.2.3");
  });

  it("keeps prerelease and build suffixes", () => {
    expect(versionFromTag("v1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(versionFromTag("v1.2.3+build.5")).toBe("1.2.3+build.5");
  });

  it("rejects things that are not release tags", () => {
    expect(() => versionFromTag("main")).toThrow();
    expect(() => versionFromTag("v1.2")).toThrow();
    expect(() => versionFromTag("")).toThrow();
  });
});

describe("setJsonVersion", () => {
  it("replaces only the top-level version", () => {
    const json = '{\n  "name": "x",\n  "version": "0.1.0",\n  "deps": {\n    "version": "9.9.9"\n  }\n}\n';
    const out = setJsonVersion(json, "1.2.3");
    expect(JSON.parse(out).version).toBe("1.2.3");
    expect(JSON.parse(out).deps.version).toBe("9.9.9");
    expect(out.endsWith("}\n")).toBe(true);
  });

  it("is a no-op when the version already matches", () => {
    const json = '{\n  "version": "1.2.3"\n}\n';
    expect(setJsonVersion(json, "1.2.3")).toBe(json);
  });

  it("fails without a version field", () => {
    expect(() => setJsonVersion('{\n  "name": "x"\n}\n', "1.2.3")).toThrow();
  });
});

describe("setCargoVersion", () => {
  it("replaces the package version, not dependency versions", () => {
    const toml = '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n';
    const out = setCargoVersion(toml, "1.2.3");
    expect(out).toContain('version = "1.2.3"');
    expect(out).toContain('serde = { version = "1" }');
  });

  it("fails without a package version", () => {
    expect(() => setCargoVersion('[dependencies]\nserde = "1"\n', "1.2.3")).toThrow();
  });
});

describe("repo manifests", () => {
  it("can all be stamped", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (path: string) => readFileSync(path, "utf8");
    expect(JSON.parse(setJsonVersion(read("package.json"), "1.2.3")).version).toBe("1.2.3");
    expect(JSON.parse(setJsonVersion(read("src-tauri/tauri.conf.json"), "1.2.3")).version).toBe("1.2.3");
    expect(setCargoVersion(read("src-tauri/Cargo.toml"), "1.2.3")).toMatch(/^version = "1\.2\.3"$/m);
  });
});
