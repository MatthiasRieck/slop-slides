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

import type { GalleryDeck, RecentWorkspace } from "../lib/api";
import { useApp } from "../store";
import { lastError } from "../store/errors";
import { useExports } from "../store/exports";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke, open as openDialog } from "../test/tauri";
import { Home } from "./Home";

const NOW = Date.now();
const LIBRARY = "/Users/me/Documents/SlopSlide";
let recent: RecentWorkspace[];
let gallery: GalleryDeck[];
const MODEL = {
  id: "m",
  label: "M",
  isDefault: true,
  efforts: [],
  defaultEffort: null,
  contextWindows: [],
  defaultContextWindow: null,
};
let providers: { id: string; installed: boolean; path: string | null; models: unknown[]; error: null }[];
const SIZE = { width: 1920, height: 1080, unit: "px" as const, pixelWidth: 1920, pixelHeight: 1080 };
/** A deck on the start screen. */
const galleryDeck = (path: string, title: string, workspace: string, ago: number, opened = true): GalleryDeck => ({
  path,
  title,
  workspace,
  modifiedMs: NOW - ago,
  openedMs: opened ? NOW - ago : null,
  size: SIZE,
});
let importChanges: { what: string; slides: number[] }[];
/** Held, the backend answers `create_deck` and `import_pptx` only once it is let go. */
let hold: Promise<void> | null;

beforeEach(() => {
  localStorage.clear();
  importChanges = [];
  hold = null;
  dragDrop = null;
  unlistenDragDrop.mockClear();
  recent = [
    { path: "/Users/me/talks", name: "talks", openedMs: NOW - 5 * 60_000 },
    { path: "/Users/me/work/q3", name: "q3", openedMs: NOW - 3 * 3_600_000 },
  ];
  gallery = [];
  providers = [{ id: "claude", installed: true, path: "/bin/claude", models: [MODEL], error: null }];
  invoke.mockReset().mockImplementation(async (command: string, args?: { path?: string; id?: string }) => {
    switch (command) {
      case "recent_workspaces":
        return recent;
      case "deck_gallery":
        return gallery;
      case "deck_workspace":
        // A deck in a folder of its own opens in the folder around it.
        return args?.path?.endsWith("/deck.html")
          ? args.path.split("/").slice(0, -2).join("/")
          : args?.path?.split("/").slice(0, -1).join("/");
      case "list_providers":
        return providers;
      case "forget_workspace":
        recent = recent.filter((w) => w.path !== args?.path);
        return;
      case "forget_deck":
        gallery = gallery.map((d) => (d.path === args?.path ? { ...d, openedMs: null } : d));
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
          changes: importChanges,
          fonts: [],
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

/** The rows of the recent folders. */
const rows = () => {
  const list = screen.queryByRole("list", { name: "Recent folders" });
  return list ? within(list).getAllByRole("listitem") : [];
};
const aboutField = () => screen.getByRole("textbox", { name: "What is the deck about?" }) as HTMLTextAreaElement;
const titleField = () => screen.getByRole("textbox", { name: "Title (optional)" }) as HTMLInputElement;
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
    await waitFor(() =>
      expect(lastError(useApp.getState())).toBe("Could not load the recent decks: cannot locate home folder"),
    );
    // With a way to try again.
    expect(useApp.getState().toasts.at(-1)?.action?.label).toBe("Retry");
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
        ? { path: args?.path, absolute: `/Users/me/talks/${args?.path}`, kind: "deck" }
        : base(command, args),
    );
    render(<Home />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Open deck/ })));
    expect(openDialog).toHaveBeenCalledWith(
      expect.objectContaining({ filters: [{ name: "HTML deck", extensions: ["html", "htm"] }] }),
    );
    // The folder around the deck's own: new decks go beside it, not among its assets.
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: "/Users/me/talks" });
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
    fireEvent.change(titleField(), { target: { value: "  Quarterly update  " } });
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

  it("creates nothing from an empty form, but an empty deck when asked for one", async () => {
    render(<Home />);
    expect(createButton().disabled).toBe(true);
    await act(async () => fireEvent.submit(createButton().closest("form")!));
    expect(invoke).not.toHaveBeenCalledWith("create_deck", expect.anything());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start with an empty deck" })));
    expect(invoke).toHaveBeenCalledWith("create_deck", { title: "Untitled deck", template: null });
  });

  it("creates a deck from what it is about, named after it, and asks the agent for it", async () => {
    render(<Home />);
    expect(document.activeElement).toBe(aboutField());
    fireEvent.change(aboutField(), { target: { value: "A pitch for the tool library. Bold and warm" } });
    await act(async () => fireEvent.keyDown(aboutField(), { key: "Enter" }));
    expect(invoke).toHaveBeenCalledWith("create_deck", { title: "A pitch for the tool library", template: null });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("send_message", expect.anything()));
  });

  it("offers ideas for what a deck could be about while the field is empty", () => {
    render(<Home />);
    const idea = screen.getByRole("button", { name: /Quarterly engineering update/ });
    fireEvent.click(idea);
    expect(aboutField().value).toMatch(/^Quarterly engineering update/);
    expect(screen.queryByRole("button", { name: /Quarterly engineering update/ })).toBeNull();
  });

  it("does not create a deck when the library cannot be opened", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "library_folder") return LIBRARY;
      if (command === "open_workspace") throw "not a folder";
      return [];
    });
    render(<Home />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start with an empty deck" })));
    expect(lastError(useApp.getState())).toBe("not a folder");
    expect(invoke).not.toHaveBeenCalledWith("create_deck", expect.anything());
  });

  it("offers the templates as styles for a new deck, as pictures, or leaves the style to the agent", async () => {
    useApp.setState({ templates: undefined });
    render(<Home />);
    const choice = () => screen.getByRole("button", { name: /^Style: / });
    expect(choice().getAttribute("aria-label")).toBe("Style: Let the agent choose");
    fireEvent.click(choice());
    const picker = await screen.findByRole("dialog", { name: "Style" });
    await waitFor(() => expect(within(picker).getAllByRole("button")).toHaveLength(3));
    expect(
      within(picker)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Let the agent choose", "Mine style", "Swiss Design style"]);
    expect(within(picker).getByRole("button", { name: "Let the agent choose" }).getAttribute("aria-current")).toBe(
      "true",
    );
    fireEvent.click(within(picker).getByRole("button", { name: "Swiss Design style" }));
    expect(screen.queryByRole("dialog", { name: "Style" })).toBeNull();
    expect(choice().getAttribute("aria-label")).toBe("Style: Swiss Design");
    fireEvent.change(titleField(), { target: { value: "Board" } });
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

  it("keeps what an import had to change for its report", async () => {
    importChanges = [{ what: "charts (their data came along as tables)", slides: [2] }];
    openDialog.mockResolvedValue("/Users/me/Downloads/q3.pptx");
    render(<Home />);
    fireEvent.click(screen.getByRole("button", { name: "Import PowerPoint…" }));
    await waitFor(() => expect(useExports.getState().reportOpen).toBe(true));
    expect(useExports.getState().report?.changes).toEqual(importChanges);
    // It is something to know, not a failure.
    expect(lastError(useApp.getState())).toBeNull();
  });

  describe("the new deck form", () => {
    it("is headed New deck, and asks first what the deck is about, with the focus there", () => {
      render(<Home />);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("New deck");
      expect(document.activeElement).toBe(aboutField());
      expect(titleField()).toBeTruthy();
    });

    it("says it is creating, and takes no second submit meanwhile", async () => {
      const release = held();
      render(<Home />);
      fireEvent.change(titleField(), { target: { value: "Talk" } });
      const form = createButton().closest("form")!;
      await act(async () => fireEvent.submit(form));
      await waitFor(() => expect(createButton().textContent).toBe("Creating…"));
      expect(createButton().disabled).toBe(true);
      expect(createButton().getAttribute("aria-busy")).toBe("true");
      expect(titleField().closest("fieldset")!.disabled).toBe(true);
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
      fireEvent.change(titleField(), { target: { value: "Talk" } });
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
      ).toEqual(["Open deck…", "Open folder…", "Import PowerPoint…", "SlopSlide library"]);
      expect(importButton().className).toBe(screen.getByRole("button", { name: /Open deck/ }).className);
    });

    it("says which file it is importing, and neither imports nor creates anything else meanwhile", async () => {
      const release = held();
      openDialog.mockResolvedValue("/Users/me/Downloads/q3.pptx");
      render(<Home />);
      fireEvent.change(titleField(), { target: { value: "Talk" } });
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

  describe("your decks", () => {
    beforeEach(() => {
      gallery = [
        galleryDeck(`${LIBRARY}/pitch/deck.html`, "Series A pitch", LIBRARY, 2 * 60_000),
        galleryDeck("/Users/me/talks/q3.html", "", "/Users/me/talks", 2 * 86_400_000),
        galleryDeck(`${LIBRARY}/notes/deck.html`, "Team notes", LIBRARY, 3 * 86_400_000, false),
      ];
    });
    const cards = () => within(screen.getByRole("list", { name: "Your decks" })).getAllByRole("listitem");

    it("come before the recent folders as pictures, each with its title, folder and age", async () => {
      render(<Home />);
      await waitFor(() => expect(cards()).toHaveLength(3));
      expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
        "Open",
        "Your decks",
        "Recent folders",
      ]);
      expect(cards()[0]!.textContent).toContain("Series A pitch");
      expect(cards()[0]!.textContent).toContain("SlopSlide / pitch");
      expect(cards()[0]!.textContent).toContain("2m ago");
      // A deck without a title still has a name to press.
      expect(cards()[1]!.textContent).toContain("Untitled");
      expect(cards()[1]!.textContent).toContain("2d ago");
      // Each shows its first slide.
      expect(cards()[0]!.querySelector("[data-slide-frame], iframe, div")).toBeTruthy();
    });

    it("open the folder the deck opens in, then the deck", async () => {
      const base = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command: string, args?: { path?: string; id?: string }) =>
        command === "open_file"
          ? { path: args?.path, absolute: `${LIBRARY}/${args?.path}`, kind: "deck" }
          : base(command, args),
      );
      render(<Home />);
      await waitFor(() => expect(cards()).toHaveLength(3));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open Series A pitch" })));
      expect(invoke).toHaveBeenCalledWith("open_workspace", { path: LIBRARY });
      expect(invoke).toHaveBeenCalledWith("open_file", { path: "pitch/deck.html" });
      await waitFor(() => expect(useApp.getState().deck?.id).toBe(`${LIBRARY}/pitch/deck.html`));
    });

    it("can be taken off the recent ones from a card's menu, the deck staying", async () => {
      render(<Home />);
      await waitFor(() => expect(cards()).toHaveLength(3));
      fireEvent.click(screen.getByRole("button", { name: "More for Series A pitch" }));
      // Only a deck opened before can be taken off them.
      expect(screen.getByRole("menu").textContent).toContain("Remove from recent decks");
      await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /Remove from recent decks/ })));
      expect(invoke).toHaveBeenCalledWith("forget_deck", { path: `${LIBRARY}/pitch/deck.html` });
      expect(invoke).not.toHaveBeenCalledWith("open_workspace", expect.anything());
      fireEvent.contextMenu(cards()[2]!);
      expect(screen.getByRole("menu").textContent).not.toContain("Remove from recent decks");
    });

    it("duplicates a deck from its menu", async () => {
      const base = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command: string, args?: { id?: string }) =>
        command === "duplicate_deck" ? `${LIBRARY}/pitch-copy/deck.html` : base(command, args),
      );
      render(<Home />);
      await waitFor(() => expect(cards()).toHaveLength(3));
      fireEvent.contextMenu(cards()[0]!);
      await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /Duplicate/ })));
      expect(invoke).toHaveBeenCalledWith("duplicate_deck", { id: `${LIBRARY}/pitch/deck.html` });
      // The list is read again, with the copy.
      expect(invoke.mock.calls.filter(([command]) => command === "deck_gallery")).toHaveLength(2);
    });

    it("moves a deck to the trash from its menu, once the user says so", async () => {
      const { useConfirmQuestion } = await import("../store/confirm");
      render(<Home />);
      await waitFor(() => expect(cards()).toHaveLength(3));
      fireEvent.click(screen.getByRole("button", { name: "More for Team notes" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Move to/ }));
      await waitFor(() => expect(useConfirmQuestion.getState().question?.title).toMatch(/^Move “Team notes” to the/));
      await act(async () => useConfirmQuestion.getState().question!.answer(true));
      await waitFor(() => expect(invoke).toHaveBeenCalledWith("trash_deck", { id: `${LIBRARY}/notes/deck.html` }));
    });

    it("are found by their title or folder once there are many", async () => {
      gallery = Array.from({ length: 10 }, (_, n) =>
        galleryDeck(`${LIBRARY}/deck-${n}/deck.html`, n === 4 ? "Board update" : `Deck ${n}`, LIBRARY, n * 60_000),
      );
      render(<Home />);
      await waitFor(() => expect(cards()).toHaveLength(10));
      fireEvent.change(screen.getByRole("searchbox", { name: "Find a deck" }), { target: { value: "board" } });
      expect(cards()).toHaveLength(1);
      expect(cards()[0]!.textContent).toContain("Board update");
      fireEvent.change(screen.getByRole("searchbox", { name: "Find a deck" }), { target: { value: "nothing" } });
      expect(screen.getByText(/No deck’s title or folder has “nothing” in it/)).toBeTruthy();
    });

    it("has no field to find one while there are few", async () => {
      render(<Home />);
      await waitFor(() => expect(cards()).toHaveLength(3));
      expect(screen.queryByRole("searchbox")).toBeNull();
    });

    it("are left out when there are none", async () => {
      gallery = [];
      render(<Home />);
      await waitFor(() => expect(rows()).toHaveLength(2));
      expect(screen.queryByText("Your decks")).toBeNull();
    });
  });

  describe("the first start", () => {
    it("says when an agent is ready", async () => {
      render(<Home />);
      expect((await screen.findByTestId("agent-check")).textContent).toContain("Claude Code is ready");
    });

    it("says how to get an agent when none is installed", async () => {
      providers = [{ id: "claude", installed: false, path: null, models: [], error: null }];
      useApp.setState({ providers: undefined });
      render(<Home />);
      const check = await screen.findByRole("alert");
      expect(check.textContent).toContain("No agent is installed yet");
      expect(check.textContent).toContain("claude.com/claude-code");
    });

    it("offers an example deck, made in the library", async () => {
      recent = [];
      const base = invoke.getMockImplementation()!;
      invoke.mockImplementation(async (command: string, args?: { id?: string }) =>
        command === "create_example_deck"
          ? {
              ...deckFor(DECK_HTML),
              id: `${LIBRARY}/example-deck/deck.html`,
              path: `${LIBRARY}/example-deck/deck.html`,
            }
          : base(command, args),
      );
      render(<Home />);
      const example = await screen.findByRole("button", { name: "Open an example deck" });
      await act(async () => fireEvent.click(example));
      expect(invoke).toHaveBeenCalledWith("open_workspace", { path: LIBRARY });
      await waitFor(() => expect(useApp.getState().deck?.id).toBe(`${LIBRARY}/example-deck/deck.html`));
    });

    it("has the app's settings and the shortcuts at its top", async () => {
      useApp.setState({ appSettingsOpen: false });
      render(<Home />);
      fireEvent.click(screen.getByRole("button", { name: "App settings…" }));
      expect(useApp.getState().appSettingsOpen).toBe(true);
      expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeTruthy();
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
    const asked = invoke.mock.calls
      .map(([command]) => command)
      .filter((c) => ["deck_gallery", "recent_workspaces"].includes(String(c)));
    expect(asked.sort()).toEqual(["deck_gallery", "recent_workspaces"]);
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
          ? { path: args?.path, absolute: `/Users/me/talks/${args?.path}`, kind: "deck" }
          : base(command, args),
      );
      render(<Home />);
      await waitFor(() => expect(dragDrop).not.toBeNull());
      await drop(["/Users/me/talks/q3/deck.html"]);
      expect(invoke).toHaveBeenCalledWith("open_workspace", { path: "/Users/me/talks" });
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

  it("opens a deck on Ctrl+O, and a folder on Ctrl+Shift+O", async () => {
    openDialog.mockResolvedValue(null);
    render(<Home />);
    await act(async () => fireEvent.keyDown(document.body, { key: "o", ctrlKey: true }));
    expect(openDialog).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Open a deck" }));
    openDialog.mockResolvedValue("/Users/me/new");
    await act(async () => fireEvent.keyDown(document.body, { key: "O", ctrlKey: true, shiftKey: true }));
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(invoke).toHaveBeenCalledWith("open_workspace", { path: "/Users/me/new" });
  });
});
