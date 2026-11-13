// The sidebar starts without the code of the tabs it does not show: the HTML tab's editor
// (CodeMirror) and the SVG editor are loaded when their tab first shows.
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The chat listens for files dropped on the window.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

const imported = vi.hoisted(() => ({ code: 0, svg: 0 }));
vi.mock("./CodeView", () => {
  imported.code++;
  return { CodePanel: () => <div data-testid="code" /> };
});
vi.mock("./SvgEditor", () => {
  imported.svg++;
  return { SvgEditor: () => <div data-testid="svg" /> };
});

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  useApp.setState({
    workspace: { path: "/ws", name: "ws" },
    deck: deckFor(DECK_HTML),
    selected: "intro",
    sidebarOpen: true,
    sidebarTabs: ["chat", "code", "svg"],
    sidebarTab: "chat",
    messages: [],
    running: false,
  });
});

describe("the sidebar's lazy tabs", () => {
  it("renders the chat without importing the code view or the SVG editor, open in a tab or not", async () => {
    render(<Sidebar />);
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("textbox")).toBeTruthy();
    // Past the first frames: nothing asks for them behind the chat either.
    await act(async () => {});
    expect(imported).toEqual({ code: 0, svg: 0 });
    expect(screen.queryByTestId("code")).toBeNull();
  });

  it("imports the code view when the HTML tab first shows, and keeps the tab's place until then", async () => {
    render(<Sidebar />);
    act(() => useApp.getState().setSidebarTab("code"));
    expect(await screen.findByTestId("code")).toBeTruthy();
    expect(imported).toEqual({ code: 1, svg: 0 });
  });
});
