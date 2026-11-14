import { Check, ChevronRight, Shield, ShieldAlert, ShieldX } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { codeSpans } from "../lib/codeSpans";
import { formatKeys } from "../lib/keys";
import { hasOpenLayer } from "../lib/layers";
import { PROVIDERS } from "../lib/models";
import {
  ALLOW_IN_CHAT,
  type ApprovalDecision,
  approvalOutcome,
  DENY,
  PERMISSION_MODES,
  type PermissionMode,
  rememberedModes,
  rememberModes,
  sessionScopeLine,
} from "../lib/permissions";
import { cn } from "../lib/utils";
import { type ChatPart, useApp } from "../store";
import { confirmAction } from "../store/confirm";
import { Button } from "./Button";
import { Popover } from "./Popover";

/** Marks the chat's message input, which an approval may take the keyboard focus from while it is empty. */
export const COMPOSER_INPUT_ATTR = "data-composer-input";

/**
 * The selected agent's permission mode, in the composer's footer. The usual mode (asking) is a
 * shield where room is short; any other is named, and Full access stands out by its color as the
 * one mode in which nothing is asked. The modes a provider offers are shown as last known and
 * asked for again in the background.
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
    if (
      next === "fullAccess" &&
      mode !== next &&
      !(await confirmAction({
        title: "Turn on Full access?",
        message: `${name} will be able to change files and run commands anywhere on this computer, also outside this folder, without asking you first.`,
        confirmLabel: "Turn on Full access",
        destructive: true,
      }))
    )
      return;
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
          "flex h-7 items-center gap-1 rounded-md px-1.5 text-xs hover:bg-accent aria-expanded:bg-accent disabled:opacity-40",
          full ? "font-medium text-warning" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {full ? <ShieldAlert className="size-3.5 shrink-0" /> : <Shield className="size-3.5 shrink-0" />}
        {/* Asking is the usual mode and needs no words where room is short; any other mode is named. */}
        <span className={cn("whitespace-nowrap", mode === "ask" ? "hidden @[26rem]:inline" : "@[26rem]:hidden")}>
          {mode === "ask" ? PERMISSION_MODES[mode].label : PERMISSION_MODES[mode].short}
        </span>
        {mode !== "ask" && (
          <span className="hidden whitespace-nowrap @[26rem]:inline">{PERMISSION_MODES[mode].label}</span>
        )}
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

type ApprovalPart = Extract<ChatPart, { kind: "approval" }>;

/**
 * The agent asking to be allowed something, in the transcript. While it waits it stands out and
 * is read out, and its accepting button takes the keyboard focus if that is on nothing else; only
 * a key pressed on the card itself answers it: Enter on a button, Escape anywhere on it to deny.
 * It says what allowing for the rest of the chat would cover. Stop, which ends the whole turn,
 * sits apart. Answered, it is one line that remembers how (see `ApprovalLine`).
 * Like the rest of a reply, it renders again only when its part is another.
 */
export const ApprovalCard = memo(function ApprovalCard({ part }: { part: ApprovalPart }) {
  const deckId = useApp((s) => s.chatKey);
  const running = useApp((s) => s.running);
  const [submitted, setSubmitted] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inside, setInside] = useState(false);
  const [onPrimary, setOnPrimary] = useState(false);
  const sending = useRef(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const active = part.status === "pending" && running && !submitted;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only as the request appears
  useEffect(() => {
    if (active && focusIsIdle()) primaryRef.current?.focus({ preventScroll: true });
  }, []);
  if (!active) return <ApprovalLine part={part} submitted={submitted} />;

  const respond = async (decision: ApprovalDecision) => {
    if (!deckId || sending.current) return;
    sending.current = true;
    setSubmitted(decision);
    setError(null);
    try {
      await api.respondApproval(deckId, part.approval.id, decision);
      // Kept with the chat: opened again, it still says how the request was answered.
      useApp.getState().approvalAnswered(part.approval.id, decision);
    } catch (e) {
      setError(errorMessage(e));
      setSubmitted(null);
    } finally {
      sending.current = false;
    }
  };
  const labels: Record<ApprovalDecision, string> = {
    accept: part.approval.acceptLabel,
    acceptForSession: ALLOW_IN_CHAT,
    decline: DENY,
  };
  const { decisions } = part.approval;
  const primary = decisions.includes("accept") ? "accept" : decisions.find((d) => d !== "decline");
  const canDeny = decisions.includes("decline");
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Escape on the card denies the request; the buttons do the same for the pointer
    <section
      className="rounded-lg border border-warning/60 bg-warning/5 p-3 text-xs"
      aria-label="Approval request"
      onFocus={() => setInside(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setInside(false);
      }}
      onKeyDown={(e) => {
        // What is open over the app (a menu) takes the key first; see lib/layers.ts.
        if (e.key !== "Escape" || !canDeny || hasOpenLayer()) return;
        e.preventDefault();
        e.stopPropagation();
        void respond("decline");
      }}
    >
      {/* Read out at once as it appears: the turn waits for the answer. */}
      <p role="status" aria-live="assertive" className="flex items-center gap-1.5 font-medium">
        <ShieldAlert className="size-3.5 text-warning" />
        {part.approval.title}
      </p>
      {part.approval.reason && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{part.approval.reason}</p>}
      <pre className="selectable my-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">
        {part.approval.details}
      </pre>
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
      {decisions.includes("acceptForSession") && (
        <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
          {codeSpans(sessionScopeLine(part.approval)).map((span, at) =>
            span.code ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the sentence is fixed
              <code key={at} className="rounded bg-foreground/10 px-1 py-0.5 font-mono text-foreground">
                {span.text}
              </code>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the sentence is fixed
              <Fragment key={at}>{span.text}</Fragment>
            ),
          )}
        </p>
      )}
      {/* The keys count only with the focus on the card, so they are named only then. */}
      {inside && (canDeny || (onPrimary && primary)) && (
        <p className="mt-1.5 text-2xs text-muted-foreground">
          {[
            onPrimary && primary && `${formatKeys("enter")} to ${labels[primary].toLowerCase()}`,
            canDeny && `${formatKeys("escape")} to deny`,
          ]
            .filter(Boolean)
            .join(" · ")}
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

/**
 * A request that no longer waits, as one line like a tool call's: what became of it ("Allowed
 * once", "Denied", "Not answered") and what it asked for; its reason and details unfold beneath.
 * `submitted` is the answer just given, until the chat has it on the part itself.
 */
function ApprovalLine({ part, submitted }: { part: ApprovalPart; submitted: ApprovalDecision | null }) {
  const [open, setOpen] = useState(false);
  // One still waiting when the turn is over was left unanswered.
  const status = part.status === "pending" ? "expired" : part.status;
  const outcome = approvalOutcome({ ...part, status, decision: part.decision ?? submitted ?? undefined });
  const denied = (part.decision ?? submitted) === "decline";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-1">
        <p
          aria-live="polite"
          title={outcome === "Not answered" ? "The turn ended before this request was answered" : undefined}
          className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
        >
          {denied ? <ShieldX className="size-3.5 shrink-0" /> : <Shield className="size-3.5 shrink-0" />}
          <span className="truncate">
            {outcome}: <span className="text-foreground/80">{part.approval.title}</span>
          </span>
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? "Hide" : "Show"} what was asked: ${part.approval.title}`}
          title={open ? "Hide what was asked" : "Show what was asked"}
          onClick={() => setOpen(!open)}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        </button>
      </div>
      {open && (
        <div className="selectable flex min-w-0 flex-col gap-2 rounded-lg border bg-muted/40 p-2.5 text-xs">
          {part.approval.reason && <p className="whitespace-pre-wrap text-muted-foreground">{part.approval.reason}</p>}
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-[0.95em] text-foreground/80">
            {part.approval.details}
          </pre>
        </div>
      )}
    </div>
  );
}

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
