import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { api, errorMessage } from "./api";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue("result");
});

describe("api", () => {
  // Command names and argument keys must match the #[tauri::command]s in src-tauri/src/lib.rs.
  it.each([
    ["listDecks", () => api.listDecks(), "list_decks", undefined],
    ["createDeck", () => api.createDeck("Talk"), "create_deck", { title: "Talk" }],
    ["openDeck", () => api.openDeck("talk"), "open_deck", { id: "talk" }],
    ["closeDeck", () => api.closeDeck(), "close_deck", undefined],
    ["loadDeck", () => api.loadDeck("talk"), "load_deck", { id: "talk" }],
    ["renameDeck", () => api.renameDeck("talk", "New"), "rename_deck", { id: "talk", title: "New" }],
    ["deleteDeck", () => api.deleteDeck("talk"), "delete_deck", { id: "talk" }],
    ["reorderSlides", () => api.reorderSlides("talk", ["b", "a"]), "reorder_slides", { id: "talk", slides: ["b", "a"] }],
    ["addSlide", () => api.addSlide("talk", null), "add_slide", { id: "talk", after: null }],
    ["duplicateSlide", () => api.duplicateSlide("talk", "a"), "duplicate_slide", { id: "talk", slide: "a" }],
    ["deleteSlide", () => api.deleteSlide("talk", "a"), "delete_slide", { id: "talk", slide: "a" }],
    [
      "saveDeckSource",
      () => api.saveDeckSource("talk", "<html>", "<old>"),
      "save_deck_source",
      { id: "talk", source: "<html>", base: "<old>" },
    ],
    ["importAssets", () => api.importAssets("talk", ["/a.png"]), "import_assets", { id: "talk", paths: ["/a.png"] }],
    ["exportDeck", () => api.exportDeck("talk", "/out.html"), "export_deck", { id: "talk", dest: "/out.html" }],
    ["loadChat", () => api.loadChat("talk"), "load_chat", { id: "talk" }],
    ["saveChat", () => api.saveChat("talk", [1]), "save_chat", { id: "talk", chat: [1] }],
    ["resetChat", () => api.resetChat("talk"), "reset_chat", { id: "talk" }],
    [
      "sendMessage",
      () => api.sendMessage("talk", "Hi", "opus"),
      "send_message",
      { args: { deckId: "talk", prompt: "Hi", model: "opus" } },
    ],
    ["interruptAgent", () => api.interruptAgent("talk"), "interrupt_agent", { id: "talk" }],
    ["agentRunning", () => api.agentRunning("talk"), "agent_running", { id: "talk" }],
    ["agentStatus", () => api.agentStatus(), "agent_status", undefined],
  ] as const)("%s invokes %s", async (_, call, command, args) => {
    await expect(call()).resolves.toBe("result");
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]).toEqual(args === undefined ? [command] : [command, args]);
  });

  it("covers every api function", () => {
    expect(Object.keys(api)).toHaveLength(21);
  });

  it("passes backend rejections through", async () => {
    invoke.mockRejectedValue("deck not found: x");
    await expect(api.openDeck("x")).rejects.toBe("deck not found: x");
  });
});

describe("errorMessage", () => {
  it("shows backend string errors as-is", () => {
    expect(errorMessage("deck not found: x")).toBe("deck not found: x");
  });

  it("uses an Error's message", () => {
    expect(errorMessage(new TypeError("boom"))).toBe("boom");
  });

  it("stringifies anything else", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
