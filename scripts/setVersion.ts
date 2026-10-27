// Stamps the release version onto the app so the bundled artifacts are named after the tag,
// e.g. a v1.2.3 tag builds SlopSlide_1.2.3_aarch64.dmg.
//
//   node scripts/setVersion.ts v1.2.3

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Turns a release tag like `v1.2.3` into the semver `1.2.3` that Tauri, Cargo and npm expect. */
export function versionFromTag(tag: string): string {
  const version = tag.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`"${tag}" is not a release tag like v1.2.3`);
  }
  return version;
}

/** Replaces the top-level `"version"` of a JSON file, keeping the rest of its formatting. */
export function setJsonVersion(json: string, version: string): string {
  const out = json.replace(/^(\s{2}"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (out === json && !json.includes(`"version": "${version}"`)) throw new Error("no top-level version field");
  return out;
}

/** Replaces the `[package]` version of a Cargo.toml. */
export function setCargoVersion(toml: string, version: string): string {
  const out = toml.replace(/(\[package\][^[]*?^version\s*=\s*)"[^"]*"/m, `$1"${version}"`);
  if (out === toml && !toml.includes(`version = "${version}"`)) throw new Error("no [package] version field");
  return out;
}

function main() {
  const tag = process.argv[2];
  if (!tag) throw new Error("usage: node scripts/setVersion.ts <tag>");
  const version = versionFromTag(tag);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const edit = (path: string, set: (text: string, version: string) => string) => {
    const file = join(root, path);
    writeFileSync(file, set(readFileSync(file, "utf8"), version));
  };
  edit("package.json", setJsonVersion);
  edit("src-tauri/tauri.conf.json", setJsonVersion);
  edit("src-tauri/Cargo.toml", setCargoVersion);
  console.log(`version set to ${version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
