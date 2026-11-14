import type { Provider } from "./models";

/** The permission modes: what each is called (`short` where room is tight) and what it lets the agent do. */
export const PERMISSION_MODES = {
  ask: {
    label: "Ask for approval",
    short: "Ask",
    description: "Work in the workspace freely; ask before commands and anything outside it.",
  },
  autoReview: {
    label: "Approve for me",
    short: "Auto",
    description: "Codex reviews eligible requests for extra access.",
  },
  fullAccess: {
    label: "Full access",
    short: "Full",
    description: "Run commands and change files anywhere without asking.",
  },
  custom: { label: "Custom", short: "Custom", description: "Use your existing Codex configuration." },
} as const;
export type PermissionMode = keyof typeof PERMISSION_MODES;
export type PermissionModes = Record<Provider, PermissionMode>;
export const DEFAULT_PERMISSION_MODES: PermissionModes = { claude: "ask", codex: "ask", copilot: "ask" };
export type ApprovalDecision = "accept" | "acceptForSession" | "decline";
export interface Approval {
  id: string;
  title: string;
  reason: string | null;
  details: string;
  acceptLabel: string;
  decisions: ApprovalDecision[];
  /** What allowing for the session covers from here on, in words, commands between backticks; absent when the agent did not say. */
  sessionScope?: string;
}

/** What the buttons that allow a request for the rest of the chat, and that deny it, say; allowing once is named by the request (`acceptLabel`). */
export const ALLOW_IN_CHAT = "Always allow in this chat";
export const DENY = "Deny";

/** An approval as the chat keeps it: the request, where it stands, and how the user answered it. */
export interface ApprovalState {
  approval: Approval;
  status: "pending" | "resolved" | "expired";
  /** The user's answer; absent while there is none, and in chats saved before it was kept. */
  decision?: ApprovalDecision;
}

/**
 * What became of a request that no longer waits, in a few words before its title: "Allowed
 * once", "Always allowed in this chat", "Denied". One that the turn left unanswered says so; one
 * settled without the user's answer being known (an older chat, or the agent settled it) is "Answered".
 */
export function approvalOutcome(state: ApprovalState): string {
  switch (state.decision) {
    case "accept":
      // "Allow once" was allowed once, "Allow for this turn" for this turn.
      return state.approval.acceptLabel.replace(/^Allow\b/, "Allowed");
    case "acceptForSession":
      return "Always allowed in this chat";
    case "decline":
      return "Denied";
    default:
      return state.status === "expired" ? "Not answered" : "Answered";
  }
}

/** What allowing a request for the rest of the chat covers, as a sentence; commands in it stand between backticks. */
export function sessionScopeLine(approval: Approval): string {
  const covered = approval.sessionScope ?? "requests like this one";
  return `"${ALLOW_IN_CHAT}" covers ${covered}, until you start a new chat.`;
}
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && Object.hasOwn(PERMISSION_MODES, value);
}

/** The modes each provider offered when last asked, by provider and workspace folder. */
const knownModes = new Map<string, PermissionMode[]>();
const modesKey = (provider: Provider, workspace: string) => `${provider}\n${workspace}`;

/** The modes `provider` offered in `workspace` when last asked; null when it was never asked. */
export function rememberedModes(provider: Provider, workspace: string): PermissionMode[] | null {
  return knownModes.get(modesKey(provider, workspace)) ?? null;
}

/** Keeps what `provider` offers in `workspace`, to show at once the next time. */
export function rememberModes(provider: Provider, workspace: string, modes: PermissionMode[]) {
  knownModes.set(modesKey(provider, workspace), modes);
}

/** Forgets what every provider offered. */
export function forgetModes() {
  knownModes.clear();
}
