import { listen } from "@tauri-apps/api/event";
import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { type AgentEventEnvelope, api, errorMessage } from "../../lib/api";
import { PROVIDER_IDS, PROVIDERS, type Provider, type ProviderInfo } from "../../lib/models";
import type { EnvironmentCheck } from "../../lib/settings";
import { cn } from "../../lib/utils";
import { chatProvider, useApp } from "../../store";
import { Button } from "../Button";
import { InstallHint } from "../chat/InstallHint";
import { ProviderIcon } from "../ProviderIcon";
import { Switch } from "../Switch";
import { SettingsGroup } from "./parts";
import { providerStatus, type StatusTone, TONE_DOT } from "./providerStatus";

/** What the Environment block calls each thing it checks. */
const ENVIRONMENT_LABELS: Record<EnvironmentCheck["id"], string> = {
  git: "git",
  mcpConfig: "MCP servers (~/.slopslides/mcp.json)",
};

/** Why a provider that is on cannot be turned off just now; null when it can. */
export function lockReason(provider: Provider, enabledCount: number, busy: boolean): string | null {
  if (busy) return `${PROVIDERS[provider].cli} is working in a chat. Stop it or wait for it to finish.`;
  if (enabledCount <= 1) return "At least one provider has to stay on.";
  return null;
}

/**
 * The settings' Providers section: the agents the app can work with (Claude Code, Codex, GitHub
 * Copilot), each with what a check of the computer found (its version, where it is, whether it is
 * installed and signed in) and a switch that takes it out of the model picker. Under them, what
 * the agents need from the computer. The check is local, asks no model anything, and runs as the
 * section opens and on "Check again"; a provider that is off is checked all the same. Which
 * providers are at work is asked again as a turn ends, in this window or another, so a switch
 * is locked for no longer than its provider works.
 */
export function ProvidersSection() {
  const providers = useApp((s) => s.providers);
  const enabled = useApp((s) => s.settings.providers);
  // The chat of this window; those of the others are the backend's to tell (`busy`).
  const working = useApp((s) => (s.running ? chatProvider(s) : null));
  const [busy, setBusy] = useState<Provider[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentCheck[] | string | null>(null);
  const [checking, setChecking] = useState(true);
  const gone = useRef(false);
  /** The latest question of who is busy: an answer to an earlier one is out of date. */
  const asked = useRef(0);

  const refreshBusy = useCallback(async () => {
    const mine = ++asked.current;
    const nowBusy = await loadBusy();
    if (!gone.current && mine === asked.current) setBusy(nowBusy);
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    const [, , found] = await Promise.all([
      // A check that fails leaves what was known on show.
      Promise.resolve()
        .then(() => useApp.getState().refreshProviders({ quiet: true }))
        .catch(() => {}),
      refreshBusy(),
      Promise.resolve()
        .then(api.checkEnvironment)
        .then(
          (checks) => (Array.isArray(checks) ? checks : []),
          (error) => errorMessage(error),
        ),
    ]);
    if (gone.current) return;
    setEnvironment(found);
    setChecking(false);
  }, [refreshBusy]);

  useEffect(() => {
    gone.current = false;
    void check();
    return () => {
      gone.current = true;
    };
  }, [check]);

  // A turn that ends frees its provider: this window's shows in `working`, and the backend tells
  // every window of each one's end.
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current === working) return;
    wasWorking.current = working;
    void refreshBusy();
  }, [working, refreshBusy]);
  useEffect(() => {
    let stopped = false;
    let unlisten: (() => void) | undefined;
    // No backend to listen to (the browser preview): the check and "Check again" still ask.
    Promise.resolve()
      .then(() =>
        listen<AgentEventEnvelope>("agent-event", ({ payload }) => {
          if (payload.event.type === "finished") void refreshBusy();
        }),
      )
      .then(
        (stop) => {
          if (stopped) stop();
          else unlisten = stop;
        },
        () => {},
      );
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [refreshBusy]);

  const enabledCount = PROVIDER_IDS.filter((id) => enabled[id].enabled).length;

  const toggle = async (provider: Provider, on: boolean) => {
    await useApp.getState().updateSettings({ providers: { [provider]: { enabled: on } } });
    // Refused, it may be for a chat in another window that started since the check.
    await refreshBusy();
  };

  return (
    <div data-testid="providers-section" className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          The agents that can answer in the chat. One that is turned off leaves the model picker; its chats stay
          readable.
        </p>
        <Button busy={checking} onClick={() => void check()} className="shrink-0">
          {!checking && <RotateCw />}
          Check again
        </Button>
      </div>
      <SettingsGroup>
        {PROVIDER_IDS.map((id) => (
          <ProviderRow
            key={id}
            provider={id}
            info={providers?.find((p) => p.id === id)}
            checking={checking}
            on={enabled[id].enabled}
            locked={enabled[id].enabled ? lockReason(id, enabledCount, working === id || busy.includes(id)) : null}
            onToggle={(on) => void toggle(id, on)}
          />
        ))}
      </SettingsGroup>
      <SettingsGroup title="Environment">
        {typeof environment === "string" ? (
          <div className="px-4 py-3">
            <StatusLine tone="destructive" headline="Could not check" detail={environment} />
          </div>
        ) : environment === null ? (
          <div className="px-4 py-3">
            <StatusLine tone="muted" headline="Checking…" detail={null} />
          </div>
        ) : (
          environment.map((item) => (
            <div key={item.id} data-testid={`environment-${item.id}`} className="px-4 py-3">
              <StatusLine
                tone={item.ok ? "success" : "destructive"}
                headline={ENVIRONMENT_LABELS[item.id] ?? item.id}
                detail={item.detail}
              />
            </div>
          ))
        )}
      </SettingsGroup>
    </div>
  );
}

/** The providers with a turn running, in any window; none when the backend does not say. */
async function loadBusy(): Promise<Provider[]> {
  try {
    const busy = await api.busyProviders();
    return Array.isArray(busy) ? busy : [];
  } catch {
    return [];
  }
}

/** One provider: what it is, what the check found, and its switch, with why the switch is locked when it is. */
function ProviderRow(props: {
  provider: Provider;
  info: ProviderInfo | undefined;
  checking: boolean;
  on: boolean;
  locked: string | null;
  onToggle: (on: boolean) => void;
}) {
  const { provider, info, on, locked } = props;
  const { cli } = PROVIDERS[provider];
  const status = providerStatus(info, props.checking);
  return (
    <div data-testid={`provider-${provider}`} data-enabled={on} className="flex gap-3 px-4 py-3.5">
      <ProviderIcon provider={provider} className={cn("mt-0.5 size-5 shrink-0", !on && "opacity-40 grayscale")} />
      {/* A provider that is off is dimmed, its switch aside: that is how it comes back. */}
      <div className={cn("flex min-w-0 flex-1 flex-col gap-1.5", !on && "opacity-60")}>
        <div className="flex items-baseline gap-2">
          <h4 className="text-sm font-medium">{cli}</h4>
          {info?.version && (
            <span data-testid="provider-version" className="selectable font-mono text-2xs text-muted-foreground">
              {info.version}
            </span>
          )}
          {!on && <span className="text-2xs text-muted-foreground">Turned off</span>}
        </div>
        {info?.path && (
          <span
            data-testid="provider-path"
            title={info.path}
            className="selectable truncate font-mono text-2xs text-muted-foreground"
          >
            {info.path}
          </span>
        )}
        <StatusLine tone={status.tone} headline={status.headline} detail={status.detail} />
        {status.hint && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            <InstallHint text={status.hint} />
          </p>
        )}
      </div>
      <div className="flex w-40 shrink-0 flex-col items-end gap-1.5">
        <Switch
          checked={on}
          label={cli}
          disabled={locked !== null}
          aria-describedby={locked ? `provider-lock-${provider}` : undefined}
          onChange={props.onToggle}
        />
        {locked && (
          <p id={`provider-lock-${provider}`} className="text-right text-2xs leading-snug text-muted-foreground">
            {locked}
          </p>
        )}
      </div>
    </div>
  );
}

/** A status: a dot in the colour of its tone, what it is, and a line of detail under it. */
function StatusLine({ tone, headline, detail }: { tone: StatusTone; headline: string; detail: string | null }) {
  return (
    <div className="flex gap-2 text-xs">
      <span aria-hidden="true" data-tone={tone} className={cn("mt-1 size-2 shrink-0 rounded-full", TONE_DOT[tone])} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{headline}</span>
        {detail && <span className="selectable break-words text-muted-foreground">{detail}</span>}
      </div>
    </div>
  );
}
