import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The tabs' contents have their own tests.
vi.mock("./ChatPanel", () => ({ ChatPanel: () => <div data-testid="chat" /> }));
vi.mock("./FileTree", () => ({ FileTree: () => <div data-testid="files" /> }));
vi.mock("./SettingsPanel", () => ({ SettingsPanel: () => <div data-testid="settings" /> }));
vi.mock("./SvgEditor", () => ({ SvgEditor: () => <div data-testid="svg" /> }));
vi.mock("./NarrationPanel", () => ({ NarrationPanel: () => <div data-testid="narration" /> }));
vi.mock("./NotesPanel", () => ({ NotesPanel: () => <div data-testid="notes" /> }));
const codeMounts = vi.fn();
vi.mock("./CodeView", async () => {
  const { useEffect } = await import("react");
  return {
    CodePanel: ({ active }: { active: boolean }) => {
      useEffect(() => void codeMounts(), []);
      return <div data-testid="code" data-active={String(active)} />;
    },
  };
});

import { useApp } from "../store";
import { useSvgEditor } from "../svgStore";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask } from "../test/tauri";
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  localStorage.clear();
  codeMounts.mockClear();
  ask.mockReset();
  useApp.setState({
    selected: "intro",
    codeDirty: false,
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
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Chat",
      "Narration",
      "Notes",
      "HTML",
      "SVG",
      "Settings",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Chat" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(tabNames()).toEqual(["Files", "Chat"]);
    expect(shown("chat")).toBe(true);
  });

  it("maximizes over the window and back", () => {
    useApp.setState({ sidebarMaximized: false });
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Maximize the sidebar over the slides" }));
    expect(useApp.getState().sidebarMaximized).toBe(true);
    const restore = screen.getByRole("button", { name: "Restore the sidebar" });
    expect(restore.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(restore);
    expect(useApp.getState().sidebarMaximized).toBe(false);
  });

  it("hides itself from the button beside maximize", () => {
    useApp.setState({ sidebarMaximized: true });
    render(<Sidebar />);
    const maximize = screen.getByRole("button", { name: "Restore the sidebar" });
    const hide = screen.getByRole("button", { name: "Hide sidebar" });
    expect(maximize.nextElementSibling).toBe(hide);
    fireEvent.click(hide);
    expect(useApp.getState()).toMatchObject({ sidebarOpen: false, sidebarMaximized: false });
  });

  it("closes the SVG editor's tab through the editor, which asks about changes not accepted", async () => {
    const markup = "<svg></svg>";
    useApp.setState({ sidebarTabs: ["chat", "svg"], sidebarTab: "svg" });
    useSvgEditor.setState({
      edit: {
        deckId: "/d/deck.html",
        slide: "intro",
        path: [0],
        original: markup,
        draft: "<svg><g></g></svg>",
        past: [markup],
        future: [],
        size: { w: 10, h: 10 },
        color: null,
        vars: {},
        css: "",
        fonts: "",
        ancestors: [],
        saving: false,
      },
    });
    ask.mockResolvedValueOnce(false);
    render(<Sidebar />);
    expect(shown("svg")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close SVG" }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(tabNames()).toEqual(["Chat", "SVG"]);
    ask.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Close SVG" }));
    await waitFor(() => expect(tabNames()).toEqual(["Chat"]));
    expect(useSvgEditor.getState().edit).toBeNull();
  });

  it("turns off + once every surface is open", () => {
    useApp.setState({ sidebarTabs: ["chat", "files", "narration", "notes", "code", "svg", "settings"] });
    render(<Sidebar />);
    expect((screen.getByRole("button", { name: "Open a tab" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["Narration", "narration"],
    ["Notes", "notes"],
    ["HTML", "code"],
  ])("opens %s in a tab beside the slide, and closes it again", (name, id) => {
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Open a tab" }));
    fireEvent.click(screen.getByRole("menuitem", { name }));
    expect(tabNames()).toEqual(["Chat", "Files", name]);
    expect(tab(name).getAttribute("aria-selected")).toBe("true");
    expect(shown(id)).toBe(true);
    expect(shown("chat")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: `Close ${name}` }));
    expect(tabNames()).toEqual(["Chat", "Files"]);
    expect(shown(id)).toBe(false);
  });

  it("keeps the HTML mounted behind the other tabs, so unsaved edits survive", () => {
    useApp.setState({ sidebarTabs: ["chat", "code"], sidebarTab: "code" });
    render(<Sidebar />);
    const code = () => screen.getByTestId("code");
    expect(code().dataset.active).toBe("true");
    expect(code().parentElement!.classList.contains("hidden")).toBe(false);
    fireEvent.click(tab("Chat"));
    expect(shown("chat")).toBe(true);
    expect(code().dataset.active).toBe("false");
    expect(code().parentElement!.classList.contains("hidden")).toBe(true);
    fireEvent.click(tab("HTML"));
    expect(code().dataset.active).toBe("true");
    expect(shown("chat")).toBe(false);
    expect(codeMounts).toHaveBeenCalledTimes(1);
  });

  it("asks before closing the HTML tab over unsaved edits", async () => {
    useApp.setState({ sidebarTabs: ["chat", "code"], sidebarTab: "code", codeDirty: true });
    ask.mockResolvedValueOnce(false);
    render(<Sidebar />);
    expect(screen.getByTestId("code-mark").title).toBe("Unsaved changes");
    fireEvent.click(screen.getByRole("button", { name: "Close HTML" }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(tabNames()).toEqual(["Chat", "HTML"]);
    ask.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Close HTML" }));
    await waitFor(() => expect(tabNames()).toEqual(["Chat"]));
  });

  it("closes the HTML tab without asking when nothing is unsaved", () => {
    useApp.setState({ sidebarTabs: ["chat", "code"], sidebarTab: "chat" });
    render(<Sidebar />);
    expect(screen.queryByTestId("code-mark")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close HTML" }));
    expect(tabNames()).toEqual(["Chat"]);
    expect(ask).not.toHaveBeenCalled();
  });

  it("marks the Narration tab while the selected slide has narration", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ sidebarTabs: ["chat", "narration"] });
    render(<Sidebar />);
    expect(screen.queryByTestId("narration-mark")).toBeNull();
    act(() =>
      useApp.setState({
        deck: { ...deck, slides: deck.slides.map((s) => (s.id === "intro" ? { ...s, narration: "Hello." } : s)) },
      }),
    );
    expect(screen.getByTestId("narration-mark")).toBeTruthy();
    expect(tab("Narration")).toBeTruthy();
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
