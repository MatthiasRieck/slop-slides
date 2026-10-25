/**
 * The signed macOS build: the bundle config (src-tauri/tauri.conf.json, Entitlements.plist)
 * and the settings validation in scripts/build-signed.sh.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../..");
const SCRIPT = join(ROOT, "scripts/build-signed.sh");

describe("macOS bundle config", () => {
  const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));

  it("signs with the hardened runtime and the app's entitlements", () => {
    expect(conf.bundle.macOS.hardenedRuntime).toBe(true);
    const entitlements = readFileSync(join(ROOT, "src-tauri", conf.bundle.macOS.entitlements), "utf8");
    // Dictation: without this a hardened-runtime app gets no microphone input at all.
    expect(entitlements).toMatch(
      /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/,
    );
  });

  it("targets macOS 10.15, which whisper.cpp's std::filesystem needs", () => {
    // Tauri passes this to the C++ build as MACOSX_DEPLOYMENT_TARGET; its default (10.13)
    // fails to compile whisper.cpp.
    expect(conf.bundle.macOS.minimumSystemVersion).toBe("10.15");
  });

  it("keeps signing identities out of the checked-in config", () => {
    expect(conf.bundle.macOS.signingIdentity).toBeUndefined();
  });

  it("keeps the local signing settings out of git", () => {
    expect(readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n")).toContain(".signing.env");
  });
});

describe.runIf(process.platform === "darwin")("scripts/build-signed.sh", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Runs the script with only the given settings (no inherited Apple variables). */
  function run(args: string[], settings: Record<string, string> = {}) {
    dir = mkdtempSync(join(tmpdir(), "slopslide-signing-"));
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? dir,
      SLOPSLIDE_SIGNING_ENV: join(dir, "missing.env"),
      ...settings,
    };
    const result = spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8" });
    return { status: result.status, output: result.stdout + result.stderr };
  }

  function envFile(contents: string) {
    dir = mkdtempSync(join(tmpdir(), "slopslide-signing-"));
    const path = join(dir, "signing.env");
    writeFileSync(path, contents);
    return path;
  }

  it("rejects unknown options", () => {
    const { status, output } = run(["--bogus"]);
    expect(status).not.toBe(0);
    expect(output).toContain("Unknown option: --bogus");
  });

  it("asks for a signing identity", () => {
    const { status, output } = run(["--check"]);
    expect(status).not.toBe(0);
    expect(output).toContain("APPLE_SIGNING_IDENTITY is not set");
  });

  it("refuses to notarize with a development certificate", () => {
    const { status, output } = run(["--check"], {
      APPLE_SIGNING_IDENTITY: "Apple Development: someone@example.com (ABCDE12345)",
    });
    expect(status).not.toBe(0);
    expect(output).toContain('needs a "Developer ID Application" certificate');
  });

  it("asks for notarization credentials", () => {
    const { status, output } = run(["--check"], {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (ABCDE12345)",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("No notarization credentials");
  });

  it("wants the whole Apple ID triple", () => {
    const { status, output } = run(["--check"], {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (ABCDE12345)",
      APPLE_ID: "someone@example.com",
      APPLE_PASSWORD: "abcd-efgh-ijkl-mnop",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("APPLE_TEAM_ID");
  });

  it("checks that the API key file exists", () => {
    const { status, output } = run(["--check"], {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (ABCDE12345)",
      APPLE_API_KEY: "ABC123DEF4",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
      APPLE_API_KEY_PATH: "/nonexistent/AuthKey_ABC123DEF4.p8",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("APPLE_API_KEY_PATH does not exist");
  });

  it("looks the identity up in the keychain", () => {
    const { status, output } = run(["--check", "--no-notarize"], {
      APPLE_SIGNING_IDENTITY: "Apple Development: nobody-slopslide-test@example.com (ZZZZZ99999)",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("was not found in your keychain");
  });

  it("resolves an identity given as a certificate hash", () => {
    const { status, output } = run(["--check", "--no-notarize"], {
      APPLE_SIGNING_IDENTITY: "0000000000000000000000000000000000000000",
    });
    expect(status).not.toBe(0);
    expect(output).toContain("No signing certificate with hash 0000000000000000000000000000000000000000");
  });

  it("reads its settings from the signing env file", () => {
    const path = envFile('APPLE_SIGNING_IDENTITY="Apple Development: file@example.com (FFFFF11111)"\n');
    const { status, output } = run(["--check"], { SLOPSLIDE_SIGNING_ENV: path });
    expect(status).not.toBe(0);
    expect(output).toContain("Loading signing settings from");
    expect(output).toContain("Apple Development: file@example.com (FFFFF11111)");
  });

  it("accepts a .p12 certificate instead of the keychain", () => {
    const { status, output } = run(["--check", "--no-notarize"], {
      APPLE_SIGNING_IDENTITY: "Developer ID Application: Someone (ABCDE12345)",
      APPLE_CERTIFICATE: "MIIabc",
      APPLE_CERTIFICATE_PASSWORD: "secret",
    });
    expect(output).toContain("Signing settings look good");
    expect(status).toBe(0);
  });
});
