import type { Provider } from "./models";

export const PERMISSION_MODES = {
  ask: { label: "Ask for approval", description: "Work in the workspace freely; ask before commands and anything outside it." },
  autoReview: { label: "Approve for me", description: "Codex reviews eligible requests for extra access." },
  fullAccess: { label: "Full access", description: "Run commands and change files anywhere without asking." },
  custom: { label: "Custom", description: "Use your existing Codex configuration." },
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
}
export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && Object.hasOwn(PERMISSION_MODES, value);
}
