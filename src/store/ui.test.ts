import { beforeEach, describe, expect, it } from "vitest";

import { DECK_HTML, deckFor } from "../test/fixtures";
import { freshStore, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("sidebar", () => {
  /** A store as a fresh launch has it, with a deck open or not. */
  const launch = async (withDeck = false) => {
    const useApp = await freshStore();
    if (withDeck) useApp.setState({ deck: deckFor(DECK_HTML) });
    return useApp;
  };

  it("has the chat and the files without a deck, and the deck's panels with one", async () => {
    localStorage.clear();
    const useApp = await launch();
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["chat", "files"], sidebarTab: "chat" });
    useApp.setState({ deck: deckFor(DECK_HTML) });
    expect(useApp.getState().sidebarTabs).toEqual(["chat", "files", "narration", "code"]);
    useApp.setState({ deck: null });
    expect(useApp.getState().sidebarTabs).toEqual(["chat", "files"]);
  });

  it("opens on the tab picked, and remembers it across launches", async () => {
    localStorage.clear();
    let useApp = await launch();
    useApp.getState().setSidebarOpen(false);
    useApp.getState().setSidebarTab("files");
    expect(useApp.getState()).toMatchObject({ sidebarTab: "files", sidebarOpen: true });
    useApp = await launch();
    expect(useApp.getState().sidebarTab).toBe("files");
  });

  it("brings a deck's tab back with the next deck, showing the chat in between", async () => {
    localStorage.clear();
    const useApp = await launch(true);
    useApp.getState().setSidebarTab("code");
    useApp.setState({ deck: null });
    expect(useApp.getState()).toMatchObject({ sidebarTab: "chat", sidebarWanted: "code" });
    useApp.setState({ deck: deckFor(DECK_HTML) });
    expect(useApp.getState().sidebarTab).toBe("code");
    // Asked for without a deck, it waits for one too.
    useApp.setState({ deck: null });
    useApp.getState().setSidebarTab("narration");
    expect(useApp.getState().sidebarTab).toBe("chat");
    expect((await launch(true)).getState().sidebarTab).toBe("narration");
  });

  it("keeps the chat and the files: closing them does nothing", async () => {
    localStorage.clear();
    const useApp = await launch(true);
    for (const tab of ["chat", "files", "narration", "code"] as const) useApp.getState().closeSidebarTab(tab);
    expect(useApp.getState().sidebarTabs).toEqual(["chat", "files", "narration", "code"]);
  });

  it("opens the drawing's tab while it is edited, and goes back to the tab before when it closes", async () => {
    localStorage.clear();
    const useApp = await launch(true);
    useApp.getState().setSidebarTab("files");
    useApp.getState().setSidebarTab("svg");
    expect(useApp.getState()).toMatchObject({
      sidebarTabs: ["chat", "files", "narration", "code", "svg"],
      sidebarTab: "svg",
    });
    // It stays with the deck coming and going, and is not remembered for the next launch.
    useApp.setState({ deck: null });
    expect(useApp.getState().sidebarTabs).toEqual(["chat", "files", "svg"]);
    expect((await launch()).getState().sidebarTab).toBe("files");
    useApp.getState().closeSidebarTab("svg");
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["chat", "files"], sidebarTab: "files" });
    useApp.getState().closeSidebarTab("svg");
    expect(useApp.getState().sidebarTab).toBe("files");
  });

  it("closes the drawing's tab while another shows, leaving that one", async () => {
    localStorage.clear();
    const useApp = await launch(true);
    useApp.getState().setSidebarTab("svg");
    useApp.getState().setSidebarTab("code");
    useApp.getState().closeSidebarTab("svg");
    expect(useApp.getState()).toMatchObject({
      sidebarTabs: ["chat", "files", "narration", "code"],
      sidebarTab: "code",
    });
  });

  it("maximizes the sidebar over the window, opening it, and never leaves a closed one maximized", async () => {
    localStorage.clear();
    const useApp = await freshStore();
    expect(useApp.getState().sidebarMaximized).toBe(false);
    useApp.getState().setSidebarOpen(false);
    useApp.getState().setSidebarMaximized(true);
    expect(useApp.getState()).toMatchObject({ sidebarMaximized: true, sidebarOpen: true });
    useApp.getState().setSidebarOpen(false);
    expect(useApp.getState()).toMatchObject({ sidebarMaximized: false, sidebarOpen: false });
    useApp.getState().setSidebarMaximized(true);
    useApp.getState().setSidebarMaximized(false);
    expect(useApp.getState()).toMatchObject({ sidebarMaximized: false, sidebarOpen: true });
    // It is for now: a fresh start has it beside the slides.
    useApp.getState().setSidebarMaximized(true);
    expect((await freshStore()).getState().sidebarMaximized).toBe(false);
  });

  it.each(["notes", "settings", "svg", "bogus"])(
    "opens on the chat when the tab saved, %s, is no tab to open on",
    async (saved) => {
      // Speaker notes and the app's settings were tabs once; the drawing's tab is for the moment.
      localStorage.clear();
      localStorage.setItem("slopslide.sidebarTab", saved);
      localStorage.setItem("slopslide.sidebarTabs", JSON.stringify(["chat", saved]));
      const useApp = await launch(true);
      expect(useApp.getState()).toMatchObject({ sidebarTab: "chat", sidebarWanted: "chat" });
      expect(useApp.getState().sidebarTabs).toEqual(["chat", "files", "narration", "code"]);
    },
  );
});

describe("the app's settings", () => {
  it("open as a dialog and close again, but not during a show", async () => {
    const useApp = await freshStore();
    useApp.getState().openAppSettings();
    expect(useApp.getState().appSettingsOpen).toBe(true);
    useApp.getState().closeAppSettings();
    expect(useApp.getState().appSettingsOpen).toBe(false);
    useApp.setState({ presenting: true });
    useApp.getState().openAppSettings();
    expect(useApp.getState().appSettingsOpen).toBe(false);
  });
});

describe("the deck's settings", () => {
  it("open as a dialog over the deck, whose mode stays, and close again", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: { id: "/w/talk/deck.html", title: "Talk", slides: [] } as never });
    useApp.getState().setMode("edit");
    useApp.getState().openDeckSettings();
    expect(useApp.getState()).toMatchObject({ deckSettingsOpen: true, slideMode: "view", editing: true });
    useApp.getState().closeDeckSettings();
    expect(useApp.getState()).toMatchObject({ deckSettingsOpen: false, editing: true });
  });

  it("do not open without a deck, nor during a show", async () => {
    const useApp = await freshStore();
    useApp.getState().openDeckSettings();
    expect(useApp.getState().deckSettingsOpen).toBe(false);
    useApp.setState({ deck: { id: "/w/talk/deck.html", title: "Talk", slides: [] } as never, presenting: true });
    useApp.getState().openDeckSettings();
    expect(useApp.getState().deckSettingsOpen).toBe(false);
  });

  it("stay closed when closed from another mode", async () => {
    const useApp = await freshStore();
    useApp.getState().openDeckSettings();
    // The user went on to another mode by its tab.
    useApp.getState().setMode("edit");
    useApp.getState().closeDeckSettings();
    expect(useApp.getState()).toMatchObject({ slideMode: "view", editing: true });
  });
});

describe("flags kept across launches", () => {
  it.each([
    ["sidebarOpen", "setSidebarOpen", "slopslide.sidebarOpen", true],
    ["railOpen", "setRailOpen", "slopslide.railOpen", true],
    ["reviewVisible", "setReviewVisible", "slopslide.reviewVisible", true],
    ["finalState", "setFinalState", "slopslide.finalState", false],
    ["timelineOpen", "setTimelineOpen", "slopslide.timelineOpen", false],
  ] as const)(
    "%s (set by %s, saved as %s) starts as %s, and keeps what it is set to",
    async (flag, setter, key, fallback) => {
      let useApp = await freshStore();
      expect(useApp.getState()[flag]).toBe(fallback);
      useApp.getState()[setter](!fallback);
      expect(useApp.getState()[flag]).toBe(!fallback);
      expect(localStorage.getItem(key)).toBe(String(!fallback));
      useApp = await freshStore();
      expect(useApp.getState()[flag]).toBe(!fallback);
      useApp.getState()[setter](fallback);
      expect(localStorage.getItem(key)).toBe(String(fallback));
      useApp = await freshStore();
      expect(useApp.getState()[flag]).toBe(fallback);
    },
  );
});
