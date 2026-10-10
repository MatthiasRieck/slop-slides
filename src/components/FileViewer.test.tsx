import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const revealItemInDir = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: (...args: unknown[]) => revealItemInDir(...args) }));

import { useApp } from "../store";
import { FileViewer } from "./FileViewer";

beforeEach(() => {
  invoke.mockReset().mockResolvedValue([]);
  revealItemInDir.mockReset();
  useApp.setState({ workspace: { path: "/ws", name: "ws" }, openedFile: null, deck: null, fileRev: 0, templates: [] });
});

const frame = () => document.querySelector("iframe");

describe("FileViewer", () => {
  it("shows a web page as it is, sandboxed, and reloads it when it changes", () => {
    useApp.setState({ openedFile: { path: "site/index.html", absolute: "/ws/site/index.html", kind: "webpage" } });
    render(<FileViewer />);
    expect(frame()!.getAttribute("src")).toBe("/__deck/.file/ws/site/index.html?v=0");
    expect(frame()!.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-popups allow-modals");
    expect(frame()!.getAttribute("title")).toBe("index.html");
    expect(screen.queryByText(/made with another tool/)).toBeNull();
    act(() => useApp.setState({ fileRev: 1 }));
    expect(frame()!.getAttribute("src")).toBe("/__deck/.file/ws/site/index.html?v=1");
  });

  it("shows another tool's slideshow as it is, saying so", () => {
    useApp.setState({ openedFile: { path: "reveal.html", absolute: "/ws/reveal.html", kind: "slideshow" } });
    render(<FileViewer />);
    expect(frame()!.getAttribute("src")).toBe("/__deck/.file/ws/reveal.html?v=0");
    expect(screen.getByText(/made with another tool/)).toBeTruthy();
  });

  it("offers the file manager for files it cannot show", () => {
    useApp.setState({ openedFile: { path: "notes.md", absolute: "/ws/notes.md", kind: "file" } });
    render(<FileViewer />);
    expect(frame()).toBeNull();
    expect(screen.getByText("There is no preview for this kind of file yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show in folder/ }));
    expect(revealItemInDir).toHaveBeenCalledWith("/ws/notes.md");
  });

  it("offers to start a deck in the workspace when nothing is open", async () => {
    render(<FileViewer />);
    expect(screen.getByText("Start a deck")).toBeTruthy();
    expect(screen.getByText(/new folder in ws/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Deck title/), { target: { value: "Board" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /New deck/ })));
    expect(invoke).toHaveBeenCalledWith("create_deck", { title: "Board", template: null });
    expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
  });
});
