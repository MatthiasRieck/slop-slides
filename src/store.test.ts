import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const ask = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: (...args: unknown[]) => ask(...args) }));

import { DECK_HTML, deckFor } from "./test/fixtures";

async function freshStore() {
  vi.resetModules();
  return (await import("./store")).useApp;
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  ask.mockReset();
});

describe("slide selection", () => {
  it("select changes the slide and bumps revealRev, even for the same slide", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML) });
    const rev = useApp.getState().revealRev;
    useApp.getState().select("outro");
    expect(useApp.getState().selected).toBe("outro");
    expect(useApp.getState().revealRev).toBe(rev + 1);
    // Clicking the selected thumbnail again must still reveal it in the HTML view.
    useApp.getState().select("outro");
    expect(useApp.getState().revealRev).toBe(rev + 2);
  });

  it("selectRelative moves within bounds and bumps revealRev", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBe("#2");
    useApp.getState().selectRelative(5);
    expect(useApp.getState().selected).toBe("outro");
    useApp.getState().selectRelative(-10);
    expect(useApp.getState().selected).toBe("intro");
    expect(useApp.getState().revealRev).toBe(3);
  });

  it("selectRelative does nothing without slides", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: { ...deckFor(""), slides: [] }, selected: null });
    useApp.getState().selectRelative(1);
    expect(useApp.getState().selected).toBeNull();
    expect(useApp.getState().revealRev).toBe(0);
  });

  it("setDeck keeps the selection when the slide survives, else picks the first", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "outro" });
    useApp.getState().setDeck(deckFor(DECK_HTML, "2"));
    expect(useApp.getState().selected).toBe("outro");
    useApp.getState().setDeck(deckFor(DECK_HTML.replace(` id="outro"`, ` id="end"`)));
    expect(useApp.getState().selected).toBe("intro");
  });
});

describe("stage view", () => {
  it("defaults to slides", async () => {
    const useApp = await freshStore();
    expect(useApp.getState().view).toBe("slides");
  });

  it("restores the last view from localStorage", async () => {
    localStorage.setItem("slopslide.view", "code");
    const useApp = await freshStore();
    expect(useApp.getState().view).toBe("code");
  });

  it("ignores unknown stored values", async () => {
    localStorage.setItem("slopslide.view", "bogus");
    const useApp = await freshStore();
    expect(useApp.getState().view).toBe("slides");
  });

  it("setView switches and persists", async () => {
    const useApp = await freshStore();
    useApp.getState().setView("code");
    expect(useApp.getState().view).toBe("code");
    expect(localStorage.getItem("slopslide.view")).toBe("code");
    useApp.getState().setView("slides");
    expect(localStorage.getItem("slopslide.view")).toBe("slides");
  });
});

describe("closing a deck with unsaved HTML edits", () => {
  it("closes immediately when there are no edits", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: false });
    await useApp.getState().closeDeck();
    expect(ask).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("close_deck");
    expect(useApp.getState().deck).toBeNull();
  });

  it("stays open when the user keeps their edits", async () => {
    const useApp = await freshStore();
    ask.mockResolvedValue(false);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    await useApp.getState().closeDeck();
    expect(ask).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalledWith("close_deck");
    expect(useApp.getState().deck).not.toBeNull();
    expect(useApp.getState().codeDirty).toBe(true);
  });

  it("closes and clears the dirty flag when the user discards", async () => {
    const useApp = await freshStore();
    ask.mockResolvedValue(true);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    await useApp.getState().closeDeck();
    expect(invoke).toHaveBeenCalledWith("close_deck");
    expect(useApp.getState().deck).toBeNull();
    expect(useApp.getState().codeDirty).toBe(false);
  });

  it("falls back to window.confirm when the native dialog is unavailable", async () => {
    const useApp = await freshStore();
    ask.mockRejectedValue(new Error("no dialog plugin"));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    useApp.setState({ deck: deckFor(DECK_HTML), codeDirty: true });
    await useApp.getState().closeDeck();
    expect(confirm).toHaveBeenCalledOnce();
    expect(useApp.getState().deck).not.toBeNull();
    confirm.mockRestore();
  });
});
