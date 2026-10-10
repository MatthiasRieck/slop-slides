import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
// The tabs' contents have their own tests.
vi.mock("./ChatPanel", () => ({ ChatPanel: () => <div data-testid="chat" /> }));
vi.mock("./FileTree", () => ({ FileTree: () => <div data-testid="files" /> }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  localStorage.clear();
  useApp.setState({ workspace: { path: "/ws", name: "ws" }, deck: deckFor(DECK_HTML), sidebarTab: "chat", sidebarOpen: true });
});

const tab = (name: string) => screen.getByRole("tab", { name });

describe("Sidebar", () => {
  it("shows one tab at a time and switches between them", () => {
    render(<Sidebar />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Chat", "Files"]);
    expect(tab("Chat").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("chat")).not.toBeNull();
    expect(screen.queryByTestId("files")).toBeNull();
    fireEvent.click(tab("Files"));
    expect(useApp.getState().sidebarTab).toBe("files");
    expect(tab("Files").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("files")).not.toBeNull();
    expect(screen.queryByTestId("chat")).toBeNull();
  });

  it("explains the chat needs a deck, and points to the files", () => {
    useApp.setState({ deck: null });
    render(<Sidebar />);
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(screen.getByText("No presentation open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show files" }));
    expect(useApp.getState().sidebarTab).toBe("files");
  });
});
