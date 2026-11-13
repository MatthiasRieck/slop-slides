import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderInfo } from "../lib/models";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { lastError } from "./errors";
import { backend, calls, DECK, freshStore, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("model choice", () => {
  const PROVIDERS: ProviderInfo[] = [
    {
      id: "claude",
      installed: true,
      path: "/bin/claude",
      models: [
        {
          id: "claude-opus-5-5",
          label: "Claude Opus 5.5",
          isDefault: true,
          efforts: ["low", "medium", "high", "max"],
          defaultEffort: "medium",
          contextWindows: ["200k", "1m"],
          defaultContextWindow: "1m",
        },
        {
          id: "claude-sonnet-5",
          label: "Claude Sonnet 5",
          isDefault: false,
          efforts: ["low", "medium", "high", "max"],
          defaultEffort: "medium",
          contextWindows: ["200k", "1m"],
          defaultContextWindow: "200k",
        },
      ],
      error: null,
    },
    {
      id: "codex",
      installed: true,
      path: "/bin/codex",
      models: [
        {
          id: "gpt-6-astra",
          label: "GPT-6-Astra",
          isDefault: true,
          efforts: ["low", "high"],
          defaultEffort: "high",
          contextWindows: [],
          defaultContextWindow: null,
        },
      ],
      error: null,
    },
  ];

  it("defaults to Claude Opus 5.5 at medium effort", async () => {
    const useApp = await freshStore();
    expect(useApp.getState().selection).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      effort: "medium",
      contextWindow: "1m",
    });
  });

  it("persists and restores the chosen model, keeping a supported effort", async () => {
    let useApp = await freshStore();
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("codex", "gpt-6-astra");
    // Codex's model has no "medium", so its own default applies.
    expect(useApp.getState().selection).toEqual({
      provider: "codex",
      model: "gpt-6-astra",
      label: "GPT-6-Astra",
      effort: "high",
      contextWindow: null,
    });
    useApp.getState().setEffort("low");
    useApp = await freshStore();
    expect(useApp.getState().selection).toMatchObject({ provider: "codex", model: "gpt-6-astra", effort: "low" });
  });

  it("locks a started chat to its provider while allowing model changes", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: DECK, providers: PROVIDERS });
    await useApp.getState().send("hello", { includeSlide: false, attachments: [] });
    useApp.getState().setModel("codex", "gpt-6-astra");
    expect(useApp.getState().selection.provider).toBe("claude");
    useApp.getState().setModel("claude", "claude-sonnet-5");
    expect(useApp.getState().selection.model).toBe("claude-sonnet-5");
    useApp.setState({ running: false });
    await useApp.getState().resetChat();
    useApp.getState().setModel("codex", "gpt-6-astra");
    expect(useApp.getState().selection.provider).toBe("codex");
  });

  it("keeps a chat's provider when its CLI becomes unavailable", async () => {
    const useApp = await freshStore();
    useApp.setState({ sessionProvider: "claude" });
    backend({
      list_providers: () => PROVIDERS.map((p) => (p.id === "claude" ? { ...p, installed: false, models: [] } : p)),
    });
    await useApp.getState().refreshProviders();
    expect(useApp.getState().selection.provider).toBe("claude");
  });

  it("restores the workspace provider and keeps it across file switches", async () => {
    const useApp = await freshStore(false);
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("codex", "gpt-6-astra");
    backend({
      open_workspace: () => ({ path: "/decks/talk", name: "talk" }),
      open_deck: () => DECK,
      session_provider: () => "claude",
      load_chat: () => [],
    });
    await useApp.getState().openWorkspace("/decks/talk");
    expect(calls("session_provider")).toEqual([{ id: "/decks/talk" }]);
    expect(useApp.getState().selection).toMatchObject({ provider: "claude", model: "claude-opus-5-5" });
    await useApp.getState().openDeck(DECK.id);
    await useApp.getState().closeDeck();
    expect(useApp.getState().sessionProvider).toBe("claude");
    useApp.getState().setModel("codex", "gpt-6-astra");
    expect(useApp.getState().selection.provider).toBe("claude");
    await useApp.getState().resetChat();
    expect(useApp.getState().sessionProvider).toBeNull();
    useApp.getState().setModel("codex", "gpt-6-astra");
    expect(useApp.getState().selection.provider).toBe("codex");
    useApp.setState({ sessionProvider: "codex" });
    await useApp.getState().closeWorkspace();
    expect(useApp.getState().sessionProvider).toBeNull();
  });

  it("ignores models that are not offered", async () => {
    const useApp = await freshStore();
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("codex", "nope");
    expect(useApp.getState().selection.provider).toBe("claude");
  });

  it("moves a selection whose provider is not installed onto an installed default", async () => {
    localStorage.setItem(
      "slopslide.selection",
      JSON.stringify({ provider: "codex", model: "gone", label: "Gone", effort: "max" }),
    );
    const useApp = await freshStore();
    const providers = PROVIDERS.map((p) => (p.id === "codex" ? { ...p, installed: false, models: [] } : p));
    backend({ list_providers: () => providers });
    await useApp.getState().refreshProviders();
    expect(useApp.getState().providers).toEqual(providers);
    expect(useApp.getState().selection).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      effort: "max",
      contextWindow: "1m",
    });
  });

  it("keeps the saved model when its provider could not list models", async () => {
    const saved = { provider: "codex", model: "gpt-6-astra", label: "GPT-6-Astra", effort: "high" };
    localStorage.setItem("slopslide.selection", JSON.stringify(saved));
    const useApp = await freshStore();
    const failing = PROVIDERS.map((p) => (p.id === "codex" ? { ...p, models: [], error: "not signed in" } : p));
    backend({ list_providers: () => failing });
    await useApp.getState().refreshProviders();
    expect(useApp.getState().selection).toEqual({ ...saved, contextWindow: null });
  });

  it("starts each model on its default context window and persists a change", async () => {
    let useApp = await freshStore();
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("claude", "claude-sonnet-5");
    expect(useApp.getState().selection.contextWindow).toBe("200k");
    useApp.getState().setContextWindow("1m");
    useApp = await freshStore();
    expect(useApp.getState().selection).toMatchObject({ model: "claude-sonnet-5", contextWindow: "1m" });
    useApp.setState({ providers: PROVIDERS });
    useApp.getState().setModel("claude", "claude-opus-5-5");
    expect(useApp.getState().selection.contextWindow).toBe("1m");
  });

  it("reconciles a saved context window with the model's options", async () => {
    localStorage.setItem(
      "slopslide.selection",
      JSON.stringify({ provider: "claude", model: "claude-sonnet-5", label: "Claude Sonnet 5", effort: "high" }),
    );
    const useApp = await freshStore();
    backend({ list_providers: () => PROVIDERS });
    await useApp.getState().refreshProviders();
    expect(useApp.getState().selection.contextWindow).toBe("200k");
  });

  it("toggles and persists favorite models", async () => {
    let useApp = await freshStore();
    useApp.getState().toggleFavoriteModel("codex:gpt-6-astra");
    useApp = await freshStore();
    expect(useApp.getState().favoriteModels).toEqual(["codex:gpt-6-astra"]);
    useApp.getState().toggleFavoriteModel("codex:gpt-6-astra");
    expect(useApp.getState().favoriteModels).toEqual([]);
  });
});

describe("permissions", () => {
  const codex = { provider: "codex" as const, model: "m", label: "M", effort: "high", contextWindow: null };
  const claude = { ...codex, provider: "claude" as const };

  it("defaults to Ask, remembers each provider's choice, and rejects invalid saved values", async () => {
    let store = await freshStore();
    expect(store.getState().permissionModes).toEqual({ claude: "ask", codex: "ask", copilot: "ask" });
    store.setState({ selection: codex });
    store.getState().setPermissionMode("autoReview");
    store.setState({ selection: claude });
    store.getState().setPermissionMode("fullAccess");
    expect(JSON.parse(localStorage.getItem("slopslide.permissions")!)).toEqual({
      claude: "fullAccess",
      codex: "autoReview",
      copilot: "ask",
    });
    store = await freshStore();
    expect(store.getState().permissionModes).toEqual({ claude: "fullAccess", codex: "autoReview", copilot: "ask" });
    localStorage.setItem("slopslide.permissions", '{"claude":"__proto__","codex":3,"__proto__":{"copilot":"custom"}}');
    expect((await freshStore()).getState().permissionModes).toEqual({ claude: "ask", codex: "ask", copilot: "ask" });
    localStorage.setItem("slopslide.permissions", "not json");
    expect((await freshStore()).getState().permissionModes.claude).toBe("ask");
  });

  it("keeps the Codex mode saved before every provider had one", async () => {
    localStorage.setItem("slopslide.codexPermissions", "custom");
    expect((await freshStore()).getState().permissionModes).toEqual({ claude: "ask", codex: "custom", copilot: "ask" });
  });

  it("saves a mode change, and tells the backend only while a turn runs, which then changes too", async () => {
    const store = await freshStore();
    store.setState({ running: false, selection: claude });
    store.getState().setPermissionMode("autoReview");
    expect(store.getState().permissionModes.claude).toBe("autoReview");
    expect(calls("set_permission_mode")).toHaveLength(0);
    store.setState({ running: true });
    store.getState().setPermissionMode("fullAccess");
    expect(store.getState().permissionModes.claude).toBe("fullAccess");
    expect(JSON.parse(localStorage.getItem("slopslide.permissions")!).claude).toBe("fullAccess");
    expect(calls("set_permission_mode")).toEqual([{ id: "/decks/talk", mode: "fullAccess" }]);
  });

  it("reports a failed live mode change", async () => {
    const store = await freshStore();
    store.setState({ running: true, selection: claude });
    invoke.mockImplementation(async (command: string) => {
      if (command === "set_permission_mode") throw "turn gone";
    });
    store.getState().setPermissionMode("fullAccess");
    await vi.waitFor(() => expect(lastError(store.getState())).toBe("turn gone"));
  });

  it("sends each provider its own mode", async () => {
    const store = await freshStore();
    store.setState({
      deck: deckFor(DECK_HTML),
      permissionModes: { claude: "fullAccess", codex: "autoReview", copilot: "ask" },
      selection: codex,
    });
    await store.getState().send("slides", { includeSlide: false, attachments: [] });
    expect(calls("send_message")[0]!.args).toMatchObject({ provider: "codex", permissionMode: "autoReview" });
    store.setState({ running: false, selection: claude });
    await store.getState().send("slides", { includeSlide: false, attachments: [] });
    expect(calls("send_message")[1]!.args).toMatchObject({ provider: "claude", permissionMode: "fullAccess" });
  });
});
