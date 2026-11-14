import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The tabs' contents have their own tests.
const chatMounts = vi.fn();
vi.mock("./ChatPanel", async () => {
  const { useEffect } = await import("react");
  return {
    ChatPanel: ({ active }: { active: boolean }) => {
      useEffect(() => void chatMounts(), []);
      return <div data-testid="chat" data-active={String(active)} />;
    },
  };
});
vi.mock("./FileTree", () => ({ FileTree: () => <div data-testid="files" /> }));
vi.mock("./SvgEditor", () => ({ SvgEditor: () => <div data-testid="svg" /> }));
vi.mock("./NarrationPanel", () => ({ NarrationPanel: () => <div data-testid="narration" /> }));
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
import { CodePanel, SvgEditor } from "./lazy";
import { Sidebar } from "./Sidebar";

// The HTML and SVG tabs are loaded on first use; here they are there, as once the app has been idle.
beforeAll(() => Promise.all([CodePanel.preload(), SvgEditor.preload()]));

beforeEach(() => {
  localStorage.clear();
  codeMounts.mockClear();
  ask.mockReset();
  useApp.setState({
    selected: "intro",
    codeDirty: false,
    workspace: { path: "/ws", name: "ws" },
    deck: deckFor(DECK_HTML),
    sidebarTabs: ["chat", "files", "narration", "code"],
    sidebarTab: "chat",
    sidebarWanted: "chat",
    sidebarReturn: "chat",
    appSettingsOpen: false,
    sidebarOpen: true,
    running: false,
    messages: [],
    shortcutHelpOpen: false,
  });
});

const tab = (name: string) => screen.getByRole("tab", { name });
const tabNames = () => screen.queryAllByRole("tab").map((t) => t.getAttribute("aria-label"));
/** On show: mounted, and not kept hidden behind the tab that shows (as the chat and the HTML are). */
const shown = (id: string) => {
  const content = screen.queryByTestId(id);
  return content !== null && !content.parentElement?.classList.contains("hidden");
};
const mounted = (id: string) => screen.queryByTestId(id) !== null;

describe("Sidebar", () => {
  it("shows one tab at a time and switches between them", () => {
    render(<Sidebar />);
    expect(tabNames()).toEqual(["Chat", "Files", "Narration", "Code"]);
    expect(tab("Chat").getAttribute("aria-selected")).toBe("true");
    expect(shown("chat")).toBe(true);
    expect(shown("files")).toBe(false);
    fireEvent.click(tab("Files"));
    expect(useApp.getState().sidebarTab).toBe("files");
    expect(tab("Files").getAttribute("aria-selected")).toBe("true");
    expect(shown("files")).toBe(true);
    expect(shown("chat")).toBe(false);
  });

  it("offers only the chat and the files without a deck", () => {
    act(() => useApp.setState({ deck: null }));
    render(<Sidebar />);
    expect(tabNames()).toEqual(["Chat", "Files"]);
    expect(shown("chat")).toBe(true);
  });

  it("has no close button and no + menu: its panels are always there", () => {
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: /^Close/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open a tab" })).toBeNull();
    fireEvent(tab("Files"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(tabNames()).toEqual(["Chat", "Files", "Narration", "Code"]);
  });

  it("names the deck's source Code, saying in its tooltip what it holds", () => {
    render(<Sidebar />);
    expect(tab("Code").title).toBe("The deck's HTML and CSS, at the selected slide");
    expect(screen.queryByRole("tab", { name: "HTML" })).toBeNull();
  });

  it("moves between its tabs with the arrow keys, Tab stopping at the one shown", () => {
    useApp.setState({ sidebarTab: "files" });
    render(<Sidebar />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1, -1]);
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[3]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    // Moving the focus picks nothing; a click (Enter, Space) does.
    expect(useApp.getState().sidebarTab).toBe("files");
    fireEvent.click(tabs[0]!);
    expect(useApp.getState().sidebarTab).toBe("chat");
    expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1, -1]);
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
    expect(maximize.nextElementSibling?.contains(hide)).toBe(true);
    fireEvent.click(hide);
    expect(useApp.getState()).toMatchObject({ sidebarOpen: false, sidebarMaximized: false });
  });

  describe("the drawing's tab", () => {
    const editing = () =>
      useSvgEditor.setState({
        edit: {
          deckId: "/d/deck.html",
          slide: "intro",
          path: [0],
          original: "<svg></svg>",
          draft: "<svg><g></g></svg>",
          past: ["<svg></svg>"],
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

    it("is there while a drawing is edited, and closes through the editor, which asks about changes not accepted", async () => {
      editing();
      act(() => useApp.getState().setSidebarTab("svg"));
      ask.mockResolvedValueOnce(false);
      render(<Sidebar />);
      expect(tabNames()).toEqual(["Chat", "Files", "Narration", "Code", "Drawing"]);
      expect(shown("svg")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Close Drawing" }));
      await waitFor(() => expect(ask).toHaveBeenCalled());
      expect(tabNames()).toContain("Drawing");
      ask.mockResolvedValueOnce(true);
      // A middle click closes it too.
      fireEvent(tab("Drawing"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
      await waitFor(() => expect(tabNames()).toEqual(["Chat", "Files", "Narration", "Code"]));
      expect(useSvgEditor.getState().edit).toBeNull();
      // Back on the tab that showed before the drawing.
      expect(shown("chat")).toBe(true);
    });
  });

  it("does not mount a tab that stays mounted before it first shows", () => {
    useApp.setState({ sidebarTab: "files" });
    render(<Sidebar />);
    expect(mounted("code")).toBe(false);
    expect(codeMounts).not.toHaveBeenCalled();
    fireEvent.click(tab("Code"));
    expect(shown("code")).toBe(true);
    fireEvent.click(tab("Files"));
    expect([mounted("code"), shown("code")]).toEqual([true, false]);
    expect(codeMounts).toHaveBeenCalledOnce();
    // Gone with the deck; with the next deck it starts anew when it shows.
    act(() => useApp.setState({ deck: null }));
    expect(mounted("code")).toBe(false);
  });

  it("keeps the chat mounted behind the other tabs, telling it whether it shows", () => {
    chatMounts.mockClear();
    render(<Sidebar />);
    const chat = () => screen.getByTestId("chat");
    expect(chat().dataset.active).toBe("true");
    fireEvent.click(tab("Files"));
    expect([mounted("chat"), shown("chat")]).toEqual([true, false]);
    expect(chat().dataset.active).toBe("false");
    fireEvent.click(tab("Chat"));
    expect(shown("chat")).toBe(true);
    expect(chat().dataset.active).toBe("true");
    // The same chat all along: its draft, its scroll position and its unfolded tool calls stay.
    expect(chatMounts).toHaveBeenCalledOnce();
  });

  it("keeps the code mounted behind the other tabs, so unsaved edits survive, and marks them", () => {
    useApp.setState({ sidebarTab: "code" });
    render(<Sidebar />);
    const code = () => screen.getByTestId("code");
    expect(code().dataset.active).toBe("true");
    fireEvent.click(tab("Chat"));
    expect(shown("chat")).toBe(true);
    expect(code().dataset.active).toBe("false");
    expect(code().parentElement!.classList.contains("hidden")).toBe(true);
    expect(screen.queryByTestId("code-mark")).toBeNull();
    act(() => useApp.setState({ codeDirty: true }));
    expect(screen.getByTestId("code-mark").title).toBe("Unsaved changes");
    fireEvent.click(tab("Code"));
    expect(code().dataset.active).toBe("true");
    expect(codeMounts).toHaveBeenCalledTimes(1);
  });

  it("marks the Narration tab while the selected slide has narration", () => {
    const deck = deckFor(DECK_HTML);
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

  it("opens the app's settings dialog from the button at the bottom", () => {
    render(<Sidebar />);
    const settings = screen.getByRole("button", { name: "App settings…" });
    expect(settings.getAttribute("aria-pressed")).toBe("false");
    expect(settings.title).toBe("App settings… (Ctrl+,)");
    fireEvent.click(settings);
    expect(useApp.getState().appSettingsOpen).toBe(true);
    // A dialog, not a tab.
    expect(tabNames()).toEqual(["Chat", "Files", "Narration", "Code"]);
  });

  it("opens the keyboard shortcuts from the button beside the settings", () => {
    render(<Sidebar />);
    const shortcuts = screen.getByRole("button", { name: "Keyboard shortcuts" });
    expect(shortcuts.previousElementSibling).toBe(screen.getByRole("button", { name: "App settings…" }));
    expect(shortcuts.title).toBe("Keyboard shortcuts (?, Ctrl+/)");
    fireEvent.click(shortcuts);
    expect(useApp.getState().shortcutHelpOpen).toBe(true);
  });

  describe("the Chat tab's mark", () => {
    const mark = () => document.querySelector<HTMLElement>("[role=tablist] [data-attention]");

    it("is a spinner while the agent works and another tab shows", () => {
      useApp.setState({ sidebarTab: "files", running: true });
      render(<Sidebar />);
      expect(mark()?.dataset.attention).toBe("working");
      expect(screen.getByRole("tab", { name: /^Chat/ }).contains(mark())).toBe(true);
      // On show, the chat says so itself.
      fireEvent.click(screen.getByRole("tab", { name: /^Chat/ }));
      expect(mark()).toBeNull();
    });

    it("is a warning dot while the agent waits for an approval", () => {
      useApp.setState({
        sidebarTab: "files",
        running: true,
        messages: [
          {
            id: "a1",
            role: "assistant",
            parts: [
              {
                kind: "approval",
                status: "pending",
                approval: {
                  id: "p1",
                  title: "Run a command",
                  reason: null,
                  details: "ls",
                  acceptLabel: "Allow once",
                  decisions: ["accept"],
                },
              },
            ],
            status: "streaming",
            thinking: false,
            error: null,
            costUsd: null,
            durationMs: null,
            createdAt: 1,
          },
        ],
      });
      render(<Sidebar />);
      expect(mark()?.dataset.attention).toBe("approval");
    });

    it("is not there while the chat is at rest", () => {
      useApp.setState({ sidebarTab: "files" });
      render(<Sidebar />);
      expect(mark()).toBeNull();
    });
  });

  describe("when the names don't all fit", () => {
    // jsdom lays nothing out, so give the strip and the measured copies their sizes by hand.
    const lay = (width: number) => {
      const strip = screen.getByRole("tablist").parentElement!;
      Object.defineProperty(strip, "clientWidth", { configurable: true, value: width });
      const copies = Array.from(screen.getByTestId("tab-sizes").children) as HTMLElement[];
      for (const [i, copy] of copies.entries()) {
        Object.defineProperty(copy, "offsetWidth", { configurable: true, value: i === copies.length - 1 ? 28 : 70 });
      }
    };
    const labelled = () =>
      screen.getAllByRole("tab").map((t) => [t.getAttribute("aria-label"), t.textContent !== ""] as const);

    it("shows every name while they fit, and only the active tab's when they do not", () => {
      const { rerender } = render(<Sidebar />);
      expect(labelled().every(([, named]) => named)).toBe(true);
      // Four tabs of 70, three gaps: 292, and the room kept for the marks.
      lay(320);
      act(() => useApp.setState({ sidebarTab: "files" }));
      rerender(<Sidebar />);
      expect(labelled().every(([, named]) => named)).toBe(true);
      lay(200);
      act(() => useApp.setState({ sidebarTab: "chat" }));
      rerender(<Sidebar />);
      expect(labelled()).toEqual([
        ["Chat", true],
        ["Files", false],
        ["Narration", false],
        ["Code", false],
      ]);
      // Without its name, a tab says it in its tooltip.
      expect(tab("Files").title).toBe("Files: The folders and files of the open folder");
      lay(100);
      act(() => useApp.setState({ sidebarTab: "files" }));
      rerender(<Sidebar />);
      expect(labelled().every(([, named]) => !named)).toBe(true);
    });
  });
});
