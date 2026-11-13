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

import { provideCodeSave, useApp } from "../store";
import { useSvgEditor } from "../svgStore";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ask } from "../test/tauri";
import { answerUnsaved, unsavedAsked } from "../test/unsaved";
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
    sidebarTabs: ["chat", "files"],
    sidebarTab: "chat",
    sidebarOpen: true,
    running: false,
    messages: [],
    shortcutHelpOpen: false,
  });
});

const tab = (name: string) => screen.getByRole("tab", { name });
const tabNames = () => screen.queryAllByRole("tab").map((t) => t.textContent);
/** On show: mounted, and not kept hidden behind the tab that shows (as the chat and the HTML are). */
const shown = (id: string) => {
  const content = screen.queryByTestId(id);
  return content !== null && !content.parentElement?.classList.contains("hidden");
};
const mounted = (id: string) => screen.queryByTestId(id) !== null;

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
      "App settings",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Chat" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(tabNames()).toEqual(["Files", "Chat"]);
    expect(shown("chat")).toBe(true);
  });

  it("works the + menu from the keyboard", () => {
    useApp.setState({ sidebarTabs: ["files"], sidebarTab: "files" });
    render(<Sidebar />);
    const plus = screen.getByRole("button", { name: "Open a tab" });
    plus.focus();
    fireEvent.keyDown(plus, { key: "Enter" });
    fireEvent.click(plus);
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(plus);
  });

  it("moves between its tabs with the arrow keys, Tab stopping at the one shown", () => {
    useApp.setState({ sidebarTabs: ["chat", "files", "notes"], sidebarTab: "files" });
    render(<Sidebar />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
    // Moving the focus picks nothing; a click (Enter, Space) does.
    expect(useApp.getState().sidebarTab).toBe("files");
    fireEvent.click(tabs[0]!);
    expect(useApp.getState().sidebarTab).toBe("chat");
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
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

  it("does not mount a tab that stays mounted before it first shows", () => {
    useApp.setState({ sidebarTabs: ["files", "code"], sidebarTab: "files" });
    render(<Sidebar />);
    expect(mounted("code")).toBe(false);
    expect(codeMounts).not.toHaveBeenCalled();
    fireEvent.click(tab("HTML"));
    expect(shown("code")).toBe(true);
    fireEvent.click(tab("Files"));
    expect([mounted("code"), shown("code")]).toEqual([true, false]);
    expect(codeMounts).toHaveBeenCalledOnce();
    // Closed, it is gone; opened again, it starts anew when it shows.
    act(() => useApp.getState().closeSidebarTab("code"));
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

  it("asks before closing the HTML tab over unsaved edits: stay, or close without saving", async () => {
    useApp.setState({ sidebarTabs: ["chat", "code"], sidebarTab: "code", codeDirty: true });
    render(<Sidebar />);
    expect(screen.getByTestId("code-mark").title).toBe("Unsaved changes");
    fireEvent.click(screen.getByRole("button", { name: "Close HTML" }));
    await act(async () => void (await answerUnsaved("cancel")));
    expect(tabNames()).toEqual(["Chat", "HTML"]);
    fireEvent.click(screen.getByRole("button", { name: "Close HTML" }));
    await act(async () => void (await answerUnsaved("discard")));
    await waitFor(() => expect(tabNames()).toEqual(["Chat"]));
    expect(ask).not.toHaveBeenCalled();
  });

  it("saves the HTML tab's edits before closing it, when asked to", async () => {
    useApp.setState({ sidebarTabs: ["chat", "code"], sidebarTab: "code", codeDirty: true });
    const save = vi.fn(async () => useApp.getState().setCodeDirty(false));
    const gone = provideCodeSave(save);
    render(<Sidebar />);
    fireEvent.click(screen.getByRole("button", { name: "Close HTML" }));
    await act(async () => void (await answerUnsaved("save")));
    await waitFor(() => expect(tabNames()).toEqual(["Chat"]));
    expect(save).toHaveBeenCalledOnce();
    gone();
  });

  it("closes the HTML tab without asking when nothing is unsaved", async () => {
    useApp.setState({ sidebarTabs: ["chat", "code"], sidebarTab: "chat" });
    render(<Sidebar />);
    expect(screen.queryByTestId("code-mark")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close HTML" }));
    expect(tabNames()).toEqual(["Chat"]);
    expect(await unsavedAsked()).toBe(false);
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

  it("opens the app's settings in a tab from the button at the bottom", () => {
    render(<Sidebar />);
    const settings = screen.getByRole("button", { name: "App settings" });
    expect(settings.getAttribute("aria-pressed")).toBe("false");
    expect(settings.title).toBe("App settings (Ctrl+,)");
    fireEvent.click(settings);
    expect(tabNames()).toEqual(["Chat", "Files", "App settings"]);
    expect(shown("settings")).toBe(true);
    expect(screen.getByRole("button", { name: "App settings" }).getAttribute("aria-pressed")).toBe("true");
    // A second press keeps the one tab.
    fireEvent.click(screen.getByRole("button", { name: "App settings" }));
    expect(tabNames()).toEqual(["Chat", "Files", "App settings"]);
  });

  it("opens the keyboard shortcuts from the button beside the settings", () => {
    render(<Sidebar />);
    const shortcuts = screen.getByRole("button", { name: "Keyboard shortcuts" });
    expect(shortcuts.previousElementSibling).toBe(screen.getByRole("button", { name: "App settings" }));
    expect(shortcuts.title).toBe("Keyboard shortcuts (?, Ctrl+/)");
    fireEvent.click(shortcuts);
    expect(useApp.getState().shortcutHelpOpen).toBe(true);
  });

  describe("a tab's close button", () => {
    const close = (name: string) => screen.getByRole("button", { name: `Close ${name}` });

    it("sits on the tab's trailing edge, the icon staying where it is", () => {
      render(<Sidebar />);
      // After the tab itself, not over its icon: a click meant for the tab stays the tab's.
      expect(tab("Files").nextElementSibling).toBe(close("Files"));
      expect(close("Files").className).not.toContain("absolute");
      const icon = tab("Files").querySelector("svg")!;
      expect(icon.getAttribute("class")).not.toMatch(/invisible/);
    });

    it("shows on the active tab, and on the others when hovered or focused", () => {
      render(<Sidebar />);
      expect(close("Chat").className).toMatch(/(^| )opacity-100( |$)/);
      const other = close("Files").className;
      expect(other).toMatch(/(^| )opacity-0( |$)/);
      expect(other).toContain("group-hover:opacity-100");
      expect(other).toContain("group-focus-within:opacity-100");
      // Never out of the keyboard's reach.
      expect(other).not.toContain("invisible");
    });

    it("closes the tab on a middle click, and leaves the other buttons' clicks alone", () => {
      render(<Sidebar />);
      fireEvent(tab("Files"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
      expect(tabNames()).toEqual(["Chat", "Files"]);
      fireEvent(tab("Files"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
      expect(tabNames()).toEqual(["Chat"]);
    });

    it("asks about unsaved edits on a middle click too", async () => {
      useApp.setState({ sidebarTabs: ["chat", "code"], sidebarTab: "chat", codeDirty: true });
      render(<Sidebar />);
      fireEvent(tab("HTML"), new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
      await act(async () => void (await answerUnsaved("cancel")));
      expect(tabNames()).toEqual(["Chat", "HTML"]);
    });
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

  describe("when the tabs don't fit", () => {
    // jsdom lays nothing out, so give the strip its sizes by hand.
    const lay = (
      strip: HTMLElement,
      { width, content, left = 0 }: { width: number; content: number; left?: number },
    ) => {
      Object.defineProperty(strip, "clientWidth", { configurable: true, value: width });
      Object.defineProperty(strip, "scrollWidth", { configurable: true, value: content });
      strip.scrollLeft = left;
      fireEvent.scroll(strip);
    };
    const scrollButtons = () => screen.queryAllByRole("button", { name: /^Scroll tabs/ });

    it("shows no scroll buttons or fade while the tabs fit", () => {
      render(<Sidebar />);
      const strip = screen.getByRole("tablist");
      expect(strip.className).toContain("no-scrollbar");
      lay(strip, { width: 200, content: 200 });
      expect(scrollButtons()).toEqual([]);
      expect(strip.dataset.fade).toBeUndefined();
    });

    it("fades the cut-off ends and scrolls with the buttons, each off at its end", () => {
      render(<Sidebar />);
      const strip = screen.getByRole("tablist");
      const scrollBy = vi.fn();
      strip.scrollBy = scrollBy;

      lay(strip, { width: 100, content: 300 });
      const left = screen.getByRole("button", { name: "Scroll tabs left" }) as HTMLButtonElement;
      const right = screen.getByRole("button", { name: "Scroll tabs right" }) as HTMLButtonElement;
      expect(left.disabled).toBe(true);
      expect(right.disabled).toBe(false);
      expect(strip.dataset.fade).toBe("right");

      fireEvent.click(right);
      expect(scrollBy).toHaveBeenCalledWith({ left: 75, behavior: "smooth" });

      lay(strip, { width: 100, content: 300, left: 200 });
      expect(left.disabled).toBe(false);
      expect(right.disabled).toBe(true);
      expect(strip.dataset.fade).toBe("left");
      fireEvent.click(left);
      expect(scrollBy).toHaveBeenLastCalledWith({ left: -75, behavior: "smooth" });
    });
  });
});
