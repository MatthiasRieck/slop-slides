import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry } from "../lib/api";
import { useApp } from "../store";
import { useConfirmQuestion } from "../store/confirm";
import { lastError, toastTexts } from "../store/errors";
import { invoke, revealItemInDir } from "../test/tauri";
import { FileTree, TREE_RELOAD_DELAY } from "./FileTree";

const entry = (path: string, kind: WorkspaceEntry["kind"]): WorkspaceEntry => ({
  name: path.split("/").pop()!,
  path,
  kind,
});
let folders: Record<string, WorkspaceEntry[]>;

beforeEach(() => {
  localStorage.clear();
  folders = {
    "": [entry("talks", "directory"), entry("index.html", "webpage"), entry("notes.md", "file")],
    talks: [entry("talks/q3", "directory"), entry("talks/intro.html", "deck")],
    "talks/q3": [entry("talks/q3/deck.html", "deck")],
  };
  invoke.mockReset().mockImplementation(async (command: string, args?: { path?: string }) => {
    if (command === "list_dir") {
      const listing = folders[args?.path ?? ""];
      if (!listing) throw `cannot read "${args?.path}"`;
      return listing;
    }
  });
  revealItemInDir.mockReset();
  useApp.setState({
    workspace: { path: "/ws", name: "ws" },
    openedFile: null,
    workspaceChange: null,
    // The tree is on show: the sidebar is open on its tab.
    sidebarOpen: true,
    sidebarTab: "files",
    openPath: vi.fn(async () => {}),
    toasts: [],
  });
});

const items = () => screen.queryAllByRole("treeitem").map((i) => i.textContent);
const item = (name: string) => screen.getByRole("treeitem", { name }) as HTMLButtonElement;
const listed = () => invoke.mock.calls.filter(([c]) => c === "list_dir").map(([, a]) => (a as { path: string }).path);

describe("FileTree", () => {
  it("lists the workspace root, folders first", async () => {
    render(<FileTree />);
    await waitFor(() => expect(items()).toEqual(["talks", "index.html", "notes.md"]));
    expect(listed()).toEqual([""]);
    expect(screen.getByRole("treeitem", { name: "talks" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("treeitem", { name: "notes.md" }).getAttribute("aria-expanded")).toBeNull();
  });

  it("loads a folder when it is expanded and keeps it when collapsed", async () => {
    render(<FileTree />);
    await waitFor(() => expect(items()).toHaveLength(3));
    await act(async () => fireEvent.click(screen.getByRole("treeitem", { name: "talks" })));
    await waitFor(() => expect(items()).toEqual(["talks", "q3", "intro.html", "index.html", "notes.md"]));
    fireEvent.click(screen.getByRole("treeitem", { name: "talks" }));
    expect(items()).toEqual(["talks", "index.html", "notes.md"]);
    await act(async () => fireEvent.click(screen.getByRole("treeitem", { name: "talks" })));
    expect(listed()).toEqual(["", "talks"]);
  });

  it("remembers which folders were expanded", async () => {
    const first = render(<FileTree />);
    await waitFor(() => expect(items()).toHaveLength(3));
    await act(async () => fireEvent.click(screen.getByRole("treeitem", { name: "talks" })));
    first.unmount();
    render(<FileTree />);
    await waitFor(() => expect(items()).toContain("intro.html"));
  });

  it("opens files through the store and marks the open one", async () => {
    useApp.setState({ openedFile: { path: "index.html", absolute: "/ws/index.html", kind: "webpage" } });
    render(<FileTree />);
    await waitFor(() => expect(items()).toHaveLength(3));
    expect(screen.getByRole("treeitem", { name: "index.html" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("treeitem", { name: "notes.md" }));
    expect(useApp.getState().openPath).toHaveBeenCalledWith("notes.md");
  });

  it("expands the folders above the open file", async () => {
    useApp.setState({ openedFile: { path: "talks/q3/deck.html", absolute: "/ws/talks/q3/deck.html", kind: "deck" } });
    render(<FileTree />);
    await waitFor(() => expect(items()).toEqual(["talks", "q3", "deck.html", "intro.html", "index.html", "notes.md"]));
    expect(screen.getByRole("treeitem", { name: "deck.html" }).getAttribute("aria-selected")).toBe("true");
  });

  it("reloads the folders the watcher reports changes in", async () => {
    render(<FileTree />);
    await waitFor(() => expect(items()).toHaveLength(3));
    folders[""] = [...folders[""]!, entry("new.html", "deck")];
    act(() => useApp.setState({ workspaceChange: { paths: ["new.html", "elsewhere/x.png"], rev: 1 } }));
    await waitFor(() => expect(items()).toContain("new.html"));
    expect(listed()).toEqual(["", ""]);
  });

  describe("following a burst of changes", () => {
    /** The tree with `talks` open, and the listings so far forgotten. */
    async function shownTree() {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      fireEvent.click(item("talks"));
      await waitFor(() => expect(items()).toHaveLength(5));
      invoke.mockClear();
      vi.useFakeTimers();
    }
    /** What the watcher reports: ten batches, 5 ms apart. */
    const burst = () => {
      for (let rev = 1; rev <= 10; rev++) {
        const paths = [`talks/slide-${rev}.png`, "notes.md", `talks/q3/asset-${rev}.png`];
        act(() => useApp.setState({ workspaceChange: { paths, rev } }));
        act(() => void vi.advanceTimersByTime(5));
      }
    };
    afterEach(() => vi.useRealTimers());

    it("lists each folder on show once, after the reports pause", async () => {
      await shownTree();
      burst();
      expect(listed()).toEqual([]);
      await act(async () => void (await vi.advanceTimersByTimeAsync(TREE_RELOAD_DELAY)));
      // The root and the open folder; `talks/q3` was never listed, so there is nothing to refresh.
      expect(listed()).toEqual(["", "talks"]);
      await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
      expect(listed()).toEqual(["", "talks"]);
    });

    it("forgets a collapsed folder instead of listing it, and lists it when it opens again", async () => {
      await shownTree();
      fireEvent.click(item("talks"));
      act(() => useApp.setState({ workspaceChange: { paths: ["talks/new.html"], rev: 1 } }));
      await act(async () => void (await vi.advanceTimersByTimeAsync(TREE_RELOAD_DELAY)));
      expect(listed()).toEqual([]);
      folders.talks = [...folders.talks!, entry("talks/new.html", "deck")];
      fireEvent.click(item("talks"));
      await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
      expect(listed()).toEqual(["talks"]);
      expect(items()).toContain("new.html");
    });

    it("lists nothing while the tree is out of sight, and catches up once as it shows", async () => {
      await shownTree();
      act(() => useApp.setState({ sidebarOpen: false }));
      burst();
      await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
      expect(listed()).toEqual([]);
      act(() => useApp.setState({ sidebarOpen: true }));
      await act(async () => void (await vi.advanceTimersByTimeAsync(TREE_RELOAD_DELAY)));
      expect(listed()).toEqual(["", "talks"]);
    });

    it("does not list again for a report from before the tree was there", async () => {
      useApp.setState({ workspaceChange: { paths: ["notes.md"], rev: 7 } });
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      await act(async () => void (await new Promise((resolve) => setTimeout(resolve, TREE_RELOAD_DELAY + 30))));
      expect(listed()).toEqual([""]);
    });
  });

  it("refreshes every loaded folder on request", async () => {
    render(<FileTree />);
    await waitFor(() => expect(items()).toHaveLength(3));
    await act(async () => fireEvent.click(screen.getByRole("treeitem", { name: "talks" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
    expect(listed().sort()).toEqual(["", "", "talks", "talks"]);
  });

  it("reveals the folder in the file manager", async () => {
    render(<FileTree />);
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect(revealItemInDir).toHaveBeenCalledWith("/ws");
  });

  it("says when the folder is empty or cannot be read", async () => {
    folders[""] = [];
    const { unmount } = render(<FileTree />);
    await waitFor(() => expect(screen.getByText("This folder is empty.")).toBeTruthy());
    unmount();
    delete folders[""];
    render(<FileTree />);
    await waitFor(() => expect(screen.getByText('cannot read ""')).toBeTruthy());
  });

  it("starts over for another workspace", async () => {
    render(<FileTree />);
    await waitFor(() => expect(items()).toHaveLength(3));
    folders[""] = [entry("other.html", "webpage")];
    act(() => useApp.setState({ workspace: { path: "/other", name: "other" } }));
    await waitFor(() => expect(items()).toEqual(["other.html"]));
    expect(screen.getByRole("tree", { name: "Files in other" })).toBeTruthy();
  });

  it("renders nothing without a workspace", () => {
    useApp.setState({ workspace: null });
    const { container } = render(<FileTree />);
    expect(container.innerHTML).toBe("");
  });

  it("uses one icon for revealing in the file manager, apart from the open folder's", async () => {
    render(<FileTree />);
    await waitFor(() => expect(items()).toHaveLength(3));
    const reveal = screen.getByRole("button", { name: "Show in folder" });
    expect(reveal.querySelector("svg")!.getAttribute("class")).toContain("lucide-folder-search");
  });

  it("says why a folder inside could not be listed, where its entries would be", async () => {
    delete folders.talks;
    render(<FileTree />);
    await waitFor(() => expect(items()).toHaveLength(3));
    await act(async () => fireEvent.click(item("talks")));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe('cannot read "talks"');
    expect(item("talks").nextElementSibling).toBe(alert);
    // The rest of the tree stays.
    expect(items()).toEqual(["talks", "index.html", "notes.md"]);
    // Closed, the folder takes its error with it; opened again, it is read again.
    fireEvent.click(item("talks"));
    expect(screen.queryByRole("alert")).toBeNull();
    folders.talks = [entry("talks/intro.html", "deck")];
    await act(async () => fireEvent.click(item("talks")));
    await waitFor(() => expect(items()).toEqual(["talks", "intro.html", "index.html", "notes.md"]));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  describe("with the keys", () => {
    const key = (name: string, k: string) => fireEvent.keyDown(item(name), { key: k });
    const tabStops = () =>
      screen
        .getAllByRole("treeitem")
        .filter((i) => i.tabIndex === 0)
        .map((i) => i.textContent);

    it("says how deep each row is, and stops Tab at one row only", async () => {
      localStorage.setItem("slopslide.expanded:/ws", JSON.stringify(["talks", "talks/q3"]));
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(6));
      expect(screen.getAllByRole("treeitem").map((i) => i.getAttribute("aria-level"))).toEqual([
        "1",
        "2",
        "3",
        "2",
        "1",
        "1",
      ]);
      expect(tabStops()).toEqual(["talks"]);
    });

    it("stops Tab at the open file's row", async () => {
      useApp.setState({ openedFile: { path: "index.html", absolute: "/ws/index.html", kind: "webpage" } });
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      expect(tabStops()).toEqual(["index.html"]);
    });

    it("goes through the rows with the arrows, Home and End", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      item("talks").focus();
      key("talks", "ArrowDown");
      expect(document.activeElement).toBe(item("index.html"));
      expect(tabStops()).toEqual(["index.html"]);
      key("index.html", "End");
      expect(document.activeElement).toBe(item("notes.md"));
      // At the end, it stays.
      key("notes.md", "ArrowDown");
      expect(document.activeElement).toBe(item("notes.md"));
      key("notes.md", "ArrowUp");
      expect(document.activeElement).toBe(item("index.html"));
      key("index.html", "Home");
      expect(document.activeElement).toBe(item("talks"));
    });

    it("opens a folder with →, goes into it, and comes back out and closes it with ←", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      item("talks").focus();
      await act(async () => key("talks", "ArrowRight"));
      await waitFor(() => expect(items()).toHaveLength(5));
      expect(item("talks").getAttribute("aria-expanded")).toBe("true");
      key("talks", "ArrowRight");
      expect(document.activeElement).toBe(item("q3"));
      key("q3", "ArrowDown");
      expect(document.activeElement).toBe(item("intro.html"));
      // On a file, ← goes to the folder it is in; on the open folder, it closes it.
      key("intro.html", "ArrowLeft");
      expect(document.activeElement).toBe(item("talks"));
      key("talks", "ArrowLeft");
      expect(item("talks").getAttribute("aria-expanded")).toBe("false");
      expect(items()).toHaveLength(3);
    });

    it("leaves keys held with a modifier to the app", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      item("talks").focus();
      fireEvent.keyDown(item("talks"), { key: "ArrowDown", metaKey: true });
      expect(document.activeElement).toBe(item("talks"));
    });
  });

  describe("a row's menu", () => {
    const menuItems = () => within(screen.getByRole("menu")).getAllByRole("menuitem");
    /** Each choice's name, without its hint or keys. */
    const labels = () => menuItems().map((m) => m.querySelector(".font-medium")?.textContent);
    const choose = (name: string | RegExp) =>
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name }));
    const writeText = vi.fn(async (_text: string) => {});

    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
      folders[""]!.push(entry("q3.pptx", "file"));
    });

    const openMenu = async (name: string) => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(4));
      fireEvent.contextMenu(item(name), { clientX: 40, clientY: 60 });
    };

    it("opens on a right-click, where the pointer is, named after the row", async () => {
      await openMenu("index.html");
      const menu = screen.getByRole("menu", { name: "index.html" });
      expect(menu.parentElement!.style.left).toBe("40px");
      expect(menu.parentElement!.style.top).toBe("60px");
      expect(labels()).toEqual(["Open", "Add to chat", "Rename", "Show in folder", "Copy path", "Move to Trash…"]);
    });

    it("opens the file", async () => {
      await openMenu("index.html");
      choose("Open");
      expect(useApp.getState().openPath).toHaveBeenCalledWith("index.html");
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("opens or closes a folder", async () => {
      await openMenu("talks");
      expect(labels()).toEqual([
        "Expand",
        "Add to chat",
        "Rename",
        "New folder",
        "Show in folder",
        "Copy path",
        "Move to Trash…",
      ]);
      await act(async () => choose("Expand"));
      await waitFor(() => expect(item("talks").getAttribute("aria-expanded")).toBe("true"));
      fireEvent.contextMenu(item("talks"), { clientX: 40, clientY: 60 });
      expect(labels()[0]).toBe("Collapse");
    });

    it("reveals the row's file in the file manager", async () => {
      await openMenu("notes.md");
      choose("Show in folder");
      expect(revealItemInDir).toHaveBeenCalledWith("/ws/notes.md");
    });

    it("copies the row's path, and says so", async () => {
      await openMenu("notes.md");
      await act(async () => choose("Copy path"));
      expect(writeText).toHaveBeenCalledWith("/ws/notes.md");
      expect(toastTexts(useApp.getState(), "success")).toEqual(["Path copied."]);
    });

    it("says when the path could not be copied", async () => {
      writeText.mockRejectedValue("the clipboard is not available");
      await openMenu("notes.md");
      await act(async () => choose("Copy path"));
      expect(lastError(useApp.getState())).toBe("Could not copy the path: the clipboard is not available");
    });

    it("offers to import a PowerPoint file as a deck", async () => {
      const importPptx = vi.fn(async () => null);
      useApp.setState({ importPptx });
      await openMenu("q3.pptx");
      expect(labels()).toEqual([
        "Open",
        "Add to chat",
        "Import as deck",
        "Rename",
        "Show in folder",
        "Copy path",
        "Move to Trash…",
      ]);
      choose(/^Import as deck/);
      await waitFor(() => expect(importPptx).toHaveBeenCalledWith("/ws/q3.pptx"));
    });

    it("closes on Escape and on a press outside, doing nothing", async () => {
      await openMenu("index.html");
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      fireEvent.contextMenu(item("index.html"), { clientX: 40, clientY: 60 });
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(useApp.getState().openPath).not.toHaveBeenCalled();
    });

    it("opens under the row on Shift+F10", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(4));
      item("notes.md").focus();
      fireEvent.keyDown(item("notes.md"), { key: "F10", shiftKey: true });
      expect(screen.getByRole("menu", { name: "notes.md" })).toBeTruthy();
    });
  });

  describe("a deck's folder", () => {
    beforeEach(() => {
      folders[""] = [
        { ...entry("untitled-deck-7", "directory"), deckTitle: "Q3 board update" },
        entry("notes.md", "file"),
      ];
      folders["untitled-deck-7"] = [
        entry("untitled-deck-7/assets", "directory"),
        entry("untitled-deck-7/deck.html", "deck"),
      ];
    });

    it("is one row named by the deck's title, with the folder's name after it, which opens the deck", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toEqual(["Q3 board updateuntitled-deck-7", "notes.md"]));
      const row = item("Q3 board update");
      expect(row.title).toBe("untitled-deck-7 · SlopSlide deck");
      expect(row.querySelector("svg.lucide-presentation")).toBeTruthy();
      fireEvent.click(row);
      expect(useApp.getState().openPath).toHaveBeenCalledWith("untitled-deck-7/deck.html");
      // Enter does what a click does.
      fireEvent.keyDown(row, { key: "Enter" });
      expect(useApp.getState().openPath).toHaveBeenCalledTimes(2);
      expect(row.getAttribute("aria-expanded")).toBe("false");
    });

    it("shows the deck's own files from its arrow, without the deck file again", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(2));
      await act(async () => fireEvent.click(within(item("Q3 board update")).getByTestId("tree-arrow")));
      await waitFor(() => expect(items()).toEqual(["Q3 board updateuntitled-deck-7", "assets", "notes.md"]));
      expect(useApp.getState().openPath).not.toHaveBeenCalled();
    });

    it("is the open deck's row, which stays closed", async () => {
      useApp.setState({
        openedFile: { path: "untitled-deck-7/deck.html", absolute: "/ws/untitled-deck-7/deck.html", kind: "deck" },
      });
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(2));
      expect(item("Q3 board update").getAttribute("aria-selected")).toBe("true");
      expect(item("Q3 board update").getAttribute("aria-expanded")).toBe("false");
      expect(listed()).toEqual([""]);
    });

    it("offers to open the deck and show its files, and to rename the folder", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(2));
      fireEvent.contextMenu(item("Q3 board update"), { clientX: 40, clientY: 60 });
      const menu = screen.getByRole("menu", { name: "Q3 board update" });
      const names = within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.querySelector(".font-medium")?.textContent);
      expect(names).toEqual([
        "Open deck",
        "Show the deck's files",
        "Add to chat",
        "Rename folder",
        "Show in folder",
        "Copy path",
        "Move to Trash…",
      ]);
    });
  });

  describe("the filter", () => {
    const filter = () => screen.getByRole("searchbox", { name: "Filter files" }) as HTMLInputElement;
    beforeEach(() => {
      invoke.mockImplementation(async (command: string, args?: { path?: string; query?: string }) => {
        if (command === "list_dir") return folders[args?.path ?? ""] ?? [];
        if (command === "search_files")
          return args?.query === "q3"
            ? {
                found: [
                  entry("talks/q3", "directory"),
                  { ...entry("talks/q3-deck", "directory"), deckTitle: "Q3 deck" },
                ],
                truncated: false,
              }
            : { found: [], truncated: false };
      });
    });

    it("finds files anywhere in the folder, saying where each is, and goes back to the tree when cleared", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      fireEvent.change(filter(), { target: { value: "q3" } });
      await waitFor(() => expect(items()).toEqual(["q3talks", "Q3 decktalks/q3-deck"]));
      expect(invoke).toHaveBeenCalledWith("search_files", { query: "q3" });
      expect(screen.getByRole("tree").getAttribute("aria-label")).toBe("Files matching q3");
      // A deck found opens.
      fireEvent.click(item("Q3 deck"));
      expect(useApp.getState().openPath).toHaveBeenCalledWith("talks/q3-deck/deck.html");
      fireEvent.click(screen.getByRole("button", { name: "Clear the filter" }));
      expect(items()).toEqual(["talks", "index.html", "notes.md"]);
      expect(document.activeElement).toBe(filter());
    });

    it("says when nothing matches, and clears on Escape", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      fireEvent.change(filter(), { target: { value: "zzz" } });
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Nothing in ws matches “zzz”."));
      fireEvent.keyDown(filter(), { key: "Escape" });
      expect(filter().value).toBe("");
      expect(items()).toHaveLength(3);
    });

    it("shows a folder found in the tree, open", async () => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      fireEvent.change(filter(), { target: { value: "q3" } });
      await waitFor(() => expect(items()).toHaveLength(2));
      await act(async () => fireEvent.click(item("q3")));
      expect(filter().value).toBe("");
      await waitFor(() =>
        expect(items()).toEqual(["talks", "q3", "deck.html", "intro.html", "index.html", "notes.md"]),
      );
    });
  });

  describe("changing files", () => {
    const backend = (handle: (command: string, args: Record<string, string>) => unknown) =>
      invoke.mockImplementation(async (command: string, args?: Record<string, string>) => {
        if (command === "list_dir") {
          const listing = folders[args?.path ?? ""];
          if (!listing) throw `cannot read "${args?.path}"`;
          return listing;
        }
        return handle(command, args ?? {});
      });
    const menu = async (name: string) => {
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      fireEvent.contextMenu(item(name), { clientX: 40, clientY: 60 });
    };
    const choose = (name: string) =>
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: new RegExp(`^${name}`) }));
    const nameField = () => screen.getByRole("textbox", { name: /^New name for/ }) as HTMLInputElement;

    it("renames a row in place: F2 opens its name, selected up to the extension, and Enter renames", async () => {
      backend((command, args) => {
        if (command === "rename_entry") {
          folders[""] = [entry("talks", "directory"), entry("index.html", "webpage"), entry("plans.md", "file")];
          return args.name;
        }
      });
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      item("notes.md").focus();
      fireEvent.keyDown(item("notes.md"), { key: "F2" });
      expect(document.activeElement).toBe(nameField());
      expect([nameField().selectionStart, nameField().selectionEnd]).toEqual([0, 5]);
      fireEvent.change(nameField(), { target: { value: "plans.md" } });
      await act(async () => fireEvent.keyDown(nameField(), { key: "Enter" }));
      expect(invoke).toHaveBeenCalledWith("rename_entry", { path: "notes.md", name: "plans.md" });
      await waitFor(() => expect(items()).toEqual(["talks", "index.html", "plans.md"]));
    });

    it("leaves the name as it was on Escape, and says why a rename was refused", async () => {
      backend((command) => {
        if (command === "rename_entry") throw "There is already something named index.html here. Choose another name.";
      });
      await menu("notes.md");
      choose("Rename");
      fireEvent.keyDown(nameField(), { key: "Escape" });
      expect(screen.queryByRole("textbox", { name: /^New name for/ })).toBeNull();
      expect(invoke).not.toHaveBeenCalledWith("rename_entry", expect.anything());
      fireEvent.contextMenu(item("notes.md"), { clientX: 40, clientY: 60 });
      choose("Rename");
      fireEvent.change(nameField(), { target: { value: "index.html" } });
      await act(async () => fireEvent.blur(nameField()));
      expect(lastError(useApp.getState())).toBe(
        "Could not rename notes.md: There is already something named index.html here. Choose another name.",
      );
      expect(items()).toEqual(["talks", "index.html", "notes.md"]);
    });

    it("closes the open file inside a folder renamed, and opens it again where it is now", async () => {
      const closeDeck = vi.fn(async () => true);
      useApp.setState({
        closeDeck,
        openedFile: { path: "talks/intro.html", absolute: "/ws/talks/intro.html", kind: "deck" },
      });
      backend((command) => (command === "rename_entry" ? "Talks 2026" : undefined));
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(5));
      fireEvent.contextMenu(item("talks"), { clientX: 40, clientY: 60 });
      choose("Rename");
      fireEvent.change(nameField(), { target: { value: "Talks 2026" } });
      await act(async () => fireEvent.keyDown(nameField(), { key: "Enter" }));
      expect(closeDeck).toHaveBeenCalledOnce();
      expect(useApp.getState().openPath).toHaveBeenCalledWith("Talks 2026/intro.html");
    });

    it("makes a new folder in a folder, and starts naming it", async () => {
      backend((command) => {
        if (command === "create_folder") {
          folders.talks = [...folders.talks!, entry("talks/New folder", "directory")];
          return "talks/New folder";
        }
      });
      await menu("talks");
      await act(async () => choose("New folder"));
      expect(invoke).toHaveBeenCalledWith("create_folder", { parent: "talks" });
      await waitFor(() => expect(nameField().value).toBe("New folder"));
      expect(item("talks").getAttribute("aria-expanded")).toBe("true");
    });

    it("makes a folder at the top from the header", async () => {
      backend((command) => (command === "create_folder" ? "New folder" : undefined));
      render(<FileTree />);
      await waitFor(() => expect(items()).toHaveLength(3));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "New folder" })));
      expect(invoke).toHaveBeenCalledWith("create_folder", { parent: "" });
    });

    it("moves a file to the trash once the user says so, and says it did", async () => {
      backend((command) => {
        if (command === "trash_entry") folders[""] = folders[""]!.filter((e) => e.path !== "notes.md");
      });
      await menu("notes.md");
      await act(async () => choose("Move to Trash"));
      const question = useConfirmQuestion.getState().question!;
      expect(question).toMatchObject({
        title: "Move “notes.md” to the Trash?",
        confirmLabel: "Move to Trash",
        destructive: true,
      });
      await act(async () => question.answer(true));
      expect(invoke).toHaveBeenCalledWith("trash_entry", { path: "notes.md" });
      await waitFor(() => expect(items()).toEqual(["talks", "index.html"]));
      expect(toastTexts(useApp.getState(), "success")).toEqual(["Moved “notes.md” to the Trash."]);
    });

    it("leaves the file where it is when the user says no", async () => {
      backend(() => undefined);
      await menu("notes.md");
      await act(async () => choose("Move to Trash"));
      await act(async () => useConfirmQuestion.getState().question!.answer(false));
      expect(invoke).not.toHaveBeenCalledWith("trash_entry", expect.anything());
    });

    it("adds a file to the chat's next message, showing the chat", async () => {
      useApp.setState({ composerImages: [], sidebarTab: "files" });
      await menu("notes.md");
      choose("Add to chat");
      expect(useApp.getState().composerImages).toEqual(["notes.md"]);
      expect(useApp.getState().sidebarTab).toBe("chat");
    });

    it("starts a new deck from the header", async () => {
      useApp.setState({ newDeckOpen: false });
      render(<FileTree />);
      fireEvent.click(screen.getByRole("button", { name: "New deck…" }));
      expect(useApp.getState().newDeckOpen).toBe(true);
    });
  });
});
