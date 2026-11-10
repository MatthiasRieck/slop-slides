import { beforeEach, describe, expect, it } from "vitest";

import { freshStore, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("sidebar", () => {
  it("shows the chat tab first, and opens on the tab picked", async () => {
    localStorage.clear();
    let useApp = await freshStore();
    expect(useApp.getState().sidebarTab).toBe("chat");
    useApp.getState().setSidebarOpen(false);
    useApp.getState().setSidebarTab("files");
    expect(useApp.getState()).toMatchObject({ sidebarTab: "files", sidebarOpen: true });
    useApp = await freshStore();
    expect(useApp.getState().sidebarTab).toBe("files");
    // Narration was a sidebar tab before it became a mode.
    localStorage.setItem("slopslide.sidebarTab", "narration");
    expect((await freshStore()).getState().sidebarTab).toBe("chat");
    localStorage.setItem("slopslide.sidebarTab", "bogus");
    useApp = await freshStore();
    expect(useApp.getState().sidebarTab).toBe("chat");
  });

  it("opens the chat and files tabs first, and remembers which tabs are open", async () => {
    localStorage.clear();
    let useApp = await freshStore();
    expect(useApp.getState().sidebarTabs).toEqual(["chat", "files"]);
    useApp.getState().setSidebarTab("settings");
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["chat", "files", "settings"], sidebarTab: "settings" });
    useApp.getState().setSidebarTab("chat");
    expect(useApp.getState().sidebarTabs).toEqual(["chat", "files", "settings"]);
    useApp.getState().closeSidebarTab("files");
    useApp = await freshStore();
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["chat", "settings"], sidebarTab: "chat" });
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

  it("shows the tab beside a closed one, and none once all are closed", async () => {
    localStorage.clear();
    let useApp = await freshStore();
    useApp.getState().setSidebarTab("settings");
    useApp.getState().setSidebarTab("files");
    useApp.getState().closeSidebarTab("files");
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["chat", "settings"], sidebarTab: "settings" });
    useApp.getState().closeSidebarTab("chat");
    expect(useApp.getState().sidebarTab).toBe("settings");
    useApp.getState().closeSidebarTab("settings");
    useApp.getState().closeSidebarTab("settings");
    expect(useApp.getState()).toMatchObject({ sidebarTabs: [], sidebarTab: null });
    useApp = await freshStore();
    expect(useApp.getState()).toMatchObject({ sidebarTabs: [], sidebarTab: null, sidebarOpen: false });
    useApp.getState().setSidebarTab("files");
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["files"], sidebarTab: "files", sidebarOpen: true });
  });

  it("collapses once the last tab is closed, and stays open while any is left", async () => {
    localStorage.clear();
    const useApp = await freshStore();
    useApp.getState().setSidebarMaximized(true);
    useApp.getState().closeSidebarTab("files");
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["chat"], sidebarOpen: true, sidebarMaximized: true });
    useApp.getState().closeSidebarTab("chat");
    expect(useApp.getState()).toMatchObject({ sidebarTabs: [], sidebarOpen: false, sidebarMaximized: false });
    expect(localStorage.getItem("slopslide.sidebarOpen")).toBe("false");
  });

  it("brings back the chat when opened with every tab closed", async () => {
    localStorage.clear();
    const useApp = await freshStore();
    useApp.getState().closeSidebarTab("chat");
    useApp.getState().closeSidebarTab("files");
    expect(useApp.getState().sidebarOpen).toBe(false);
    useApp.getState().setSidebarOpen(true);
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["chat"], sidebarTab: "chat", sidebarOpen: true });
  });

  it("drops saved tabs that are no more, and a showing tab that is not open", async () => {
    localStorage.clear();
    localStorage.setItem("slopslide.sidebarTabs", JSON.stringify(["bogus", "files", "files", 3]));
    localStorage.setItem("slopslide.sidebarTab", "chat");
    expect((await freshStore()).getState()).toMatchObject({ sidebarTabs: ["files"], sidebarTab: "files" });
    localStorage.setItem("slopslide.sidebarTabs", "not json");
    expect((await freshStore()).getState().sidebarTabs).toEqual(["chat", "files"]);
  });

  it("reopens the narration tab left open at the last launch", async () => {
    localStorage.setItem("slopslide.sidebarTabs", JSON.stringify(["chat", "narration", "bogus"]));
    localStorage.setItem("slopslide.sidebarTab", "narration");
    const useApp = await freshStore();
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["chat", "narration"], sidebarTab: "narration" });
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
