import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const save = vi.fn();
const openDialog = vi.fn();
const revealItemInDir = vi.fn();
const listen = vi.fn();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listen(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  save: (...args: unknown[]) => save(...args),
  open: (...args: unknown[]) => openDialog(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: (...args: unknown[]) => revealItemInDir(...args) }));

import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { DeckToolbar } from "./DeckToolbar";

const WORKSPACE = { path: "/decks", name: "decks" };
const OPENED = { path: "talk/deck.html", absolute: "/decks/talk/deck.html", kind: "deck" as const };

const toggle = (name: "Slides" | "HTML") => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  invoke.mockReset();
  save.mockReset();
  openDialog.mockReset();
  revealItemInDir.mockReset();
  listen.mockReset();
  unlisten.mockReset();
  listen.mockResolvedValue(unlisten);
  localStorage.removeItem("slopslide.video");
  useApp.setState({
    workspace: WORKSPACE,
    openedFile: OPENED,
    deck: deckFor(DECK_HTML),
    view: "slides",
    sidebarOpen: true,
    railOpen: true,
    codeDirty: false,
    presenting: false,
    error: null,
    imageExport: null,
  });
});

describe("Slides / HTML toggle", () => {
  it("marks the current view as pressed", () => {
    render(<DeckToolbar />);
    expect(toggle("Slides").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("HTML").getAttribute("aria-pressed")).toBe("false");
  });

  it("switches to the HTML view and back", () => {
    render(<DeckToolbar />);
    fireEvent.click(toggle("HTML"));
    expect(useApp.getState().view).toBe("code");
    expect(toggle("HTML").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle("Slides"));
    expect(useApp.getState().view).toBe("slides");
    expect(localStorage.getItem("slopslide.view")).toBe("slides");
  });

  it("shows an unsaved-changes dot on the HTML button", () => {
    render(<DeckToolbar />);
    expect(screen.queryByTitle("Unsaved changes")).toBeNull();
    act(() => useApp.setState({ codeDirty: true }));
    const dot = screen.getByTitle("Unsaved changes");
    expect(toggle("HTML").contains(dot)).toBe(true);
  });

  it("explains each view in its tooltip", () => {
    render(<DeckToolbar />);
    expect(toggle("HTML").title).toMatch(/deck\.html/);
    expect(toggle("Slides").title).toMatch(/rendered slide/);
  });
});

describe("deck title", () => {
  const titleInput = () => screen.getByRole("textbox", { name: "Deck title" }) as HTMLInputElement;

  it("shows the deck title", () => {
    render(<DeckToolbar />);
    expect(titleInput().value).toBe("Talk");
  });

  it("renames on Enter", async () => {
    invoke.mockResolvedValue({ ...deckFor(DECK_HTML), title: "Board meeting" });
    render(<DeckToolbar />);
    fireEvent.change(titleInput(), { target: { value: "  Board meeting " } });
    titleInput().focus();
    await act(async () => fireEvent.keyDown(titleInput(), { key: "Enter" }));
    expect(invoke).toHaveBeenCalledWith("rename_deck", { id: "/decks/talk/deck.html", title: "Board meeting" });
    expect(useApp.getState().deck!.title).toBe("Board meeting");
    expect(titleInput().value).toBe("Board meeting");
  });

  it("renames when focus leaves the field", async () => {
    invoke.mockResolvedValue({ ...deckFor(DECK_HTML), title: "New" });
    render(<DeckToolbar />);
    fireEvent.change(titleInput(), { target: { value: "New" } });
    await act(async () => fireEvent.blur(titleInput()));
    expect(invoke).toHaveBeenCalledWith("rename_deck", { id: "/decks/talk/deck.html", title: "New" });
  });

  it("Escape restores the saved title without renaming", async () => {
    render(<DeckToolbar />);
    fireEvent.change(titleInput(), { target: { value: "Oops" } });
    titleInput().focus();
    // Escape blurs the field, and blurring normally commits the edit.
    await act(async () => fireEvent.keyDown(titleInput(), { key: "Escape" }));
    expect(titleInput().value).toBe("Talk");
    expect(document.activeElement).not.toBe(titleInput());
    expect(invoke).not.toHaveBeenCalled();
  });

  it("still renames normally after an Escape", async () => {
    invoke.mockResolvedValue({ ...deckFor(DECK_HTML), title: "Second try" });
    render(<DeckToolbar />);
    titleInput().focus();
    await act(async () => fireEvent.keyDown(titleInput(), { key: "Escape" }));
    fireEvent.change(titleInput(), { target: { value: "Second try" } });
    await act(async () => fireEvent.blur(titleInput()));
    expect(invoke).toHaveBeenCalledWith("rename_deck", { id: "/decks/talk/deck.html", title: "Second try" });
  });

  it.each([[""], ["   "], ["Talk"], [" Talk "]])("does not rename to %j", async (value) => {
    render(<DeckToolbar />);
    fireEvent.change(titleInput(), { target: { value } });
    await act(async () => fireEvent.blur(titleInput()));
    expect(invoke).not.toHaveBeenCalled();
    expect(titleInput().value).toBe("Talk");
  });

  it("reports a failed rename", async () => {
    invoke.mockRejectedValue("deck not found: talk");
    render(<DeckToolbar />);
    fireEvent.change(titleInput(), { target: { value: "New" } });
    await act(async () => fireEvent.blur(titleInput()));
    expect(useApp.getState().error).toBe("deck not found: talk");
  });

  it("picks up title changes made elsewhere (e.g. by the agent)", () => {
    render(<DeckToolbar />);
    act(() => useApp.getState().setDeck({ ...deckFor(DECK_HTML), title: "Agent's title" }));
    expect(titleInput().value).toBe("Agent's title");
  });
});

describe("deck actions", () => {
  const exportButton = () => screen.getByRole("button", { name: /Export/ }) as HTMLButtonElement;
  const presentButton = () => screen.getByRole("button", { name: /Present/ }) as HTMLButtonElement;
  async function exportAs(item: "HTML file" | "PDF" | "PNG images") {
    fireEvent.click(exportButton());
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(item) })));
  }

  it("exports to the chosen file and reveals it", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.html");
    render(<DeckToolbar />);
    await exportAs("HTML file");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: "Talk.html" }));
    expect(invoke).toHaveBeenCalledWith("export_deck", {
      id: "/decks/talk/deck.html",
      dest: "/Users/me/Desktop/Talk.html",
    });
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/me/Desktop/Talk.html");
  });

  it.each([
    [`Q3: "Plan" / <2025>?`, "Q3 Plan  2025.html"],
    [`a\\b|c*d`, "abcd.html"],
    [`///`, "presentation.html"],
  ])("suggests a file name safe on every OS for %j", async (title, expected) => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), title } });
    save.mockResolvedValue(null);
    render(<DeckToolbar />);
    await exportAs("HTML file");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: expected }));
  });

  it("does nothing when the save dialog is cancelled", async () => {
    save.mockResolvedValue(null);
    render(<DeckToolbar />);
    await exportAs("HTML file");
    expect(invoke).not.toHaveBeenCalled();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("reports a failed export", async () => {
    save.mockResolvedValue("/read-only/Talk.html");
    invoke.mockRejectedValue("Permission denied (os error 13)");
    render(<DeckToolbar />);
    await exportAs("HTML file");
    expect(useApp.getState().error).toBe("Permission denied (os error 13)");
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("opens and closes the export menu", () => {
    render(<DeckToolbar />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(exportButton());
    expect(exportButton().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "HTML fileOne self-contained file to share",
      "PDFOne page per slide, for printing or sharing",
      "PNG imagesOne image per slide, in a new folder",
      "VideoAn MP4 with each slide shown for a set time",
    ]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(exportButton());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("exports PNGs into a new folder named after the deck", async () => {
    openDialog.mockResolvedValue("/Users/me/Desktop");
    invoke.mockImplementation(async (command: string) =>
      command === "create_image_export_dir" ? "/Users/me/Desktop/Talk" : undefined,
    );
    render(<DeckToolbar />);
    await exportAs("PNG images");
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(invoke).toHaveBeenCalledWith("create_image_export_dir", {
      id: "/decks/talk/deck.html",
      parent: "/Users/me/Desktop",
    });
    expect(useApp.getState().imageExport).toEqual({ dir: "/Users/me/Desktop/Talk", slides: ["intro", "#2", "outro"] });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("prints a PDF to the chosen file and reveals it", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.pdf");
    render(<DeckToolbar />);
    await exportAs("PDF");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Talk.pdf", filters: [{ name: "PDF document", extensions: ["pdf"] }] }),
    );
    expect(invoke).toHaveBeenCalledWith("export_pdf", {
      id: "/decks/talk/deck.html",
      dest: "/Users/me/Desktop/Talk.pdf",
    });
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/me/Desktop/Talk.pdf");
    expect(useApp.getState().imageExport).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows the PDF is being written, and blocks another export meanwhile", async () => {
    let finish!: () => void;
    save.mockResolvedValue("/Users/me/Desktop/Talk.pdf");
    invoke.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<DeckToolbar />);
    await exportAs("PDF");
    expect(exportButton().textContent).toContain("Exporting…");
    expect(exportButton().disabled).toBe(true);
    await act(async () => finish());
    expect(exportButton().textContent).toContain("Export");
    expect(exportButton().textContent).not.toContain("Exporting");
    expect(exportButton().disabled).toBe(false);
  });

  it("does not export a PDF when the save dialog is cancelled", async () => {
    save.mockResolvedValue(null);
    render(<DeckToolbar />);
    await exportAs("PDF");
    expect(invoke).not.toHaveBeenCalled();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("reports a PDF that cannot be printed", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.pdf");
    invoke.mockRejectedValue("the deck took too long to load");
    render(<DeckToolbar />);
    await exportAs("PDF");
    expect(useApp.getState().error).toBe("Could not save the PDF: the deck took too long to load");
    expect(revealItemInDir).not.toHaveBeenCalled();
    expect(exportButton().disabled).toBe(false);
  });

  it("does nothing when no folder is chosen", async () => {
    openDialog.mockResolvedValue(null);
    render(<DeckToolbar />);
    await exportAs("PNG images");
    expect(invoke).not.toHaveBeenCalled();
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("reports a folder that cannot be created", async () => {
    openDialog.mockResolvedValue("/read-only");
    invoke.mockRejectedValue("Permission denied (os error 13)");
    render(<DeckToolbar />);
    await exportAs("PNG images");
    expect(useApp.getState().error).toBe("Permission denied (os error 13)");
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("starts the presentation", () => {
    render(<DeckToolbar />);
    fireEvent.click(presentButton());
    expect(useApp.getState().presenting).toBe(true);
  });

  it("cannot export or present an empty deck", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] } });
    render(<DeckToolbar />);
    expect(exportButton().disabled).toBe(true);
    expect(presentButton().disabled).toBe(true);
  });
});

describe("video export", () => {
  const exportButton = () => screen.getByRole("button", { name: /Export/ }) as HTMLButtonElement;
  const seconds = () => screen.getByLabelText("Seconds per slide") as HTMLInputElement;
  const saveButton = () => screen.getByRole("button", { name: "Save video…" }) as HTMLButtonElement;
  function openPanel() {
    fireEvent.click(exportButton());
    fireEvent.click(screen.getByRole("menuitem", { name: /Video/ }));
  }
  /** The listener the toolbar gave for progress events. */
  const progressListener = () => {
    const call = listen.mock.calls.find(([event]) => event === "video-export-progress");
    return call?.[1] as (event: { payload: { frame: number; frames: number } }) => void;
  };

  it("asks how long each slide is shown, then records the deck to the chosen file", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.mp4");
    render(<DeckToolbar />);
    openPanel();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(seconds().value).toBe("5");
    expect(screen.getByText(/3 slides, 0:15 long/)).toBeTruthy();
    fireEvent.change(seconds(), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Frame rate"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Play animations/ }));
    expect(screen.getByText(/3 slides, 0:08 long/)).toBeTruthy();
    await act(async () => fireEvent.click(saveButton()));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Talk.mp4", filters: [{ name: "MP4 video", extensions: ["mp4"] }] }),
    );
    expect(invoke).toHaveBeenCalledWith("export_video", {
      id: "/decks/talk/deck.html",
      dest: "/Users/me/Desktop/Talk.mp4",
      options: { secondsPerSlide: 2.5, fps: 60, animate: false },
    });
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/me/Desktop/Talk.mp4");
    expect(unlisten).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Export video" })).toBeNull();
  });

  it("remembers the last choice", async () => {
    save.mockResolvedValue(null);
    render(<DeckToolbar />);
    openPanel();
    fireEvent.change(seconds(), { target: { value: "8" } });
    await act(async () => fireEvent.click(saveButton()));
    openPanel();
    expect(seconds().value).toBe("8");
  });

  it("leaves hidden slides out of the count", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s, i) => ({ ...s, hidden: i > 0 })) } });
    render(<DeckToolbar />);
    openPanel();
    expect(screen.getByText(/1 slide, 0:05 long/)).toBeTruthy();
  });

  it("refuses a slide time the backend would", () => {
    render(<DeckToolbar />);
    openPanel();
    fireEvent.change(seconds(), { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toMatch(/0.5 to 600 seconds/);
    expect(saveButton().disabled).toBe(true);
  });

  it("cannot record a deck whose slides are all hidden", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s) => ({ ...s, hidden: true })) } });
    render(<DeckToolbar />);
    openPanel();
    expect(screen.getByRole("alert").textContent).toMatch(/Every slide is hidden/);
    expect(saveButton().disabled).toBe(true);
  });

  it("does not record when the save dialog is cancelled", async () => {
    save.mockResolvedValue(null);
    render(<DeckToolbar />);
    openPanel();
    await act(async () => fireEvent.click(saveButton()));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows progress, and cancels quietly", async () => {
    let fail!: (reason: string) => void;
    save.mockResolvedValue("/Users/me/Desktop/Talk.mp4");
    invoke.mockImplementation((command: string) =>
      command === "export_video" ? new Promise<void>((_, reject) => (fail = reject)) : Promise.resolve(),
    );
    render(<DeckToolbar />);
    openPanel();
    await act(async () => fireEvent.click(saveButton()));
    expect(exportButton().textContent).toContain("Exporting 0%");
    expect(exportButton().disabled).toBe(true);
    act(() => progressListener()({ payload: { frame: 45, frames: 100 } }));
    expect(exportButton().textContent).toContain("Exporting 45%");

    fireEvent.click(screen.getByRole("button", { name: "Cancel video export" }));
    expect(invoke).toHaveBeenCalledWith("cancel_video_export");
    await act(async () => fail("the video export was cancelled"));
    expect(useApp.getState().error).toBeNull();
    expect(revealItemInDir).not.toHaveBeenCalled();
    expect(exportButton().textContent).not.toContain("Exporting");
    expect(exportButton().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Cancel video export" })).toBeNull();
  });

  it("reports a video that cannot be recorded", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.mp4");
    invoke.mockRejectedValue("the deck took too long to get ready for recording the video");
    render(<DeckToolbar />);
    openPanel();
    await act(async () => fireEvent.click(saveButton()));
    expect(useApp.getState().error).toBe(
      "Could not save the video: the deck took too long to get ready for recording the video",
    );
    expect(unlisten).toHaveBeenCalled();
  });
});

describe("lint status", () => {
  const issues = [
    { rule: "unclosed-tag", severity: "error" as const, message: "<div> is never closed.", line: 12, slide: "intro" },
    { rule: "title", severity: "warning" as const, message: "Needs a title.", line: 1, slide: null },
  ];

  it("shows a pending state until the first check finishes", () => {
    useApp.setState({ lint: null });
    render(<DeckToolbar />);
    expect(screen.getByTitle(/Checking deck\.html/)).toBeTruthy();
  });

  it("shows OK and re-checks on click", () => {
    const refreshLint = vi.fn(async () => {});
    useApp.setState({ lint: [], refreshLint });
    render(<DeckToolbar />);
    fireEvent.click(screen.getByRole("button", { name: /Lint OK/ }));
    expect(refreshLint).toHaveBeenCalled();
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("counts errors and warnings and lists them in the tooltip", () => {
    useApp.setState({ lint: issues });
    render(<DeckToolbar />);
    const button = screen.getByRole("button", { name: /Lint: 1 error, 1 warning/ });
    expect(button.title).toContain("Line 12: <div> is never closed.");
    expect(button.className).toContain("text-destructive");
  });

  it("uses the warning style when there are only warnings", () => {
    useApp.setState({ lint: [issues[1]!, issues[1]!] });
    render(<DeckToolbar />);
    expect(screen.getByRole("button", { name: /Lint: 2 warnings/ }).className).toContain("text-amber-600");
  });

  it("fills the chat composer with fix instructions when clicked", () => {
    useApp.setState({ lint: issues, composerFill: null, running: false });
    render(<DeckToolbar />);
    fireEvent.click(screen.getByRole("button", { name: /Lint: 1 error/ }));
    const fill = useApp.getState().composerFill!;
    expect(fill.text).toContain("[unclosed-tag] (slide `intro`)");
    expect(fill.text).toContain("lint_deck");
  });

  it("hands slide id style errors to the agent without editing the deck", () => {
    const message =
      "CSS targets slide id `intro`; add a reusable layout class and replace its id-based selectors, preserving its appearance.";
    const deck = deckFor(DECK_HTML);
    useApp.setState({
      deck,
      lint: [{ rule: "slide-id-style", severity: "error", message, line: 337, slide: "intro" }],
      composerFill: null,
      running: false,
    });
    render(<DeckToolbar />);
    const button = screen.getByRole("button", { name: "Lint: 1 error" });
    expect(button.title).toContain(message);
    fireEvent.click(button);

    const prompt = useApp.getState().composerFill!.text;
    expect(prompt).toContain(`- line 337 error [slide-id-style] (slide \`intro\`): ${message}`);
    expect(prompt).toContain("without changing how the slides look");
    expect(prompt).toContain("run the lint_deck tool to verify");
    expect(useApp.getState().deck).toBe(deck);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is disabled while the agent works", () => {
    useApp.setState({ lint: issues, running: true });
    render(<DeckToolbar />);
    expect((screen.getByRole("button", { name: /Lint: 1 error/ }) as HTMLButtonElement).disabled).toBe(true);
    useApp.setState({ running: false });
  });
});

describe("deck toolbar", () => {
  it("renders nothing without a deck", () => {
    useApp.setState({ deck: null });
    const { container } = render(<DeckToolbar />);
    expect(container.innerHTML).toBe("");
  });

  it("holds the deck's tools, in order", () => {
    useApp.setState({ lint: [] });
    render(<DeckToolbar />);
    const toolbar = screen.getByRole("toolbar", { name: "Deck" });
    const labels = Array.from(toolbar.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label") ?? b.textContent,
    );
    expect(labels).toEqual(["Find and replace", "Slide size", "Lint OK", "Slides", "HTML", "Export", "Present"]);
  });
});
