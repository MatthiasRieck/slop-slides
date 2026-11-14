import type { Provider } from "./models";

/** How full one provider's conversation is. Each provider keeps its own session. */
export interface ContextUsage {
  provider: Provider;
  /** Tokens the context holds; null right after a compaction, until the next turn reports. */
  tokens: number | null;
  /** The context window size, when the agent reported it. */
  window: number | null;
}

/**
 * Context use from this share of the window on is worth the user's attention: the chat says how
 * full it is and offers to compact the conversation. Below it, how full the chat is is noise.
 */
export const COMPACT_THRESHOLD = 60;
/** From this share on the chat is about to run out of room. */
export const NEARLY_FULL = 90;

/**
 * What the chat says about a conversation that fills `percent` of its window, in plain words;
 * null while it has room to spare (or how full it is is not known).
 */
export function contextNotice(percent: number | null): { text: string; advice: string; urgent: boolean } | null {
  if (percent === null || percent < COMPACT_THRESHOLD) return null;
  const full = Math.round(percent);
  if (percent < NEARLY_FULL) {
    return { text: `This chat is ${full}% full.`, advice: "Compact summarizes it to make room.", urgent: false };
  }
  return {
    text: `This chat is almost full (${full}%).`,
    advice: "Compact it or start a new chat, or the agent loses track of how it began.",
    urgent: true,
  };
}

/** What the replies of a chat cost together, in US dollars; null when no reply reported a cost. */
export function totalCost(messages: readonly { role: string; costUsd?: number | null }[]): number | null {
  let total = 0;
  let known = false;
  for (const message of messages) {
    if (typeof message.costUsd === "number") {
      total += message.costUsd;
      known = true;
    }
  }
  return known ? total : null;
}

/** A cost in dollars as the chat shows it: cents, or tenths of a cent while it is under ten cents. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.1 ? 3 : 2)}`;
}

const WINDOW_SIZES: Record<string, number> = { "200k": 200_000, "1m": 1_000_000 };

/** Tokens in a context window choice such as `200k` or `1m`; null when unknown. */
export function windowTokens(contextWindow: string | null | undefined): number | null {
  return (contextWindow && WINDOW_SIZES[contextWindow]) || null;
}

/** The newest context usage recorded for `provider`'s conversation. */
export function latestContext(
  messages: readonly { role: string; context?: ContextUsage | null }[],
  provider: Provider,
): ContextUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const context = messages[i]!.context;
    if (context?.provider === provider) return context;
  }
  return null;
}

/** `previous` updated with what an agent's usage report knows; unknown fields carry over. */
export function mergeContext(
  previous: ContextUsage | null,
  provider: Provider,
  report: { contextTokens: number | null; contextWindow: number | null },
): ContextUsage {
  return {
    provider,
    tokens: report.contextTokens ?? previous?.tokens ?? null,
    window: report.contextWindow ?? previous?.window ?? null,
  };
}

/** Share of the window in use, 0–100; null when either side is unknown. */
export function contextPercent(tokens: number | null, window: number | null): number | null {
  if (tokens === null || !window) return null;
  return Math.min(100, (tokens / window) * 100);
}

/** `850`, `12.3k`, `146k`, `1.2M`. */
export function formatTokens(tokens: number): string {
  const trim = (n: number, digits: number) => n.toFixed(digits).replace(/\.0$/, "");
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 10_000) return `${trim(tokens / 1000, 1)}k`;
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`;
  return `${trim(tokens / 1_000_000, 1)}M`;
}
