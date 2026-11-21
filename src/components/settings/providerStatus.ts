import { PROVIDERS, type ProviderInfo } from "../../lib/models";

/** How a status reads at a glance, as the colour of its dot: a palette token each (see `TONE_DOT`). */
export type StatusTone = "success" | "warning" | "destructive" | "muted";

/** The dot's colour for each tone. */
export const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  destructive: "bg-destructive",
  muted: "bg-muted-foreground",
};

/** What the settings say of one agent's CLI: whether it can take a chat, and what to do when it cannot. */
export interface ProviderStatus {
  headline: "Checking…" | "Not installed" | "Not signed in" | "Needs attention" | "Ready";
  tone: StatusTone;
  /** A line under the headline: what was found, or what is wrong. */
  detail: string | null;
  /** How to install the CLI or sign in to it, its commands in backticks; null when nothing is missing. */
  hint: string | null;
}

/**
 * The status of a provider from what the backend's check found (`info`; undefined before the
 * first answer). While a check runs (`checking`) it says so, whatever was known before. A CLI
 * that is signed out says that rather than "needs attention": its error is the way to sign in.
 */
export function providerStatus(info: ProviderInfo | undefined, checking = false): ProviderStatus {
  if (checking || !info) return { headline: "Checking…", tone: "muted", detail: null, hint: null };
  const { cli, install, signIn } = PROVIDERS[info.id];
  if (!info.installed) {
    return {
      headline: "Not installed",
      tone: "muted",
      detail: `${cli} was not found on this computer.`,
      hint: install,
    };
  }
  if (info.auth === "signedOut") {
    return {
      headline: "Not signed in",
      tone: "warning",
      detail: `${cli} is installed, but nobody is signed in.`,
      hint: signIn,
    };
  }
  if (info.error) return { headline: "Needs attention", tone: "destructive", detail: info.error, hint: null };
  const models = `${info.models.length} ${info.models.length === 1 ? "model" : "models"}`;
  return {
    headline: "Ready",
    tone: "success",
    detail: info.auth === "signedIn" ? `Signed in · ${models}` : models,
    hint: null,
  };
}
