/** The repository is MIT licensed; every manifest that ships with the app must say so. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("license", () => {
  it("ships the MIT license text", () => {
    const license = read("LICENSE");
    expect(license).toMatch(/^MIT License\n/);
    expect(license).toContain("Copyright (c) 2026 Matthias Rieck");
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it("declares MIT in package.json", () => {
    expect(JSON.parse(read("package.json")).license).toBe("MIT");
  });

  it("declares MIT in Cargo.toml", () => {
    expect(read("src-tauri/Cargo.toml")).toMatch(/^license = "MIT"$/m);
  });

  it("declares MIT in the app bundle config", () => {
    expect(JSON.parse(read("src-tauri/tauri.conf.json")).bundle.license).toBe("MIT");
  });
});
