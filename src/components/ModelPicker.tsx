import { AlertTriangle, Check, Gauge, Loader2, RotateCw, Search, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { contextPercent, formatCost, formatTokens, windowTokens } from "../lib/context";
import { memoizeLast } from "../lib/memo";
import {
  contextWindowHint,
  contextWindowLabel,
  effortHint,
  effortLabel,
  modelKey,
  PROVIDER_IDS,
  PROVIDERS,
  type Provider,
  type ProviderInfo,
  type ProviderModel,
  shortEffortLabel,
  shortModelLabel,
} from "../lib/models";
import { cn } from "../lib/utils";
import { chatProvider, useApp } from "../store";
import { chatContext, chatCost } from "../store/messages";
import { InstallHint } from "./chat/InstallHint";
import { Popover } from "./Popover";
import { ProviderIcon } from "./ProviderIcon";

type Filter = "favorites" | Provider;

type Row = ProviderModel & { provider: Provider };

const triggerClass =
  "flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground";

/**
 * The model that answers, in the composer's footer: its provider's icon and its name without the
 * provider's ("Opus 5.5"), which fits beside effort and permissions at the sidebar's normal
 * width. It also opens when the app asks for it (see `openModelPicker`).
 */
export function ModelPicker() {
  const selection = useApp((s) => s.selection);
  const ask = useApp((s) => s.modelPickerAsk);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => setOpen(false), []);
  const asked = useRef(ask);
  useEffect(() => {
    if (ask === asked.current) return;
    asked.current = ask;
    setOpen(true);
  }, [ask]);

  return (
    <div ref={rootRef} className="relative min-w-0 shrink">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`Model: ${selection.label}`}
        aria-label={selection.label}
        className={cn(triggerClass, "max-w-full")}
      >
        <ProviderIcon provider={selection.provider} className="size-3.5 shrink-0" />
        {/* Cut short only when even the short name has no room: effort and permissions give way first. */}
        <span className="truncate font-medium text-foreground/90">
          {shortModelLabel(selection.provider, selection.label)}
        </span>
      </button>
      {open && (
        <Popover
          anchor={rootRef}
          onClose={close}
          width={352}
          variant="menu"
          portal
          follow
          className="flex overflow-hidden"
        >
          <ModelMenu onClose={close} />
        </Popover>
      )}
    </div>
  );
}

function ModelMenu({ onClose }: { onClose: () => void }) {
  const selection = useApp((s) => s.selection);
  const locked = useApp(chatProvider);
  const favorites = useApp((s) => s.favoriteModels);
  const providers = useApp((s) => s.providers);
  const [filter, setFilter] = useState<Filter>(selection.provider);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const info = (provider: Provider) => providers?.find((p) => p.id === provider);

  const allRows = useMemo<Row[]>(
    () =>
      (providers ?? [])
        .filter((p) => !locked || p.id === locked)
        .flatMap((p) => p.models.map((m) => ({ ...m, provider: p.id }))),
    [providers, locked],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return allRows.filter((m) => `${m.label} ${m.id} ${PROVIDERS[m.provider].label}`.toLowerCase().includes(q));
    }
    if (filter === "favorites") return allRows.filter((m) => favorites.includes(modelKey(m.provider, m.id)));
    return allRows.filter((m) => m.provider === filter);
  }, [allRows, filter, query, favorites]);

  // Start on the selected model whenever the list changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the list changes, not on every selection
  useEffect(() => {
    const index = rows.findIndex((m) => m.provider === selection.provider && m.id === selection.model);
    setActive(Math.max(0, index));
  }, [rows]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    useApp.getState().setModel(row.provider, row.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(rows.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(rows[active]);
    }
  };

  const rail: { id: Filter; title: string; icon: React.ReactNode }[] = [
    { id: "favorites", title: "Favorites", icon: <Star className="size-4" /> },
    ...PROVIDER_IDS.map((p) => {
      const missing = info(p)?.installed === false;
      return {
        id: p,
        title: missing ? `${PROVIDERS[p].cli} is not installed` : PROVIDERS[p].label,
        icon: (
          <span className="relative">
            <ProviderIcon provider={p} className={cn("size-4", missing && "opacity-40 grayscale")} />
            {missing && (
              <span className="absolute -right-1 -bottom-1 size-2 rounded-full border border-card bg-muted-foreground" />
            )}
          </span>
        ),
      };
    }),
  ];

  // A provider tab that has no models to show explains why instead.
  const status = !query && filter !== "favorites" ? info(filter) : undefined;

  return (
    <div className="flex min-h-0 w-full">
      <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r py-2">
        {rail.map((item) => {
          const selected = !query && filter === item.id;
          return (
            <button
              key={item.id}
              type="button"
              disabled={!!locked && item.id !== "favorites" && item.id !== locked}
              title={
                locked && item.id !== "favorites" && item.id !== locked
                  ? "Start a new chat to change provider"
                  : item.title
              }
              onClick={() => {
                setFilter(item.id);
                setQuery("");
              }}
              className={cn(
                "relative flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed",
                selected && "bg-accent text-foreground",
              )}
            >
              {selected && <span className="absolute -left-2 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />}
              {item.icon}
            </button>
          );
        })}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {locked && (
          <p className="shrink-0 border-b px-3 py-2 text-xs text-muted-foreground">
            Start a new chat to change provider.
          </p>
        )}
        <label className="flex shrink-0 items-center gap-2 border-b px-3 focus-within:border-primary">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            aria-label="Search models"
            onKeyDown={onKeyDown}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models..."
            className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
          />
        </label>
        <div ref={listRef} className="max-h-72 min-h-0 overflow-y-auto p-1.5">
          {providers === undefined ? (
            <p className="flex items-center justify-center gap-2 px-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Looking for installed agents…
            </p>
          ) : status && status.models.length === 0 ? (
            <ProviderStatus info={status} />
          ) : rows.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">
              {filter === "favorites" && !query ? "Star a model to pin it here." : "No models match."}
            </p>
          ) : (
            rows.map((row, index) => {
              const key = modelKey(row.provider, row.id);
              const isFavorite = favorites.includes(key);
              return (
                <div
                  key={key}
                  data-index={index}
                  className={cn(
                    "group flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2",
                    index === active && "bg-accent",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => choose(row)}
                    onMouseMove={() => setActive(index)}
                    onFocus={() => setActive(index)}
                    aria-pressed={row.provider === selection.provider && row.id === selection.model}
                    className="min-w-0 flex-1 rounded text-left"
                  >
                    <div className="flex items-center gap-1.5 text-sm text-foreground">
                      <span className="truncate">{row.label}</span>
                      {row.isDefault && (
                        <span className="rounded border border-primary/40 bg-primary/10 px-1 text-[0.625rem] font-semibold leading-4 text-primary">
                          DEFAULT
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-2xs text-muted-foreground">
                      <ProviderIcon provider={row.provider} className="size-3" />
                      {PROVIDERS[row.provider].label}
                    </div>
                  </button>
                  {row.provider === selection.provider && row.id === selection.model && (
                    <Check className="size-3.5 shrink-0 text-primary" />
                  )}
                  <button
                    type="button"
                    title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                    onClick={(e) => {
                      e.stopPropagation();
                      useApp.getState().toggleFavoriteModel(key);
                    }}
                    className={cn(
                      "shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-foreground",
                      isFavorite && "text-warning hover:text-warning/80",
                    )}
                  >
                    <Star className={cn("size-3.5", isFavorite && "fill-current")} />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderStatus({ info }: { info: ProviderInfo }) {
  const { cli, install } = PROVIDERS[info.id];
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
      <ProviderIcon provider={info.id} className="size-6 opacity-40 grayscale" />
      {info.installed ? (
        <>
          <p className="flex items-center gap-1.5 text-sm text-foreground">
            <AlertTriangle className="size-3.5 text-warning" />
            Could not list {cli} models
          </p>
          <p className="selectable text-xs leading-relaxed text-muted-foreground">{info.error}</p>
        </>
      ) : (
        <>
          <p className="text-sm text-foreground">{cli} is not installed</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <InstallHint text={install} />
          </p>
        </>
      )}
      <button
        type="button"
        onClick={() => void useApp.getState().refreshProviders()}
        className="mt-1 flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <RotateCw className="size-3" />
        Check again
      </button>
    </div>
  );
}

/**
 * What a provider says of one of its models. Asked on every update of the store, a word of the
 * agent's included; looked up only when the providers or the selection changed.
 */
const modelOf = memoizeLast((providers: ProviderInfo[] | undefined, provider: Provider, model: string) =>
  providers?.find((p) => p.id === provider)?.models.find((m) => m.id === model),
);

/**
 * How long the agent thinks and how much of the chat it can keep in mind, for the selected model,
 * with a line on what each choice trades. Where room is short the effort is named in a few
 * letters ("Med"). The menu also says how full the chat is and what it cost so far, which the
 * chat itself only brings up once it gets full (see `ContextMeter`).
 */
export function EffortPicker() {
  const selection = useApp((s) => s.selection);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => setOpen(false), []);

  const model = useApp((s) => modelOf(s.providers, s.selection.provider, s.selection.model));
  const efforts = model?.efforts ?? [];
  const contextWindows = model?.contextWindows ?? [];
  if (efforts.length === 0 && contextWindows.length === 0) return null;

  const showContextWindow = contextWindows.length > 0 && selection.contextWindow !== null;
  const window = showContextWindow ? contextWindowLabel(selection.contextWindow!) : null;
  const label = [efforts.length > 0 ? effortLabel(selection.effort) : null, window].filter(Boolean).join(" · ");
  const short = efforts.length > 0 ? shortEffortLabel(selection.effort) : window;

  const sections = [
    {
      title: "Effort",
      about: "How long the agent thinks before it answers.",
      options: efforts.map((id) => ({ id, label: effortLabel(id), hint: effortHint(id) })),
      current: selection.effort,
      choose: (id: string) => useApp.getState().setEffort(id),
    },
    {
      title: "Context window",
      about: "How much of the chat the agent can keep in mind.",
      options: contextWindows.map((id) => ({ id, label: contextWindowLabel(id), hint: contextWindowHint(id) })),
      current: selection.contextWindow,
      choose: (id: string) => useApp.getState().setContextWindow(id),
    },
  ].filter((section) => section.options.length > 0);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        title={showContextWindow ? `Effort and context window: ${label}` : `Effort: ${label}`}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className={cn(triggerClass, "shrink-0")}
      >
        <Gauge className="size-3.5 shrink-0" />
        <span className="@[26rem]:hidden">{short}</span>
        <span className="hidden @[26rem]:inline">{label}</span>
      </button>
      {open && (
        <Popover anchor={rootRef} onClose={close} width={264} variant="menu" portal follow className="p-1.5">
          {sections.map((section, index) => (
            <div key={section.title} className={cn(index > 0 && "mt-1.5 border-t pt-1.5")}>
              <div className="px-2 pt-1 pb-1.5">
                <div className="text-2xs font-medium text-foreground">{section.title}</div>
                <div className="text-2xs text-muted-foreground">{section.about}</div>
              </div>
              {section.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={option.id === section.current}
                  onClick={() => {
                    section.choose(option.id);
                    close();
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                >
                  <span className="min-w-0">
                    <span className="block text-sm">{option.label}</span>
                    {option.hint && <span className="block text-2xs text-muted-foreground">{option.hint}</span>}
                  </span>
                  {option.id === section.current && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              ))}
            </div>
          ))}
          <ChatUsage className="mt-1.5 border-t px-2 pt-2 pb-1" />
        </Popover>
      )}
    </div>
  );
}

/**
 * How full the chat is and what it cost so far, in a line or two of small print; nothing until
 * the agent reported either. The cost is what the agent's provider says the turns would cost at
 * its API prices, which is not a bill for those on a plan: so it stays here, out of the replies.
 */
export function ChatUsage({ className }: { className?: string }) {
  const provider = useApp((s) => s.selection.provider);
  const selectedWindow = useApp((s) => s.selection.contextWindow);
  const context = useApp(chatContext);
  const cost = useApp(chatCost);
  if (!context && cost === null) return null;
  // Claude runs the next turn with the chosen window, which may differ from the last one.
  const window = (provider === "claude" && windowTokens(selectedWindow)) || (context?.window ?? null);
  const tokens = context?.tokens ?? null;
  const percent = contextPercent(tokens, window);
  return (
    <div data-testid="chat-usage" className={cn("flex flex-col gap-0.5 text-2xs text-muted-foreground", className)}>
      <div className="font-medium text-foreground">This chat</div>
      {context && (
        <div className="tabular-nums">
          {tokens === null
            ? "Compacted: its new size shows after the next message"
            : percent !== null && window
              ? `${Math.round(percent)}% full (${formatTokens(tokens)} of ${formatTokens(window)} tokens)`
              : `${formatTokens(tokens)} tokens`}
        </div>
      )}
      {cost !== null && (
        <div
          className="tabular-nums"
          title="What the turns of this chat would cost at the provider's API prices. On a subscription plan this is not what you pay."
        >
          About {formatCost(cost)} at API prices
        </div>
      )}
    </div>
  );
}
