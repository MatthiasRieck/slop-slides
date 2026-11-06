import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The tabs' contents have their own tests.
vi.mock("./ChatPanel", () => ({ ChatPanel: () => <div data-testid="chat" /> }));
vi.mock("./FileTree", () => ({ FileTree: () => <div data-testid="files" /> }));
vi.mock("./SettingsPanel", () => ({ SettingsPanel: () => <div data-testid="settings" /> }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  localStorage.clear();
  useApp.setState({
    workspace: { path: "/ws", name: "ws" },
    deck: deckFor(DECK_HTML),
    sidebarTabs: ["chat", "files"],
    sidebarTab: "chat",
    sidebarOpen: true,
  });
});

const tab = (name: string) => screen.getByRole("tab", { name });
const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
const shown = (id: string) => screen.queryByTestId(id) !== null;

describe("Sidebar", () => {
  it("shows one tab at a time and switches between them", () => {
    render(<Sidebar />);
    expect(tabNames()).toEqual(["Chat", "Files"]);
    expect(tab("Chat").getAttribute("aria-selected")).toBe("true");
    expect(shown("chat")).toBe(true);
    expect(shown("files")).toBe(false);
    fireEvent.click(tab("Files"));
    expect(useApp.getState().sidebarTab).toBe("files");
    expect(tab("Files").getAttribute("aria-selected")).toBe("true");
    expect(shown("files")).toBe(true);
    expect(shown("chat")).toBe(false);
  });

  it("shows workspace chat without an open deck", () => {
    useApp.setState({ deck: null });
    render(<Sidebar />);
    expect(shown("chat")).toBe(true);
  });

  it("closes a tab, showing the one beside it", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Close Chat" }));
    expect(tabNames()).toEqual(["Files"]);
    expect(shown("files")).toBe(true);
    expect(useApp.getState()).toMatchObject({ sidebarTabs: ["files"], sidebarTab: "files" });
  });

  it("offers what can open once every tab is closed", () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Close Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Files" }));
    expect(tabNames()).toEqual([]);
    expect(screen.getByRole("heading", { name: "Open a tab" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Files" }));
    expect(tabNames()).toEqual(["Files"]);
    expect(shown("files")).toBe(true);
  });

  it("opens a closed surface from the + menu, which lists only the closed ones", () => {
    useApp.setState({ sidebarTabs: ["files"], sidebarTab: "files" });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Open a tab" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Chat", "Settings"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Chat" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(tabNames()).toEqual(["Files", "Chat"]);
    expect(shown("chat")).toBe(true);
  });

  it("turns off + once every surface is open", () => {
    useApp.setState({ sidebarTabs: ["chat", "files", "settings"] });
    render(<Sidebar />);
    expect((screen.getByRole("button", { name: "Open a tab" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens the settings in a tab from the button at the bottom", () => {
    render(<Sidebar />);
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(settings.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(settings);
    expect(tabNames()).toEqual(["Chat", "Files", "Settings"]);
    expect(shown("settings")).toBe(true);
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-pressed")).toBe("true");
    // A second press keeps the one tab.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(tabNames()).toEqual(["Chat", "Files", "Settings"]);
  });
});
