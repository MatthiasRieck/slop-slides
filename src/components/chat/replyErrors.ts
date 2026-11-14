// What went wrong in a turn, said for someone who makes slides. The agents and the services
// behind them report errors as they have them (`API Error: 529 {"type":"error",…}`); the chat
// shows a sentence and what to do, and keeps their words behind "Details".
import { PROVIDERS, type Provider } from "../../lib/models";

/** What the chat offers to do about an error. */
export type ErrorAction =
  /** Send the message again. */
  | "retry"
  /** Sign in to the agent's CLI in a terminal, then send again. */
  | "signIn"
  /** Summarize the conversation to make room. */
  | "compact"
  /** Pick another model. */
  | "model";

export interface ErrorExplanation {
  /** What happened and what to do, in a sentence or two. */
  text: string;
  action: ErrorAction;
  /** The command to run in a terminal, for `signIn`. */
  command?: string;
}

/** The command that starts each agent's CLI, where one signs in. */
const SIGN_IN: Record<Provider, string> = { claude: "claude", codex: "codex", copilot: "copilot" };

/** What an error's text is recognized by, the more telling first: a status alone says least. */
const KINDS: { test: RegExp; explain: (provider: Provider) => ErrorExplanation }[] = [
  {
    test: /prompt is too long|context[ _](length|window)|maximum context|too many tokens|context_length_exceeded|input is too long/i,
    explain: () => ({
      text: "This chat has grown too long for the model. Compact it to make room, or start a new chat.",
      action: "compact",
    }),
  },
  {
    test: /\b401\b|unauthori[sz]ed|authentication|not (logged|signed) in|invalid (x-)?api[ -_]?key|oauth token|please run \/login|sign in again|credentials/i,
    explain: (provider) => ({
      text: `${PROVIDERS[provider].cli} is not signed in. Run this in a terminal, sign in, then try again:`,
      action: "signIn",
      command: SIGN_IN[provider],
    }),
  },
  {
    test: /usage limit|limit reached|quota|out of credits|credit balance|billing|payment required|\b402\b/i,
    explain: () => ({
      text: "You have used up what your plan allows for now. Wait until it resets, or choose another model.",
      action: "model",
    }),
  },
  {
    test: /model.{0,40}(not found|does not exist|not available|not supported|no access)|unknown model|model_not_found|invalid model/i,
    explain: () => ({
      text: "This model is not available to your account. Choose another model and try again.",
      action: "model",
    }),
  },
  {
    test: /overloaded|\b529\b|rate[ _-]?limit|\b429\b|too many requests|at capacity/i,
    explain: () => ({
      text: "The model is busy right now. Nothing you wrote is lost: try again in a moment.",
      action: "retry",
    }),
  },
  {
    test: /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|offline|connection (error|reset|refused|closed|failed)|timed? ?out|socket hang up|dns/i,
    explain: () => ({
      text: "The model could not be reached. Check your internet connection, then try again.",
      action: "retry",
    }),
  },
  {
    test: /\b50[0234]\b|internal server error|api_error|bad gateway|service unavailable|gateway timeout/i,
    explain: () => ({
      text: "The model's service had a problem of its own. Try again in a moment.",
      action: "retry",
    }),
  },
];

/**
 * What the error `raw` of a turn of `provider` means and what to do about it; null for an error
 * this does not recognize, which the chat then shows as it came.
 */
export function explainError(raw: string, provider: Provider): ErrorExplanation | null {
  return KINDS.find((kind) => kind.test.test(raw))?.explain(provider) ?? null;
}
