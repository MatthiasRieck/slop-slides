export type Provider = "claude" | "codex" | "copilot";

export const PROVIDER_IDS: Provider[] = ["claude", "codex", "copilot"];

export const PROVIDERS: Record<Provider, { label: string; cli: string; install: string }> = {
  claude: {
    label: "Claude",
    cli: "Claude Code",
    install: "Install it from claude.com/claude-code and run `claude` once to sign in.",
  },
  codex: {
    label: "Codex",
    cli: "Codex",
    install: "Install it with `npm i -g @openai/codex` and run `codex` once to sign in.",
  },
  copilot: {
    label: "GitHub Copilot",
    cli: "GitHub Copilot",
    install: "Install it with `npm i -g @github/copilot`, then run `copilot` and use /login to sign in.",
  },
};

/** A model as reported by the backend (Codex and Copilot: live lists; Claude: fixed catalog). */
export interface ProviderModel {
  id: string;
  label: string;
  isDefault: boolean;
  efforts: string[];
  defaultEffort: string | null;
  /** Selectable context window sizes (`200k`, `1m`); empty when the provider picks it. */
  contextWindows: string[];
  defaultContextWindow: string | null;
}

export interface ProviderInfo {
  id: Provider;
  installed: boolean;
  path: string | null;
  models: ProviderModel[];
  /** The CLI is installed but its models could not be listed. */
  error: string | null;
}

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Efforts in the few letters the composer's footer has room for at the sidebar's normal width. */
const SHORT_EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Min",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

/** `effort` in a word of five letters at most, for where there is little room. */
export function shortEffortLabel(effort: string): string {
  return SHORT_EFFORT_LABELS[effort] ?? effortLabel(effort).slice(0, 5);
}

/** What each effort trades, in a line for someone who makes slides. */
const EFFORT_HINTS: Record<string, string> = {
  none: "Answers at once, without thinking it over",
  minimal: "Fastest, for one-word fixes",
  low: "Fast, for small edits",
  medium: "Balanced, for most requests",
  high: "Slower, thinks longer, for whole-deck work",
  xhigh: "Much slower, for the hardest requests",
  max: "Slowest, thinks as long as it can",
};

/** What choosing `effort` means for the answer; empty for an effort this does not know. */
export function effortHint(effort: string): string {
  return EFFORT_HINTS[effort] ?? "";
}

const CONTEXT_WINDOW_HINTS: Record<string, string> = {
  "200k": "Enough for most chats",
  "1m": "Holds very long chats, can cost more",
};

/** What choosing the context window `contextWindow` means; empty for one this does not know. */
export function contextWindowHint(contextWindow: string): string {
  return CONTEXT_WINDOW_HINTS[contextWindow] ?? "";
}

/**
 * A model's name without its provider's, for beside the provider's icon, which says it already:
 * "Claude Opus 5.5" of Claude is "Opus 5.5". A name that is nothing else stays whole.
 */
export function shortModelLabel(provider: Provider, label: string): string {
  const prefix = `${PROVIDERS[provider].label} `;
  const short = label.startsWith(prefix) ? label.slice(prefix.length).trim() : label;
  return short || label;
}

const CONTEXT_WINDOW_LABELS: Record<string, string> = { "200k": "200k", "1m": "1M" };

export function contextWindowLabel(contextWindow: string): string {
  return CONTEXT_WINDOW_LABELS[contextWindow] ?? contextWindow.toUpperCase();
}

export const modelKey = (provider: Provider, id: string) => `${provider}:${id}`;

export function defaultModel(info: ProviderInfo): ProviderModel | undefined {
  return info.models.find((m) => m.isDefault) ?? info.models[0];
}

/** Keeps `effort` when the model supports it, else the model's own default. */
export function pickEffort(model: ProviderModel, effort: string): string {
  if (model.efforts.length === 0 || model.efforts.includes(effort)) return effort;
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return model.efforts.includes("medium") ? "medium" : model.efforts[0]!;
}

/** The effort to request: none for a model known to take no effort setting. */
export function requestEffort(model: ProviderModel | undefined, effort: string): string {
  return model && model.efforts.length === 0 ? "" : effort;
}

/** Keeps `contextWindow` when the model offers it, else the model's own default. */
export function pickContextWindow(model: ProviderModel, contextWindow: string | null): string | null {
  if (model.contextWindows.length === 0) return null;
  if (contextWindow && model.contextWindows.includes(contextWindow)) return contextWindow;
  if (model.defaultContextWindow && model.contextWindows.includes(model.defaultContextWindow)) {
    return model.defaultContextWindow;
  }
  return model.contextWindows[0]!;
}
