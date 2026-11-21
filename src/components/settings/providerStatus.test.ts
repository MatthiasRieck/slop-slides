import { describe, expect, it } from "vitest";

import type { ProviderInfo, ProviderModel } from "../../lib/models";
import { providerStatus, TONE_DOT } from "./providerStatus";

const model = (id: string): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  efforts: [],
  defaultEffort: null,
  contextWindows: [],
  defaultContextWindow: null,
});

const info = (patch: Partial<ProviderInfo> = {}): ProviderInfo => ({
  id: "codex",
  installed: true,
  path: "/bin/codex",
  models: [model("a"), model("b")],
  error: null,
  version: "1.2.3",
  auth: "signedIn",
  ...patch,
});

describe("providerStatus", () => {
  it("says a check is running, before the first answer and over what was known", () => {
    expect(providerStatus(undefined)).toEqual({ headline: "Checking…", tone: "muted", detail: null, hint: null });
    expect(providerStatus(info(), true).headline).toBe("Checking…");
    expect(providerStatus(info({ installed: false }), true).hint).toBeNull();
  });

  it("says a CLI is not installed, with how to install it", () => {
    const status = providerStatus(info({ installed: false, path: null, models: [], version: null, auth: "unknown" }));
    expect(status).toMatchObject({
      headline: "Not installed",
      tone: "muted",
      detail: "Codex was not found on this computer.",
    });
    expect(status.hint).toContain("`npm i -g @openai/codex`");
  });

  it("says a CLI is signed out, with how to sign in, rather than passing its error on", () => {
    const status = providerStatus(info({ models: [], auth: "signedOut", error: "Codex reported no models." }));
    expect(status).toMatchObject({
      headline: "Not signed in",
      tone: "warning",
      detail: "Codex is installed, but nobody is signed in.",
    });
    expect(status.hint).toContain("`codex login`");
    // Claude Code can be signed out with its fixed list of models there.
    const claude = providerStatus(info({ id: "claude", auth: "signedOut" }));
    expect(claude.headline).toBe("Not signed in");
    expect(claude.hint).toContain("`claude`");
    expect(providerStatus(info({ id: "copilot", auth: "signedOut" })).hint).toContain("/login");
  });

  it("gives the error of a CLI that could not be asked as the detail", () => {
    expect(providerStatus(info({ models: [], auth: "unknown", error: "timed out after 10 s" }))).toEqual({
      headline: "Needs attention",
      tone: "destructive",
      detail: "timed out after 10 s",
      hint: null,
    });
  });

  it("says a CLI is ready, with what is known of it", () => {
    expect(providerStatus(info())).toEqual({
      headline: "Ready",
      tone: "success",
      detail: "Signed in · 2 models",
      hint: null,
    });
    // Whether it is signed in could not be found out without asking a model.
    expect(providerStatus(info({ auth: "unknown", models: [model("a")] })).detail).toBe("1 model");
  });

  it("has a dot colour from the palette for every tone", () => {
    expect(TONE_DOT).toEqual({
      success: "bg-success",
      warning: "bg-warning",
      destructive: "bg-destructive",
      muted: "bg-muted-foreground",
    });
  });
});
