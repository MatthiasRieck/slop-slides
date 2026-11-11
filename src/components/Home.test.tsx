import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { RecentWorkspace } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke, open as openDialog } from "../test/tauri";
import { Home } from "./Home";

const NOW = Date.now();
const LIBRARY = "/Users/me/Documents/SlopSlide";
let recent: RecentWorkspace[];
let importSkipped: string[];

beforeEach(() => {
  localStorage.clear();
  importSkipped = [];
  recent = [
    { path: "/Users/me/talks", name: "talks", openedMs: NOW - 5 * 60_000 },
    { path: "/Users/me/work/q3", name: "q3", openedMs: NOW - 3 * 3_600_000 },
  ];
  invoke.mockReset().mockImplementation(async (command: string, args?: { path?: string; id?: string }) => {
    switch (command) {
      case "recent_workspaces":
        return recent;
      case "forget_workspace":
        recent = recent.filter((w) => w.path !== args?.path);
        return;
      case "library_folder":
        return LIBRARY;
      case "open_workspace":
        return { path: args?.path, name: args?.path?.split("/").pop() };
      case "create_deck":
        return { ...deckFor(DECK_HTML), id: `${LIBRARY}/talk/deck.html`, path: `${LIBRARY}/talk/deck.html` };
      case "open_deck":
        return { ...deckFor(DECK_HTML), id: args?.id, path: args?.id };
      case "import_pptx":
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
  useApp.setState({ workspace: null, openedFile: null, deck: null, error: null });
});

const rows = () => screen.queryAllByRole("listitem");

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
    await waitFor(() => expect(useApp.getState().error).toBe("cannot locate home folder"));
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
    expect(useApp.getState().error).toBe("q3 is already open in another window.");
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
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /New deck/ })));
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
    expect(useApp.getState().error).toBe("not a folder");
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
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /New deck/ })));
    expect(invoke).toHaveBeenCalledWith("create_deck", { title: "Board", template: "swiss" });
  });

  it("imports a PowerPoint file into the library and opens the new deck", async () => {
    openDialog.mockResolvedValue("/Users/me/Downloads/q3.pptx");
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Import PowerPoint…" }));
    await waitFor(() => expect(useApp.getState().deck?.id).toBe(`${LIBRARY}/q3/deck.html`));
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: LIBRARY });
    expect(invoke).toHaveBeenCalledWith("import_pptx", { path: "/Users/me/Downloads/q3.pptx" });
    expect(useApp.getState().error).toBeNull();
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
      expect(useApp.getState().error).toBe("Imported, with these changes: charts (their data came along as tables)."),
    );
  });
});
