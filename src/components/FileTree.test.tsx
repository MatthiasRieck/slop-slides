import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const revealItemInDir = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: (...args: unknown[]) => revealItemInDir(...args) }));

import type { WorkspaceEntry } from "../lib/api";
import { useApp } from "../store";
import { FileTree } from "./FileTree";

const entry = (path: string, kind: WorkspaceEntry["kind"]): WorkspaceEntry => ({ name: path.split("/").pop()!, path, kind });
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
  useApp.setState({ workspace: { path: "/ws", name: "ws" }, openedFile: null, workspaceChange: null, openPath: vi.fn(async () => {}) });
});

const items = () => screen.queryAllByRole("treeitem").map((i) => i.textContent);
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

  it("refreshes every loaded folder on request", async () => {
    render(<FileTree />);
    await waitFor(() => expect(items()).toHaveLength(3));
    await act(async () => fireEvent.click(screen.getByRole("treeitem", { name: "talks" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
    expect(listed().sort()).toEqual(["", "", "talks", "talks"]);
  });

  it("reveals the folder in the file manager", async () => {
    render(<FileTree />);
    fireEvent.click(screen.getByTitle("Show in folder"));
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
});
