import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEntry } from "../lib/api";
import { useApp } from "../store";
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
    const labels = () => menuItems().map((m) => m.textContent);
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
      expect(labels()).toEqual(["Open", "Show in folder", "Copy path"]);
    });

    it("opens the file", async () => {
      await openMenu("index.html");
      choose("Open");
      expect(useApp.getState().openPath).toHaveBeenCalledWith("index.html");
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("opens or closes a folder", async () => {
      await openMenu("talks");
      expect(labels()).toEqual(["Expand", "Show in folder", "Copy path"]);
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
      const importPptx = vi.fn(async () => {});
      useApp.setState({ importPptx });
      await openMenu("q3.pptx");
      expect(labels()).toEqual(["Open", "Import as deckThis file stays as it is", "Show in folder", "Copy path"]);
      choose(/^Import as deck/);
      expect(importPptx).toHaveBeenCalledWith("/ws/q3.pptx");
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
});
