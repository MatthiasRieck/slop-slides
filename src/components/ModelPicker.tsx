import { AlertTriangle, Check, ChevronDown, Gauge, RotateCw, Settings, Star } from "lucide-react";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandLoading,
  CommandShortcut,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatKeys, isMod } from "../lib/keys";
import { memoizeLast } from "../lib/memo";
import {
  contextWindowLabel,
  effortLabel,
  modelKey,
  PROVIDER_IDS,
  PROVIDERS,
  type Provider,
  type ProviderInfo,
  type ProviderModel,
} from "../lib/models";
import { cn } from "../lib/utils";
import { chatProvider, openSettings, useApp } from "../store";
import { InstallHint } from "./chat/InstallHint";
import { ProviderIcon } from "./ProviderIcon";

type Filter = "favorites" | Provider;

type Row = ProviderModel & { provider: Provider };

/** A picker of the composer's footer: a quiet button that names what is picked. */
const TRIGGER = "h-7 gap-1.5 rounded-md px-1.5 text-xs font-normal text-muted-foreground";

/** A tab of the model menu's rail: an agent's mark (or the star of the favorites), square. */
const RAIL_TAB =
  "size-8 flex-none justify-center p-0 group-data-vertical/tabs:w-8 group-data-vertical/tabs:justify-center disabled:pointer-events-auto disabled:cursor-not-allowed aria-disabled:pointer-events-auto aria-disabled:cursor-not-allowed data-active:bg-muted";

/**
 * The model the next message goes to, in the composer's footer: pressed, it opens the models
 * of every agent to search and pick from, with the keyboard in the search field.
 */
export function ModelPicker() {
  const selection = useApp((s) => s.selection);
  const [open, setOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const close = useMemo(() => () => setOpen(false), []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={selection.label}
            tooltip={selection.label}
            className={cn(TRIGGER, "max-w-full min-w-0 shrink justify-start")}
          />
        }
      >
        <ProviderIcon provider={selection.provider} className="size-3.5 shrink-0" />
        {/* The name always shows, cut short as room runs out; effort and permissions give way first, and the
            chevrons come only with room to spare (22rem), or they would take the name's. */}
        <span className="truncate font-medium text-foreground/90">{selection.label}</span>
        <ChevronDown className="hidden size-3 shrink-0 opacity-60 @[22rem]:block" />
      </PopoverTrigger>
      <PopoverContent
        aria-label="Models"
        side="top"
        align="start"
        initialFocus={search}
        className="w-[352px] gap-0 overflow-hidden p-0"
      >
        <ModelMenu search={search} onClose={close} />
      </PopoverContent>
    </Popover>
  );
}

function ModelMenu({ search, onClose }: { search: RefObject<HTMLInputElement | null>; onClose: () => void }) {
  const selection = useApp((s) => s.selection);
  const locked = useApp(chatProvider);
  const favorites = useApp((s) => s.favoriteModels);
  const providers = useApp((s) => s.providers);
  // A provider turned off in the settings is not offered: neither its tab nor its models.
  const enabled = useApp((s) => s.settings.providers);
  const [filter, setFilter] = useState<Filter>(selection.provider);
  const [query, setQuery] = useState("");
  /** The model the keyboard is on, by its key. */
  const [active, setActive] = useState("");

  const info = (provider: Provider) => providers?.find((p) => p.id === provider);

  const allRows = useMemo<Row[]>(
    () =>
      (providers ?? [])
        .filter((p) => enabled[p.id].enabled && (!locked || p.id === locked))
        .flatMap((p) => p.models.map((m) => ({ ...m, provider: p.id }))),
    [providers, locked, enabled],
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
    const chosen = rows.find((m) => m.provider === selection.provider && m.id === selection.model) ?? rows[0];
    setActive(chosen ? modelKey(chosen.provider, chosen.id) : "");
  }, [rows]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    useApp.getState().setModel(row.provider, row.id);
    onClose();
  };

  // The arrows and Enter are the list's own; the first nine models also have a key each.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isMod(e) && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      choose(rows[Number(e.key) - 1]);
    }
  };

  const rail: { id: Filter; title: string; blocked: boolean; icon: React.ReactNode }[] = [
    { id: "favorites", title: "Favorites", blocked: false, icon: <Star /> },
    ...PROVIDER_IDS.filter((p) => enabled[p].enabled).map((p) => {
      const missing = info(p)?.installed === false;
      return {
        id: p,
        title: missing ? `${PROVIDERS[p].cli} is not installed` : PROVIDERS[p].label,
        blocked: !!locked && p !== locked,
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
  // The menu opens on the selected provider, tab or none: one that is off (the chat is its own) says so.
  const turnedOff = !query && filter !== "favorites" && !enabled[filter].enabled ? filter : null;

  return (
    <Tabs
      orientation="vertical"
      // While searching, the models of every agent show: no tab is the one on show.
      value={query ? null : filter}
      onValueChange={(value) => {
        setFilter(value as Filter);
        setQuery("");
      }}
      className="min-h-0 w-full gap-0"
    >
      <TabsList
        variant="line"
        aria-label="Agents"
        className="w-12 shrink-0 justify-start gap-1 self-stretch border-r py-2 group-data-vertical/tabs:h-auto"
      >
        {rail.map((item) => {
          const tab = { value: item.id, "aria-label": item.title, className: RAIL_TAB };
          // A tab that cannot be picked says why to the pointer resting on it; the others say what they are.
          return item.blocked ? (
            <TabsTrigger key={item.id} {...tab} disabled title="Start a new chat to change provider">
              {item.icon}
            </TabsTrigger>
          ) : (
            <Tooltip key={item.id}>
              <TooltipTrigger render={<TabsTrigger {...tab} />}>{item.icon}</TooltipTrigger>
              <TooltipContent side="left">{item.title}</TooltipContent>
            </Tooltip>
          );
        })}
      </TabsList>
      {/* The models are searched here, as written (by name, id or agent), and listed in the agent's order. */}
      <Command
        shouldFilter={false}
        // Names the search field, which is what the keyboard is in.
        label="Search models"
        value={active}
        onValueChange={setActive}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 rounded-none!"
      >
        {locked && (
          <p className="shrink-0 border-b px-2 pt-1 pb-2 text-xs text-muted-foreground">
            Start a new chat to change provider.
          </p>
        )}
        <CommandInput ref={search} value={query} onValueChange={setQuery} placeholder="Search models..." />
        <CommandList label="Models" className="mt-1">
          {providers === undefined ? (
            <CommandLoading label="Looking for installed agents" className="justify-center px-2 py-8">
              Looking for installed agents…
            </CommandLoading>
          ) : turnedOff ? (
            <TurnedOff provider={turnedOff} onClose={onClose} />
          ) : status && status.models.length === 0 ? (
            <ProviderStatus info={status} onClose={onClose} />
          ) : rows.length === 0 ? (
            <CommandEmpty className="px-2 py-8 text-xs text-muted-foreground">
              {filter === "favorites" && !query ? "Star a model to pin it here." : "No models match."}
            </CommandEmpty>
          ) : (
            rows.map((row, index) => {
              const key = modelKey(row.provider, row.id);
              const isFavorite = favorites.includes(key);
              const chosen = row.provider === selection.provider && row.id === selection.model;
              return (
                <CommandItem
                  key={key}
                  value={key}
                  onSelect={() => choose(row)}
                  aria-current={chosen || undefined}
                  className="rounded-lg px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-sm text-foreground">
                      <span className="truncate">{row.label}</span>
                      {row.isDefault && (
                        <Badge
                          variant="outline"
                          className="h-4 rounded-sm border-primary/40 bg-primary/10 px-1 text-[0.625rem] font-semibold text-primary"
                        >
                          DEFAULT
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-2xs text-muted-foreground">
                      <ProviderIcon provider={row.provider} className="size-3" />
                      {PROVIDERS[row.provider].label}
                    </div>
                  </div>
                  {/* What ends a row: that it is the model picked, its key, and its star. */}
                  <CommandShortcut className="flex items-center gap-2 tracking-normal">
                    {chosen && <Check className="size-3.5 text-primary" />}
                    {index < 9 && <Kbd className="bg-transparent px-0">{formatKeys(`mod+${index + 1}`)}</Kbd>}
                    <Button
                      variant="ghost"
                      size="icon-2xs"
                      tooltip={isFavorite ? "Remove from favorites" : "Add to favorites"}
                      aria-pressed={isFavorite}
                      onClick={(e) => {
                        e.stopPropagation();
                        useApp.getState().toggleFavoriteModel(key);
                      }}
                      // Its own keys press it: the list would take Enter for picking the model the keyboard is on.
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
                      }}
                      className={cn(
                        "text-muted-foreground/60 aria-pressed:bg-transparent",
                        isFavorite && "text-warning aria-pressed:text-warning hover:text-warning/80",
                      )}
                    >
                      <Star className={cn("size-3.5", isFavorite && "fill-current")} />
                    </Button>
                  </CommandShortcut>
                </CommandItem>
              );
            })
          )}
        </CommandList>
      </Command>
    </Tabs>
  );
}

/** In place of the models of a provider the settings have turned off: that it is, and the way to turn it on. */
function TurnedOff({ provider, onClose }: { provider: Provider; onClose: () => void }) {
  return (
    <Empty className="gap-2 px-4 py-6">
      <EmptyHeader>
        <EmptyMedia>
          <ProviderIcon provider={provider} className="size-6 opacity-40 grayscale" />
        </EmptyMedia>
        <EmptyTitle className="font-normal">{PROVIDERS[provider].cli} is turned off</EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        <OpenProviders onClose={onClose} />
      </EmptyContent>
    </Empty>
  );
}

/** Opens the settings on the providers, where each agent's state is told in full, closing the menu. */
function OpenProviders({ onClose }: { onClose: () => void }) {
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => {
        onClose();
        openSettings("providers");
      }}
    >
      <Settings data-icon="inline-start" />
      Open Providers
    </Button>
  );
}

function ProviderStatus({ info, onClose }: { info: ProviderInfo; onClose: () => void }) {
  const { cli, install } = PROVIDERS[info.id];
  return (
    <Empty className="gap-2 px-4 py-6">
      <EmptyHeader>
        <EmptyMedia>
          <ProviderIcon provider={info.id} className="size-6 opacity-40 grayscale" />
        </EmptyMedia>
        {info.installed ? (
          <>
            <EmptyTitle className="flex items-center gap-1.5 font-normal">
              <AlertTriangle className="size-3.5 text-warning" />
              Could not list {cli} models
            </EmptyTitle>
            <EmptyDescription className="selectable text-xs">{info.error}</EmptyDescription>
          </>
        ) : (
          <>
            <EmptyTitle className="font-normal">{cli} is not installed</EmptyTitle>
            <EmptyDescription className="text-xs">
              <InstallHint text={install} />
            </EmptyDescription>
          </>
        )}
      </EmptyHeader>
      <EmptyContent className="flex-row flex-wrap justify-center gap-1.5">
        <Button variant="outline" size="xs" onClick={() => void useApp.getState().refreshProviders()}>
          <RotateCw data-icon="inline-start" />
          Check again
        </Button>
        <OpenProviders onClose={onClose} />
      </EmptyContent>
    </Empty>
  );
}

/**
 * What a provider says of one of its models. Asked on every update of the store, a word of the
 * agent's included; looked up only when the providers or the selection changed.
 */
const modelOf = memoizeLast((providers: ProviderInfo[] | undefined, provider: Provider, model: string) =>
  providers?.find((p) => p.id === provider)?.models.find((m) => m.id === model),
);

/** Reasoning effort and context window for the selected model, like T3 Code's traits menu. */
export function EffortPicker() {
  const selection = useApp((s) => s.selection);
  const model = useApp((s) => modelOf(s.providers, s.selection.provider, s.selection.model));
  const efforts = model?.efforts ?? [];
  const contextWindows = model?.contextWindows ?? [];
  if (efforts.length === 0 && contextWindows.length === 0) return null;

  const showContextWindow = contextWindows.length > 0 && selection.contextWindow !== null;
  const label = [
    efforts.length > 0 ? effortLabel(selection.effort) : null,
    showContextWindow ? contextWindowLabel(selection.contextWindow!) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const sections = [
    {
      title: "Effort",
      options: efforts.map((id) => ({ id, label: effortLabel(id) })),
      current: selection.effort,
      choose: (id: string) => useApp.getState().setEffort(id),
    },
    {
      title: "Context Window",
      options: contextWindows.map((id) => ({ id, label: contextWindowLabel(id) })),
      current: selection.contextWindow,
      choose: (id: string) => useApp.getState().setContextWindow(id),
    },
  ].filter((section) => section.options.length > 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={label}
            tooltip={showContextWindow ? "Reasoning effort and context window" : "Reasoning effort"}
            className={cn(TRIGGER, "shrink-0")}
          />
        }
      >
        <Gauge className="size-3.5 @[26rem]:hidden" />
        <span className="hidden @[26rem]:inline">{label}</span>
        <ChevronDown className="hidden size-3 shrink-0 opacity-60 @[22rem]:block" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" className="min-w-40">
        {sections.map((section, index) => (
          <DropdownMenuGroup key={section.title}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{section.title}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={section.current} onValueChange={(id) => section.choose(id as string)}>
              {section.options.map((option) => (
                // Picking one is all the menu is for: it closes, as a menu of plain items does.
                <DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
