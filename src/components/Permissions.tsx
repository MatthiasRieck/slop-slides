import { ask } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, Shield, ShieldAlert } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { formatKeys } from "../lib/keys";
import { PROVIDERS } from "../lib/models";
import {
  type ApprovalDecision,
  PERMISSION_MODES,
  type PermissionMode,
  rememberedModes,
  rememberModes,
} from "../lib/permissions";
import { cn } from "../lib/utils";
import { type ChatPart, useApp } from "../store";
import { Button } from "./Button";
import { Popover } from "./Popover";

/** Marks the chat's message input, which an approval may take the keyboard focus from while it is empty. */
export const COMPOSER_INPUT_ATTR = "data-composer-input";

/**
 * The selected agent's permission mode, in the composer's footer. Full access stands out, by its
 * color and its name, as the one mode in which nothing is asked. The modes a provider offers are
 * shown as last known and asked for again in the background.
 */
export function PermissionPicker() {
  const provider = useApp((s) => s.selection.provider);
  const deckId = useApp((s) => s.workspace?.path);
  const running = useApp((s) => s.running);
  const mode = useApp((s) => s.permissionModes[s.selection.provider]);
  const [open, setOpen] = useState(false);
  const [modes, setModes] = useState<PermissionMode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    // Asked when opened: Codex answers by starting its app-server.
    if (!open || !deckId) return;
    let active = true;
    const known = rememberedModes(provider, deckId);
    setModes(known ?? []);
    setError(null);
    void api
      .permissionModes(provider, deckId)
      .then((next) => {
        rememberModes(provider, deckId, next);
        if (active) setModes(next);
      })
      .catch((e) => {
        // What was known stays on show; only a first look that fails has nothing else to say.
        if (active && !known) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [open, provider, deckId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: close the menu when the provider changes
  useEffect(() => setOpen(false), [provider]);
  const name = PROVIDERS[provider].cli;
  const choose = async (next: PermissionMode) => {
    try {
      if (
        next === "fullAccess" &&
        mode !== next &&
        !(await ask(
          `${name} will be able to change files and run commands beyond the workspace without asking for approval.`,
          { title: "Enable Full access?", kind: "warning", okLabel: "Enable Full access", cancelLabel: "Cancel" },
        ))
      )
        return;
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    // Also changes the running turn's mode, if one runs.
    useApp.getState().setPermissionMode(next);
    setOpen(false);
  };
  const full = mode === "fullAccess";
  return (
    <div ref={root} className="min-w-0 shrink-0">
      <button
        type="button"
        aria-label="Permissions"
        title={`${name} permissions: ${PERMISSION_MODES[mode].label}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-7 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-accent disabled:opacity-40",
          full ? "font-medium text-warning" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {full ? <ShieldAlert className="size-3.5 shrink-0" /> : <Shield className="size-3.5 shrink-0" />}
        <span className={cn("whitespace-nowrap", !full && "hidden @[26rem]:inline")}>
          {PERMISSION_MODES[mode].label}
        </span>
        <ChevronDown className="hidden size-3 @[17rem]:block" />
      </button>
      {open && (
        <Popover anchor={root} onClose={close} width={256} variant="menu" portal follow className="p-1.5">
          <fieldset aria-label="Permission modes">
            {error ? (
              <p role="alert" className="p-2 text-xs text-destructive">
                {error}
              </p>
            ) : modes.length === 0 ? (
              <p className="p-2 text-xs text-muted-foreground">Checking {name} permissions…</p>
            ) : (
              modes.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => void choose(m)}
                  className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs hover:bg-accent aria-pressed:bg-accent"
                >
                  <span className="min-w-0 flex-1">
                    <span className={cn("font-medium", m === "fullAccess" && "text-warning")}>
                      {PERMISSION_MODES[m].label}
                    </span>
                    <span className="mt-0.5 block text-muted-foreground">{PERMISSION_MODES[m].description}</span>
                  </span>
                  {mode === m && <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-primary" />}
                </button>
              ))
            )}
            {running && provider === "codex" && modes.length > 0 && (
              <p className="p-2 text-xs text-muted-foreground">Codex applies a change from your next message.</p>
            )}
            {modes.length > 0 && !modes.includes(mode) && (
              <p role="alert" className="p-2 text-xs text-destructive">
                The saved mode is unavailable. Select another mode.
              </p>
            )}
          </fieldset>
        </Popover>
      )}
    </div>
  );
}

/** Whether the keyboard focus is on nothing the user is in the middle of: nowhere, or in the empty message input. */
function focusIsIdle(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body) return true;
  return el instanceof HTMLTextAreaElement && el.hasAttribute(COMPOSER_INPUT_ATTR) && el.value === "";
}

/**
 * The agent asking to be allowed something, in the transcript. While it waits it stands out and
 * is read out, and its accepting button takes the keyboard focus if that is on nothing else; only
 * a key pressed on the card itself answers it. Stop, which ends the whole turn, sits apart.
 * Like the rest of a reply, it renders again only when its part is another.
 */
export const ApprovalCard = memo(function ApprovalCard({ part }: { part: Extract<ChatPart, { kind: "approval" }> }) {
  const deckId = useApp((s) => s.chatKey);
  const running = useApp((s) => s.running);
  const [submitted, setSubmitted] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onPrimary, setOnPrimary] = useState(false);
  const sending = useRef(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const active = part.status === "pending" && running && !submitted;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only as the request appears
  useEffect(() => {
    if (active && focusIsIdle()) primaryRef.current?.focus({ preventScroll: true });
  }, []);
  const respond = async (decision: ApprovalDecision) => {
    if (!deckId || !active || sending.current) return;
    sending.current = true;
    setSubmitted(decision);
    setError(null);
    try {
      await api.respondApproval(deckId, part.approval.id, decision);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitted(null);
    } finally {
      sending.current = false;
    }
  };
  const labels: Record<ApprovalDecision, string> = {
    accept: part.approval.acceptLabel,
    acceptForSession: "Allow for session",
    decline: "Deny",
  };
  const { decisions } = part.approval;
  const primary = decisions.includes("accept") ? "accept" : decisions.find((d) => d !== "decline");
  return (
    <section
      className={cn("rounded-lg border p-3 text-xs", active && "border-warning/60 bg-warning/5")}
      aria-label="Approval request"
    >
      {/* Read out at once as it appears: the turn waits for the answer. */}
      <p
        role={active ? "status" : undefined}
        aria-live={active ? "assertive" : undefined}
        className="flex items-center gap-1.5 font-medium"
      >
        {active ? <ShieldAlert className="size-3.5 text-warning" /> : <Shield className="size-3.5" />}
        {part.approval.title}
      </p>
      {part.approval.reason && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{part.approval.reason}</p>}
      <pre className="selectable my-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">
        {part.approval.details}
      </pre>
      {active ? (
        <div className="flex flex-wrap items-center gap-2">
          {decisions.map((d) => (
            <Button
              key={d}
              ref={d === primary ? primaryRef : undefined}
              variant={d === primary ? "primary" : d === "decline" ? "ghost" : "outline"}
              size="xl"
              onFocus={d === primary ? () => setOnPrimary(true) : undefined}
              onBlur={d === primary ? () => setOnPrimary(false) : undefined}
              onClick={() => void respond(d)}
              className={cn(d === "decline" && "text-muted-foreground")}
            >
              {labels[d]}
            </Button>
          ))}
          {onPrimary && primary && (
            <span className="text-2xs text-muted-foreground">
              {formatKeys("enter")} to {labels[primary].toLowerCase()}
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            title="Stop the agent's turn"
            onClick={() => useApp.getState().interrupt()}
            className="rounded px-1 py-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Stop
          </button>
        </div>
      ) : (
        <p aria-live="polite" className="text-muted-foreground">
          {part.status === "expired" || (!running && !submitted)
            ? "Request closed"
            : submitted
              ? `${labels[submitted]} · response sent`
              : "Request resolved"}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}
    </section>
  );
});

/** What an automatic review of the agent's request came to. */
export const ApprovalReview = memo(function ApprovalReview(props: {
  part: Extract<ChatPart, { kind: "approvalReview" }>;
}) {
  const { part } = props;
  const status =
    (
      {
        inProgress: "Reviewing",
        reviewing: "Reviewing",
        approved: "Approved",
        denied: "Denied",
        aborted: "Aborted",
        timedOut: "Timed out",
      } as Record<string, string>
    )[part.status] ?? part.status;
  return (
    <div className="rounded-lg border p-2.5 text-xs" aria-live="polite">
      <p className="font-medium">Automatic review · {status}</p>
      {part.detail && <p className="mt-1 text-muted-foreground">{part.detail}</p>}
    </div>
  );
});
