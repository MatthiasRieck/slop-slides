import { ask } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Shield, ShieldAlert } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Kbd } from "@/components/ui/kbd";
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
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Permissions"
            tooltip={`${name} permissions: ${PERMISSION_MODES[mode].label}`}
            className={cn(
              "h-7 min-w-0 shrink-0 gap-1 rounded-md px-1.5 text-xs",
              full ? "font-medium text-warning hover:text-warning" : "font-normal text-muted-foreground",
            )}
          />
        }
      >
        {full ? <ShieldAlert className="size-3.5 shrink-0" /> : <Shield className="size-3.5 shrink-0" />}
        <span className={cn("whitespace-nowrap", !full && "hidden @[26rem]:inline")}>
          {PERMISSION_MODES[mode].label}
        </span>
        <ChevronDown className="hidden size-3 @[22rem]:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-64">
        {error ? (
          <p role="alert" className="p-2 text-xs text-destructive">
            {error}
          </p>
        ) : modes.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">Checking {name} permissions…</p>
        ) : (
          // The menu stays until the mode is set: full access is asked about first.
          <DropdownMenuRadioGroup
            aria-label="Permission modes"
            value={mode}
            onValueChange={(next) => void choose(next as PermissionMode)}
          >
            {modes.map((m) => (
              <DropdownMenuRadioItem key={m} value={m} className="items-start py-1.5 text-xs">
                <span className="min-w-0 flex-1">
                  <span className={cn("font-medium", m === "fullAccess" && "text-warning!")}>
                    {PERMISSION_MODES[m].label}
                  </span>
                  <span className="mt-0.5 block text-muted-foreground!">{PERMISSION_MODES[m].description}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
        {running && provider === "codex" && modes.length > 0 && (
          <p className="p-2 text-xs text-muted-foreground">Codex applies a change from your next message.</p>
        )}
        {modes.length > 0 && !modes.includes(mode) && (
          <p role="alert" className="p-2 text-xs text-destructive">
            The saved mode is unavailable. Select another mode.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
      <CodeBlock size="sm" className="selectable my-2">
        <CodeBlockContent wrap tabIndex={0} className="max-h-48 break-all">
          {part.approval.details}
        </CodeBlockContent>
      </CodeBlock>
      {active ? (
        <div className="flex flex-wrap items-center gap-2">
          {decisions.map((d) => (
            <Button
              key={d}
              ref={d === primary ? primaryRef : undefined}
              variant={d === primary ? "default" : d === "decline" ? "ghost" : "outline"}
              size="sm"
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
              <Kbd>{formatKeys("enter")}</Kbd> to {labels[primary].toLowerCase()}
            </span>
          )}
          <span className="flex-1" />
          <Button
            variant="link"
            size="xs"
            tooltip="Stop the agent's turn"
            onClick={() => useApp.getState().interrupt()}
            className="px-1 font-normal text-muted-foreground hover:text-foreground"
          >
            Stop
          </Button>
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
    <Item variant="outline" size="xs" aria-live="polite">
      <ItemContent>
        <ItemTitle className="text-xs">Automatic review · {status}</ItemTitle>
        {part.detail && <ItemDescription className="line-clamp-none">{part.detail}</ItemDescription>}
      </ItemContent>
    </Item>
  );
});
