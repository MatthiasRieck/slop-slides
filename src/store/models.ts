import { api } from "../lib/api";
import {
  defaultModel,
  PROVIDER_IDS,
  PROVIDERS,
  type Provider,
  type ProviderInfo,
  pickContextWindow,
  pickEffort,
  requestEffort,
} from "../lib/models";
import {
  DEFAULT_PERMISSION_MODES,
  isPermissionMode,
  type PermissionMode,
  type PermissionModes,
} from "../lib/permissions";
import { loadJson, loadText, saveJson } from "../lib/storage";
import { showErrorIn } from "./errors";
import type { AppState, AppStore, Slice } from "./types";

export interface ModelSelection {
  provider: Provider;
  model: string;
  /** Shown until the provider list arrives. */
  label: string;
  effort: string;
  /** Claude only; `null` when the model has a single context window. */
  contextWindow: string | null;
}

/** Which agent answers: the installed providers, the model picked, and each provider's permission mode. */
export interface ModelsSlice {
  selection: ModelSelection;
  /** Each provider's permission mode; the selected provider's applies to the next turn. */
  permissionModes: PermissionModes;
  /** `provider:model` keys starred in the model picker. */
  favoriteModels: string[];
  /** Installed agent CLIs and their models; `undefined` while loading. */
  providers: ProviderInfo[] | undefined;

  /** Sets the selected provider's mode, also for the turn running in the workspace. */
  setPermissionMode: (mode: PermissionMode) => void;
  setModel: (provider: Provider, model: string) => void;
  setEffort: (effort: string) => void;
  setContextWindow: (contextWindow: string) => void;
  /**
   * Looks for the installed agent CLIs and their models again. `quiet` keeps the list known so
   * far on show meanwhile, for a check nobody should have to watch.
   */
  refreshProviders: (options?: { quiet?: boolean }) => Promise<void>;
  toggleFavoriteModel: (key: string) => void;
}

const SELECTION_KEY = "slopslide.selection";
const FAVORITES_KEY = "slopslide.favoriteModels";
const PERMISSIONS_KEY = "slopslide.permissions";
/** Before every provider had permission modes, only Codex's was saved. */
const CODEX_PERMISSION_KEY = "slopslide.codexPermissions";

const DEFAULT_SELECTION: ModelSelection = {
  provider: "claude",
  model: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  effort: "medium",
  contextWindow: "1m",
};

function loadSelection(): ModelSelection {
  return loadJson(SELECTION_KEY, DEFAULT_SELECTION, (stored) => {
    const saved = stored as Partial<ModelSelection> | null;
    if (saved?.provider && saved.model && saved.label && saved.effort) {
      return { ...saved, contextWindow: saved.contextWindow ?? null } as ModelSelection;
    }
    return DEFAULT_SELECTION;
  });
}

function saveSelection(app: AppStore, selection: ModelSelection) {
  saveJson(SELECTION_KEY, selection);
  app.setState({ selection });
}

function loadPermissions(): PermissionModes {
  const modes = { ...DEFAULT_PERMISSION_MODES };
  const legacy = loadText(CODEX_PERMISSION_KEY);
  if (isPermissionMode(legacy)) modes.codex = legacy;
  return loadJson(PERMISSIONS_KEY, modes, (saved) => {
    if (saved && typeof saved === "object") {
      for (const provider of PROVIDER_IDS) {
        const mode = (saved as Record<string, unknown>)[provider];
        if (Object.hasOwn(saved, provider) && isPermissionMode(mode)) modes[provider] = mode;
      }
    }
    return modes;
  });
}

function loadFavorites(): string[] {
  return loadJson(FAVORITES_KEY, [], (saved) =>
    Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : [],
  );
}

/** Moves a selection that is no longer offered onto an installed provider's default model. */
export function reconcileSelection(
  selection: ModelSelection,
  providers: ProviderInfo[],
  locked = false,
): ModelSelection {
  const current = providers.find((p) => p.id === selection.provider);
  const model = current?.models.find((m) => m.id === selection.model);
  if (model) {
    return {
      ...selection,
      label: model.label,
      effort: pickEffort(model, selection.effort),
      contextWindow: pickContextWindow(model, selection.contextWindow),
    };
  }
  // A provider whose models could not be listed keeps the saved choice rather than losing it.
  if (current?.installed && current.error) return selection;
  const fallback = (locked ? [current] : [current, ...providers]).find((p) => p?.installed && p.models.length > 0);
  const next = fallback && defaultModel(fallback);
  if (!fallback || !next) return selection;
  return {
    provider: fallback.id,
    model: next.id,
    label: next.label,
    effort: pickEffort(next, selection.effort),
    contextWindow: pickContextWindow(next, null),
  };
}

/** Existing chats use their last provider; pre-provider histories were Claude chats. */
export function chatProvider(state: Pick<AppState, "messages" | "sessionProvider" | "selection">): Provider | null {
  if (state.sessionProvider) return state.sessionProvider;
  const reply = state.messages.findLast((m) => m.role === "assistant");
  if (reply?.role === "assistant") return reply.provider ?? "claude";
  return state.messages.length > 0 ? state.selection.provider : null;
}

/** Moves the selection onto the provider the chat is locked to (see `chatProvider`), if it is on another one. */
export function followChatProvider(app: AppStore) {
  const locked = chatProvider(app.getState());
  const { selection, providers } = app.getState();
  if (locked && locked !== selection.provider) {
    saveSelection(
      app,
      reconcileSelection(
        { ...selection, provider: locked, model: "", label: PROVIDERS[locked].label, contextWindow: null },
        providers ?? [],
        true,
      ),
    );
  }
}

/** How the next turn runs: the selected model, at an effort it takes, in its provider's permission mode. */
export function turnSettings({ selection, providers, permissionModes }: AppState) {
  const { provider, model, contextWindow } = selection;
  const info = providers?.find((p) => p.id === provider)?.models.find((m) => m.id === model);
  const effort = requestEffort(info, selection.effort);
  return { provider, model, effort, contextWindow, permissionMode: permissionModes[provider] };
}

export const createModelsSlice: Slice<ModelsSlice> = (set, get, app) => ({
  selection: loadSelection(),
  permissionModes: loadPermissions(),
  favoriteModels: loadFavorites(),
  providers: undefined,

  setPermissionMode: (mode) => {
    if (!isPermissionMode(mode)) return;
    const permissionModes = { ...get().permissionModes, [get().selection.provider]: mode };
    saveJson(PERMISSIONS_KEY, permissionModes);
    set({ permissionModes });
    // The provider cannot change during a turn, so the running turn is the selected provider's.
    const { running, chatKey } = get();
    if (running && chatKey) {
      api.setPermissionMode(chatKey, mode).catch((error) => showErrorIn(app, error));
    }
  },

  setModel: (provider, id) => {
    const locked = chatProvider(get());
    if (locked && provider !== locked) return;
    const model = get()
      .providers?.find((p) => p.id === provider)
      ?.models.find((m) => m.id === id);
    if (!model) return;
    const effort = pickEffort(model, get().selection.effort);
    // Each model starts on its own default window: 1M costs more on models where it is optional.
    const contextWindow = pickContextWindow(model, null);
    saveSelection(app, { provider, model: id, label: model.label, effort, contextWindow });
  },

  setEffort: (effort) => saveSelection(app, { ...get().selection, effort }),

  setContextWindow: (contextWindow) => saveSelection(app, { ...get().selection, contextWindow }),

  refreshProviders: async ({ quiet = false } = {}) => {
    if (!quiet) set({ providers: undefined });
    const result = await api.listProviders().catch(() => null);
    // A quiet check that failed leaves what was known.
    if (quiet && !Array.isArray(result)) return;
    const providers = Array.isArray(result) ? result : [];
    set({ providers });
    if (providers.length > 0)
      saveSelection(app, reconcileSelection(get().selection, providers, chatProvider(get()) !== null));
  },

  toggleFavoriteModel: (key) => {
    const { favoriteModels } = get();
    const next = favoriteModels.includes(key) ? favoriteModels.filter((k) => k !== key) : [...favoriteModels, key];
    saveJson(FAVORITES_KEY, next);
    set({ favoriteModels: next });
  },
});
