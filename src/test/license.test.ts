// @vitest-environment node
/** The repository is MIT licensed; every manifest that ships with the app must say so. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Windows checkouts may convert line endings to CRLF.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("license", () => {
  it("ships the MIT license text", () => {
    const license = read("LICENSE");
    expect(license).toMatch(/^MIT License\n/);
    expect(license).toContain("Copyright (c) 2026 Matthias Rieck");
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it.each([
    ["package.json", () => JSON.parse(read("package.json")).license],
    ["Cargo.toml", () => /^license = "(.*)"$/m.exec(read("src-tauri/Cargo.toml"))?.[1]],
    ["the app bundle config", () => JSON.parse(read("src-tauri/tauri.conf.json")).bundle.license],
  ])("declares MIT in %s", (_, license) => {
    expect(license()).toBe("MIT");
  });
});
