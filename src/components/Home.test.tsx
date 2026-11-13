import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type DragDrop = { payload: { type: "enter" | "over" | "leave" | "drop"; paths?: string[] } };
let dragDrop: ((event: DragDrop) => void) | null = null;
const unlistenDragDrop = vi.fn();
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (handler: (event: DragDrop) => void) => {
      dragDrop = handler;
      return unlistenDragDrop;
    },
  }),
}));

import type { RecentDeck, RecentWorkspace } from "../lib/api";
import { useApp } from "../store";
import { lastError, toastTexts } from "../store/errors";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke, open as openDialog } from "../test/tauri";
import { Home } from "./Home";

const NOW = Date.now();
const LIBRARY = "/Users/me/Documents/SlopSlide";
let recent: RecentWorkspace[];
let recentDecks: RecentDeck[];
let importSkipped: string[];
/** Held, the backend answers `create_deck` and `import_pptx` only once it is let go. */
let hold: Promise<void> | null;

beforeEach(() => {
  localStorage.clear();
  importSkipped = [];
  hold = null;
  dragDrop = null;
  unlistenDragDrop.mockClear();
  recent = [
    { path: "/Users/me/talks", name: "talks", openedMs: NOW - 5 * 60_000 },
    { path: "/Users/me/work/q3", name: "q3", openedMs: NOW - 3 * 3_600_000 },
  ];
  recentDecks = [];
  invoke.mockReset().mockImplementation(async (command: string, args?: { path?: string; id?: string }) => {
    switch (command) {
      case "recent_workspaces":
        return recent;
      case "recent_decks":
        return recentDecks;
      case "forget_workspace":
        recent = recent.filter((w) => w.path !== args?.path);
        return;
      case "forget_deck":
        recentDecks = recentDecks.filter((d) => d.path !== args?.path);
        return;
      case "library_folder":
        return LIBRARY;
      case "open_workspace":
        return { path: args?.path, name: args?.path?.split("/").pop() };
      case "create_deck":
        await hold;
        return { ...deckFor(DECK_HTML), id: `${LIBRARY}/talk/deck.html`, path: `${LIBRARY}/talk/deck.html` };
      case "open_deck":
        return { ...deckFor(DECK_HTML), id: args?.id, path: args?.id };
      case "import_pptx":
        await hold;
        return {
          deck: { ...deckFor(DECK_HTML), id: `${LIBRARY}/q3/deck.html`, path: `${LIBRARY}/q3/deck.html` },
          skipped: importSkipped,
        };
      case "load_chat":
        return null;
      case "list_templates":
        return [
          { id: "mine", title: "Mine", builtin: false, path: "/t/mine", slides: ["cover"] },
          { id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title"] },
        ];
      case "agent_running":
        return false;
    }
  });
  openDialog.mockReset();
  useApp.setState({ workspace: null, openedFile: null, deck: null, toasts: [] });
});

const rows = () => screen.queryAllByRole("listitem");
const createButton = () => screen.getByRole("button", { name: /Create deck|Creating/ }) as HTMLButtonElement;
/** A promise the test resolves, to hold the backend's answer back. */
function held() {
  let release = () => {};
  hold = new Promise<void>((resolve) => (release = resolve));
  return () => release();
}
/** Lets go of `paths` over the window. */
const drop = (paths: string[]) => act(async () => dragDrop!({ payload: { type: "drop", paths } }));

describe("Home", () => {
  it("lists the folders opened before, newest first, with their ages", async () => {
    render(<Home />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows()[0]!.textContent).toContain("talks");
    expect(rows()[0]!.textContent).toContain("/Users/me/talks");
    expect(rows()[0]!.textContent).toContain("5m ago");
    expect(rows()[1]!.textContent).toContain("3h ago");
  });

  it("hides the recent list when no folder was opened before", async () => {
    recent = [];
    render(<Home />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("recent_workspaces"));
    expect(screen.queryByText("Recent folders")).toBeNull();
  });

  it("reports a recent list that cannot be read", async () => {
    invoke.mockRejectedValue("cannot locate home folder");
    render(<Home />);
    await waitFor(() => expect(lastError(useApp.getState())).toBe("cannot locate home folder"));
  });

  it("opens a recent folder when it is clicked", async () => {
    render(<Home />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await act(async () => fireEvent.click(screen.getByText("q3")));
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: "/Users/me/work/q3" });
    expect(useApp.getState().workspace).toEqual({ path: "/Users/me/work/q3", name: "q3" });
  });

  it("removes a folder from the recent list", async () => {
    render(<Home />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await act(async () => fireEvent.click(screen.getByLabelText("Remove talks from recent folders")));
    expect(invoke).toHaveBeenCalledWith("forget_workspace", { path: "/Users/me/talks" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
  });

  it("opens the folder picked in the dialog", async () => {
    openDialog.mockResolvedValue("/Users/me/new");
    render(<Home />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Open folder/ })));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: "/Users/me/new" });
  });

  it("opens a picked deck in its folder", async () => {
    openDialog.mockResolvedValue("/Users/me/talks/q3/deck.html");
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command: string, args?: { path?: string; id?: string }) =>
      command === "open_file"
        ? { path: args?.path, absolute: `/Users/me/talks/q3/${args?.path}`, kind: "deck" }
        : base(command, args),
    );
    render(<Home />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Open deck/ })));
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "HTML deck", extensions: ["html", "htm"] }] }),
    );
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: "/Users/me/talks/q3" });
    await waitFor(() => expect(useApp.getState().deck?.id).toBe("/Users/me/talks/q3/deck.html"));
    expect(useApp.getState().chatKey).toBe("/Users/me/talks/q3/deck.html");
  });

  it("opens no deck when its folder cannot open", async () => {
    openDialog.mockResolvedValue("/Users/me/talks/q3/deck.html");
    invoke.mockImplementation(async (command: string) => {
      if (command === "open_workspace") throw "q3 is already open in another window.";
      return [];
    });
    render(<Home />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Open deck/ })));
    expect(lastError(useApp.getState())).toBe("q3 is already open in another window.");
    expect(invoke).not.toHaveBeenCalledWith("open_file", expect.anything());
  });

  it("does nothing when the folder dialog is cancelled", async () => {
    openDialog.mockResolvedValue(null);
    render(<Home />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Open folder/ })));
    expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
  });

  it("opens the SlopSlide library", async () => {
    render(<Home />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /SlopSlide library/ })));
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: LIBRARY });
  });

  it("creates a deck with the typed title in the library", async () => {
    render(<Home />);
    const input = screen.getByPlaceholderText(/Deck title/);
    fireEvent.change(input, { target: { value: "  Quarterly update  " } });
    await act(async () => fireEvent.click(createButton()));
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: LIBRARY });
    expect(invoke).toHaveBeenCalledWith("create_deck", { title: "Quarterly update", template: null });
    await waitFor(() => expect(useApp.getState().deck).not.toBeNull());
    expect(useApp.getState().openedFile).toEqual({
      path: "talk/deck.html",
      absolute: `${LIBRARY}/talk/deck.html`,
      kind: "deck",
    });
  });

  it("creates an untitled deck when no title is given", async () => {
    render(<Home />);
    await act(async () => fireEvent.submit(screen.getByPlaceholderText(/Deck title/)));
    expect(invoke).toHaveBeenCalledWith("create_deck", { title: "Untitled deck", template: null });
  });

  it("does not create a deck when the library cannot be opened", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "library_folder") return LIBRARY;
      if (command === "open_workspace") throw "not a folder";
      return [];
    });
    render(<Home />);
    await act(async () => fireEvent.submit(screen.getByPlaceholderText(/Deck title/)));
    expect(lastError(useApp.getState())).toBe("not a folder");
    expect(invoke).not.toHaveBeenCalledWith("create_deck", expect.anything());
  });

  it("offers the templates as styles for a new deck", async () => {
    useApp.setState({ templates: undefined });
    render(<Home />);
    const style = screen.getByLabelText("Style") as HTMLSelectElement;
    await waitFor(() => expect(style.options).toHaveLength(3));
    expect([...style.options].map((o) => o.textContent)).toEqual(["Any style", "Mine (yours)", "Swiss Design"]);
    fireEvent.change(style, { target: { value: "swiss" } });
    fireEvent.change(screen.getByPlaceholderText(/Deck title/), { target: { value: "Board" } });
    await act(async () => fireEvent.click(createButton()));
    expect(invoke).toHaveBeenCalledWith("create_deck", { title: "Board", template: "swiss" });
  });

  it("imports a PowerPoint file into the library and opens the new deck", async () => {
    openDialog.mockResolvedValue("/Users/me/Downloads/q3.pptx");
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Import PowerPoint…" }));
    await waitFor(() => expect(useApp.getState().deck?.id).toBe(`${LIBRARY}/q3/deck.html`));
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: LIBRARY });
    expect(invoke).toHaveBeenCalledWith("import_pptx", { path: "/Users/me/Downloads/q3.pptx" });
    expect(lastError(useApp.getState())).toBeNull();
  });

  it("opens no workspace when the PowerPoint dialog is cancelled", async () => {
    openDialog.mockResolvedValue(null);
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Import PowerPoint…" }));
    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith("import_pptx", expect.anything());
    expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
  });

  it("says what an import had to change", async () => {
    importSkipped = ["charts (their data came along as tables)"];
    openDialog.mockResolvedValue("/Users/me/Downloads/q3.pptx");
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Import PowerPoint…" }));
    await waitFor(() =>
      expect(toastTexts(useApp.getState(), "info")).toEqual([
        "Imported, with these changes: charts (their data came along as tables).",
      ]),
    );
    // It is something to know, not a failure.
    expect(lastError(useApp.getState())).toBeNull();
  });

  describe("the new deck form", () => {
    it("is headed New deck, over a labelled Title field that has the focus", () => {
      render(<Home />);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("New deck");
      const title = screen.getByRole("textbox", { name: "Title" });
      expect(title).toBe(screen.getByPlaceholderText(/Deck title/));
      expect(document.activeElement).toBe(title);
    });

    it("says it is creating, and takes no second submit meanwhile", async () => {
      const release = held();
      render(<Home />);
      const form = createButton().closest("form")!;
      await act(async () => fireEvent.submit(form));
      await waitFor(() => expect(createButton().textContent).toBe("Creating…"));
      expect(createButton().disabled).toBe(true);
      expect(createButton().getAttribute("aria-busy")).toBe("true");
      expect((screen.getByRole("textbox", { name: "Title" }) as HTMLInputElement).closest("fieldset")!.disabled).toBe(
        true,
      );
      await act(async () => fireEvent.submit(form));
      await act(async () => release());
      await waitFor(() => expect(useApp.getState().deck).not.toBeNull());
      expect(invoke.mock.calls.filter(([command]) => command === "create_deck")).toHaveLength(1);
    });

    it("is ready again after a creation that failed", async () => {
      const base = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command: string, args?: object) => {
        if (command === "create_deck") throw "a deck of that name exists";
        return base(command, args);
      });
      render(<Home />);
      await act(async () => fireEvent.submit(createButton().closest("form")!));
      expect(lastError(useApp.getState())).toBe("a deck of that name exists");
      expect(createButton().disabled).toBe(false);
      expect(createButton().textContent).toBe("Create deck");
    });
  });

  describe("importing a PowerPoint file", () => {
    const importButton = () => screen.getByRole("button", { name: /Import/ }) as HTMLButtonElement;

    it("sits with the other ways to open something", () => {
      render(<Home />);
      const row = screen.getByRole("button", { name: /Open folder/ }).parentElement!;
      expect(
        within(row)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Open folder…", "Open deck…", "SlopSlide library", "Import PowerPoint…"]);
      expect(importButton().className).toBe(screen.getByRole("button", { name: /Open deck/ }).className);
    });

    it("says which file it is importing, and neither imports nor creates anything else meanwhile", async () => {
      const release = held();
      openDialog.mockResolvedValue("/Users/me/Downloads/q3.pptx");
      render(<Home />);
      fireEvent.click(importButton());
      await waitFor(() => expect(importButton().textContent).toBe("Importing q3.pptx…"));
      expect(importButton().disabled).toBe(true);
      expect(createButton().closest("fieldset")!.disabled).toBe(true);
      await act(async () => fireEvent.submit(createButton().closest("form")!));
      expect(invoke).not.toHaveBeenCalledWith("create_deck", expect.anything());
      await act(async () => release());
      await waitFor(() => expect(useApp.getState().deck?.id).toBe(`${LIBRARY}/q3/deck.html`));
      expect(invoke.mock.calls.filter(([command]) => command === "import_pptx")).toHaveLength(1);
    });
  });

  describe("recent decks", () => {
    beforeEach(() => {
      recentDecks = [
        {
          path: `${LIBRARY}/pitch/deck.html`,
          title: "Series A pitch",
          workspace: LIBRARY,
          openedMs: NOW - 2 * 60_000,
        },
        { path: "/Users/me/talks/q3.html", title: "", workspace: "/Users/me/talks", openedMs: NOW - 2 * 86_400_000 },
      ];
    });
    const deckRows = () => within(screen.getByRole("list", { name: "Recent decks" })).getAllByRole("listitem");

    it("come before the recent folders, each with its title, folder and age", async () => {
      render(<Home />);
      await waitFor(() => expect(rows()).toHaveLength(4));
      expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
        "Open",
        "Recent decks",
        "Recent folders",
      ]);
      expect(deckRows()[0]!.textContent).toContain("Series A pitch");
      expect(deckRows()[0]!.textContent).toContain(`${LIBRARY}/pitch`);
      expect(deckRows()[0]!.textContent).toContain("2m ago");
      // A deck without a title still has a name to press.
      expect(deckRows()[1]!.textContent).toContain("Untitled");
      expect(deckRows()[1]!.textContent).toContain("2d ago");
    });

    it("open the folder the deck was in, then the deck", async () => {
      const base = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command: string, args?: { path?: string; id?: string }) =>
        command === "open_file"
          ? { path: args?.path, absolute: `${LIBRARY}/${args?.path}`, kind: "deck" }
          : base(command, args),
      );
      render(<Home />);
      await waitFor(() => expect(rows()).toHaveLength(4));
      await act(async () => fireEvent.click(screen.getByText("Series A pitch")));
      expect(invoke).toHaveBeenCalledWith("open_workspace", { path: LIBRARY });
      expect(invoke).toHaveBeenCalledWith("open_file", { path: "pitch/deck.html" });
      await waitFor(() => expect(useApp.getState().deck?.id).toBe(`${LIBRARY}/pitch/deck.html`));
    });

    it("can be taken off the list", async () => {
      render(<Home />);
      await waitFor(() => expect(rows()).toHaveLength(4));
      await act(async () => fireEvent.click(screen.getByLabelText("Remove Series A pitch from recent decks")));
      expect(invoke).toHaveBeenCalledWith("forget_deck", { path: `${LIBRARY}/pitch/deck.html` });
      await waitFor(() => expect(deckRows()).toHaveLength(1));
      expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
    });

    it("are left out when no deck was opened before", async () => {
      recentDecks = [];
      render(<Home />);
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(screen.queryByText("Recent decks")).toBeNull();
    });
  });

  it("shows the button that takes a row off the list dimmed, not hidden", async () => {
    render(<Home />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    const remove = screen.getByLabelText("Remove talks from recent folders");
    expect(remove.className).toContain("opacity-40");
    expect(remove.className).not.toMatch(/(^| )opacity-0( |$)/);
    expect(remove.className).toContain("group-hover:opacity-100");
  });

  it("says how to start when nothing was opened before, and only then", async () => {
    recent = [];
    const { unmount } = render(<Home />);
    expect((await screen.findByTestId("first-run")).textContent).toMatch(/Nothing opened yet/);
    unmount();
    recent = [{ path: "/Users/me/talks", name: "talks", openedMs: NOW }];
    render(<Home />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByTestId("first-run")).toBeNull();
  });

  it("shows the lists as last read at once when it comes back, and reads them again", async () => {
    const { unmount } = render(<Home />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    unmount();
    // Meanwhile a folder was opened: it is on the list the backend has now.
    recent = [{ path: "/Users/me/new", name: "new", openedMs: NOW }, ...recent];
    invoke.mockClear();
    render(<Home />);
    // Before the backend has answered: what was listed before.
    expect(rows()).toHaveLength(2);
    expect(rows()[0]!.textContent).toContain("talks");
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows()[0]!.textContent).toContain("new");
    // Both lists are asked for together, once each.
    const asked = invoke.mock.calls.map(([command]) => command).filter((c) => String(c).startsWith("recent_"));
    expect(asked.sort()).toEqual(["recent_decks", "recent_workspaces"]);
  });

  describe("dropping on the start screen", () => {
    const over = (type: "enter" | "over" | "leave") => act(() => dragDrop!({ payload: { type, paths: [] } }));

    it("shows where the drop goes while something is held over the window", async () => {
      render(<Home />);
      await waitFor(() => expect(dragDrop).not.toBeNull());
      expect(screen.queryByRole("status")).toBeNull();
      over("enter");
      expect(screen.getByRole("status").textContent).toBe("Drop a folder, a deck or a PowerPoint file to open it");
      over("leave");
      expect(screen.queryByRole("status")).toBeNull();
      over("over");
      await drop([]);
      expect(screen.queryByRole("status")).toBeNull();
      expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
    });

    it("opens a dropped folder", async () => {
      render(<Home />);
      await waitFor(() => expect(dragDrop).not.toBeNull());
      await drop(["/Users/me/talks"]);
      expect(invoke).toHaveBeenCalledWith("open_workspace", { path: "/Users/me/talks" });
      await waitFor(() => expect(useApp.getState().workspace?.path).toBe("/Users/me/talks"));
    });

    it("opens a dropped deck in its folder, as choosing it does", async () => {
      const base = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command: string, args?: { path?: string; id?: string }) =>
        command === "open_file"
          ? { path: args?.path, absolute: `/Users/me/talks/q3/${args?.path}`, kind: "deck" }
          : base(command, args),
      );
      render(<Home />);
      await waitFor(() => expect(dragDrop).not.toBeNull());
      await drop(["/Users/me/talks/q3/deck.html"]);
      expect(invoke).toHaveBeenCalledWith("open_workspace", { path: "/Users/me/talks/q3" });
      await waitFor(() => expect(useApp.getState().deck?.id).toBe("/Users/me/talks/q3/deck.html"));
    });

    it("imports a dropped PowerPoint file into the library", async () => {
      render(<Home />);
      await waitFor(() => expect(dragDrop).not.toBeNull());
      await drop(["/Users/me/Downloads/q3.PPTX"]);
      await waitFor(() => expect(useApp.getState().deck?.id).toBe(`${LIBRARY}/q3/deck.html`));
      expect(invoke).toHaveBeenCalledWith("open_workspace", { path: LIBRARY });
      expect(invoke).toHaveBeenCalledWith("import_pptx", { path: "/Users/me/Downloads/q3.PPTX" });
    });

    it("says why what was dropped could not open", async () => {
      const base = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
        if (command === "open_workspace") throw `not a folder: ${args?.path}`;
        return base(command, args);
      });
      render(<Home />);
      await waitFor(() => expect(dragDrop).not.toBeNull());
      await drop(["/Users/me/notes.txt"]);
      await waitFor(() => expect(lastError(useApp.getState())).toBe("not a folder: /Users/me/notes.txt"));
    });

    it("stops listening as it goes, leaving later drops to the chat of the open folder", async () => {
      const { unmount } = render(<Home />);
      await waitFor(() => expect(dragDrop).not.toBeNull());
      const listener = dragDrop!;
      unmount();
      expect(unlistenDragDrop).toHaveBeenCalledOnce();
      // A drop that still reaches it does nothing.
      await act(async () => listener({ payload: { type: "drop", paths: ["/Users/me/talks"] } }));
      expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
    });
  });

  it("opens a folder on Ctrl+O", async () => {
    openDialog.mockResolvedValue("/Users/me/new");
    render(<Home />);
    await act(async () => fireEvent.keyDown(document.body, { key: "o", ctrlKey: true }));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: "/Users/me/new" });
  });
});
