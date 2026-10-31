import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const save = vi.fn();
const openDialog = vi.fn();
const revealItemInDir = vi.fn();
const listen = vi.fn();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    constructor(public onmessage: () => void) {}
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listen(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  save: (...args: unknown[]) => save(...args),
  open: (...args: unknown[]) => openDialog(...args),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: (...args: unknown[]) => revealItemInDir(...args) }));

import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { DeckActions } from "./DeckActions";
import { DeckToolbar } from "./DeckToolbar";

const WORKSPACE = { path: "/decks", name: "decks" };
const OPENED = { path: "talk/deck.html", absolute: "/decks/talk/deck.html", kind: "deck" as const };

beforeEach(() => {
  invoke.mockReset();
  save.mockReset();
  openDialog.mockReset();
  revealItemInDir.mockReset();
  listen.mockReset();
  unlisten.mockReset();
  listen.mockResolvedValue(unlisten);
  localStorage.removeItem("slopslide.video");
  useNarration.setState({ speech: null, audio: {}, audioDeck: null, render: null, download: null });
  useApp.setState({
    workspace: WORKSPACE,
    openedFile: OPENED,
    deck: deckFor(DECK_HTML),
    view: "slides",
    editing: false,
    slideMode: "view",
    sidebarOpen: true,
    railOpen: true,
    codeDirty: false,
    presenting: false,
    error: null,
    imageExport: null,
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

  it("presents right away with one screen", async () => {
    invoke.mockResolvedValue([
      {
        index: 0,
        name: "Built-in",
        x: 0,
        y: 0,
        width: 1512,
        height: 982,
        pixelWidth: 3024,
        pixelHeight: 1964,
        primary: true,
      },
    ]);
    render(<DeckActions />);
    await act(async () => fireEvent.click(presentButton()));
    expect(useApp.getState().presenting).toBe(true);
    expect(useApp.getState().screens).toBeNull();
  });

  it("asks which screens to use when several are attached", async () => {
    invoke.mockResolvedValue([
      {
        index: 0,
        name: "Built-in",
        x: 0,
        y: 0,
        width: 1512,
        height: 982,
        pixelWidth: 3024,
        pixelHeight: 1964,
        primary: true,
      },
      {
        index: 1,
        name: "Projector",
        x: 1512,
        y: 0,
        width: 1920,
        height: 1080,
        pixelWidth: 1920,
        pixelHeight: 1080,
        primary: false,
      },
    ]);
    render(<DeckActions />);
    await act(async () => fireEvent.click(presentButton()));
    expect(useApp.getState().presenting).toBe(false);
    fireEvent.click(screen.getByText("Start presenting"));
    expect(useApp.getState().presenting).toBe(true);
    expect(useApp.getState().screens).toEqual({ audience: 1, presenter: 0 });
  });

  describe("screenshots in the picker", () => {
    const attached = [
      { index: 0, name: "A", x: 0, y: 0, width: 100, height: 100, pixelWidth: 100, pixelHeight: 100, primary: true },
      { index: 1, name: "B", x: 100, y: 0, width: 100, height: 100, pixelWidth: 100, pixelHeight: 100, primary: false },
    ];

    /** Has the backend take screenshots until told to finish; `grabbed` reports the capture. */
    const capturing = () => {
      const run = { grabbed: () => {}, finish: (_: (string | null)[]) => {} };
      invoke.mockImplementation((command: string, args?: { grabbed: { onmessage: () => void } }) => {
        if (command !== "screen_previews") return Promise.resolve(attached);
        run.grabbed = () => args?.grabbed.onmessage();
        return new Promise((resolve) => (run.finish = resolve));
      });
      return run;
    };

    it("opens once the screens are captured, so that it isn't in them, and fills in after", async () => {
      const run = capturing();
      render(<DeckActions />);
      await act(async () => fireEvent.click(presentButton()));
      expect(screen.queryByText("Start presenting")).toBeNull();
      act(() => run.grabbed());
      expect(screen.getByText("Start presenting")).toBeTruthy();
      expect(screen.getAllByRole("status")).toHaveLength(2);
      await act(async () => run.finish(["data:image/png;base64,AAAA", null]));
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByAltText("A now").getAttribute("src")).toBe("data:image/png;base64,AAAA");
      expect(screen.queryByAltText("B now")).toBeNull();
    });

    it("opens anyway when capturing takes too long", async () => {
      vi.useFakeTimers();
      try {
        capturing();
        render(<DeckActions />);
        await act(async () => fireEvent.click(presentButton()));
        expect(screen.queryByText("Start presenting")).toBeNull();
        await act(async () => vi.advanceTimersByTime(150));
        expect(screen.getByText("Start presenting")).toBeTruthy();
        expect(screen.getAllByRole("status")).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stays closed when cancelled before the screenshots are there", async () => {
      const run = capturing();
      render(<DeckActions />);
      await act(async () => fireEvent.click(presentButton()));
      act(() => run.grabbed());
      fireEvent.click(screen.getByText("Cancel"));
      await act(async () => run.finish(["data:,", "data:,"]));
      expect(screen.queryByText("Start presenting")).toBeNull();
    });

    it("drops the placeholders when they cannot be taken", async () => {
      invoke.mockImplementation((command: string) =>
        command === "screen_previews" ? Promise.reject("nope") : Promise.resolve(attached),
      );
      render(<DeckActions />);
      await act(async () => fireEvent.click(presentButton()));
      expect(screen.getByText("Start presenting")).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("img")).toBeNull();
    });

    it("are not taken with one screen", async () => {
      invoke.mockResolvedValue([attached[0]]);
      render(<DeckActions />);
      await act(async () => fireEvent.click(presentButton()));
      expect(invoke.mock.calls.map(([command]) => command)).not.toContain("screen_previews");
    });
  });

  it("does not present when the picker is cancelled", async () => {
    invoke.mockResolvedValue([
      { index: 0, name: "A", x: 0, y: 0, width: 100, height: 100, pixelWidth: 100, pixelHeight: 100, primary: true },
      { index: 1, name: "B", x: 100, y: 0, width: 100, height: 100, pixelWidth: 100, pixelHeight: 100, primary: false },
    ]);
    render(<DeckActions />);
    await act(async () => fireEvent.click(presentButton()));
    fireEvent.click(screen.getByText("Cancel"));
    expect(useApp.getState().presenting).toBe(false);
    expect(screen.queryByText("Start presenting")).toBeNull();
  });

  it("presents on this screen when the screens cannot be listed", async () => {
    invoke.mockRejectedValue("nope");
    render(<DeckActions />);
    await act(async () => fireEvent.click(presentButton()));
    expect(useApp.getState().presenting).toBe(true);
  });

  it("exports to the chosen file and reveals it", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.html");
    render(<DeckActions />);
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
    render(<DeckActions />);
    await exportAs("HTML file");
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: expected }));
  });

  it("does nothing when the save dialog is cancelled", async () => {
    save.mockResolvedValue(null);
    render(<DeckActions />);
    await exportAs("HTML file");
    expect(invoke).not.toHaveBeenCalled();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("reports a failed export", async () => {
    save.mockResolvedValue("/read-only/Talk.html");
    invoke.mockRejectedValue("Permission denied (os error 13)");
    render(<DeckActions />);
    await exportAs("HTML file");
    expect(useApp.getState().error).toBe("Permission denied (os error 13)");
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("opens and closes the export menu", () => {
    render(<DeckActions />);
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
    render(<DeckActions />);
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
    render(<DeckActions />);
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
    render(<DeckActions />);
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
    render(<DeckActions />);
    await exportAs("PDF");
    expect(invoke).not.toHaveBeenCalled();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it("reports a PDF that cannot be printed", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.pdf");
    invoke.mockRejectedValue("the deck took too long to load");
    render(<DeckActions />);
    await exportAs("PDF");
    expect(useApp.getState().error).toBe("Could not save the PDF: the deck took too long to load");
    expect(revealItemInDir).not.toHaveBeenCalled();
    expect(exportButton().disabled).toBe(false);
  });

  it("does nothing when no folder is chosen", async () => {
    openDialog.mockResolvedValue(null);
    render(<DeckActions />);
    await exportAs("PNG images");
    expect(invoke).not.toHaveBeenCalled();
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("reports a folder that cannot be created", async () => {
    openDialog.mockResolvedValue("/read-only");
    invoke.mockRejectedValue("Permission denied (os error 13)");
    render(<DeckActions />);
    await exportAs("PNG images");
    expect(useApp.getState().error).toBe("Permission denied (os error 13)");
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("starts the presentation", async () => {
    invoke.mockResolvedValue([]);
    render(<DeckActions />);
    await act(async () => fireEvent.click(presentButton()));
    expect(useApp.getState().presenting).toBe(true);
  });

  it("cannot export or present an empty deck", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] } });
    render(<DeckActions />);
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
    render(<DeckActions />);
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
      options: { secondsPerSlide: 2.5, fps: 60, animate: false, narration: true, pauseBefore: 0.5, pauseAfter: 1 },
    });
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/me/Desktop/Talk.mp4");
    expect(unlisten).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Export video" })).toBeNull();
  });

  it("remembers the last choice", async () => {
    save.mockResolvedValue(null);
    render(<DeckActions />);
    openPanel();
    fireEvent.change(seconds(), { target: { value: "8" } });
    await act(async () => fireEvent.click(saveButton()));
    openPanel();
    expect(seconds().value).toBe("8");
  });

  it("leaves hidden slides out of the count", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s, i) => ({ ...s, hidden: i > 0 })) } });
    render(<DeckActions />);
    openPanel();
    expect(screen.getByText(/1 slide, 0:05 long/)).toBeTruthy();
  });

  it("refuses a slide time the backend would", () => {
    render(<DeckActions />);
    openPanel();
    fireEvent.change(seconds(), { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toMatch(/0.5 to 600 seconds/);
    expect(saveButton().disabled).toBe(true);
  });

  it("cannot record a deck whose slides are all hidden", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s) => ({ ...s, hidden: true })) } });
    render(<DeckActions />);
    openPanel();
    expect(screen.getByRole("alert").textContent).toMatch(/Every slide is hidden/);
    expect(saveButton().disabled).toBe(true);
  });

  it("does not record when the save dialog is cancelled", async () => {
    save.mockResolvedValue(null);
    render(<DeckActions />);
    openPanel();
    await act(async () => fireEvent.click(saveButton()));
    expect(invoke).not.toHaveBeenCalledWith("export_video", expect.anything());
  });

  /** The deck with narration on its first two slides; the first one's audio ready. */
  function narrated(speech: { available: boolean; modelReady: boolean }) {
    const deck = deckFor(DECK_HTML);
    const words = (n: number) => Array(n).fill("word").join(" ");
    useApp.setState({
      deck: {
        ...deck,
        slides: deck.slides.map((s, i) => ({ ...s, narration: i === 0 ? "Hello there." : i === 1 ? words(150) : "" })),
      },
    });
    invoke.mockImplementation(async (command: string) =>
      command === "speech_status"
        ? { ...speech, modelBytes: 1, downloading: false, rendering: null, voices: [], languages: [] }
        : undefined,
    );
    useNarration.setState({
      audioDeck: deck.id,
      audio: {
        intro: { slide: "intro", state: "ready", seconds: 20 },
        "#2": { slide: "#2", state: "missing", seconds: null },
      },
    });
  }

  it("speaks narration, each slide staying until its narration and the pauses end", async () => {
    narrated({ available: true, modelReady: true });
    render(<DeckActions />);
    openPanel();
    await act(async () => {});
    // 0.5 + 20 + 1 s, about 0.5 + 60 + 1 s for the 150 words not yet spoken, and 5 s.
    expect(screen.getByText(/3 slides, about 1:28 long/)).toBeTruthy();
    expect(screen.getByText(/1 slide is spoken first/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Pause before narration"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Pause after narration"), { target: { value: "0" } });
    expect(screen.getByText(/3 slides, about 1:25 long/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Pause after narration"), { target: { value: "11" } });
    expect(screen.getByRole("alert").textContent).toMatch(/0 to 10 seconds/);
    // Without narration, every slide gets the set time.
    fireEvent.click(screen.getByRole("checkbox", { name: /Speak narration/ }));
    expect(screen.queryByLabelText("Pause before narration")).toBeNull();
    expect(screen.getByText(/3 slides, 0:15 long/)).toBeTruthy();
  });

  it("asks for the voice model when narration still has to be spoken", async () => {
    narrated({ available: true, modelReady: false });
    render(<DeckActions />);
    openPanel();
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toMatch(/Download the voice model/);
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Speak narration/ }));
    expect(saveButton().disabled).toBe(false);
  });

  it("says so while narration is spoken first", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.mp4");
    invoke.mockImplementation((command: string) =>
      command === "export_video" ? new Promise<void>(() => {}) : Promise.resolve(),
    );
    render(<DeckActions />);
    openPanel();
    await act(async () => fireEvent.click(saveButton()));
    act(() => progressListener()({ payload: { phase: "narration", frame: 1, frames: 4 } as never }));
    expect(screen.getByRole("button", { name: /Speaking 2\/4/ })).toBeTruthy();
  });

  it("shows progress, and cancels quietly", async () => {
    let fail!: (reason: string) => void;
    save.mockResolvedValue("/Users/me/Desktop/Talk.mp4");
    invoke.mockImplementation((command: string) =>
      command === "export_video" ? new Promise<void>((_, reject) => (fail = reject)) : Promise.resolve(),
    );
    render(<DeckActions />);
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
    render(<DeckActions />);
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
    expect(labels).toEqual([
      "Match case",
      "Whole words",
      "Previous match",
      "Next match",
      "Replace",
      "Slide size",
      "Lint OK",
    ]);
    expect(screen.getByRole("textbox", { name: "Search slides" })).toBeTruthy();
  });

  it.each([
    ["code", { view: "code" as const }],
    ["edit", { editing: true }],
    ["narration", { slideMode: "narration" as const }],
  ])("offers the search in View mode only, not in %s", (_mode, state) => {
    useApp.setState({ lint: [], ...state });
    render(<DeckToolbar />);
    expect(screen.queryByRole("textbox", { name: "Search slides" })).toBeNull();
    useApp.setState({ view: "slides", editing: false, slideMode: "view" });
  });

  it("stays for the HTML view", () => {
    useApp.setState({ view: "code" });
    render(<DeckToolbar />);
    expect(screen.getByRole("toolbar", { name: "Deck" })).toBeTruthy();
  });

  it("leaves the row to the stage in edit mode", () => {
    useApp.setState({ editing: true });
    const { container } = render(<DeckToolbar />);
    expect(container.innerHTML).toBe("");
  });

  it("becomes the narration in narration mode", () => {
    useApp.setState({ slideMode: "narration", selected: "intro" });
    render(<DeckToolbar />);
    expect(screen.queryByRole("toolbar", { name: "Deck" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Narration" })).toBeTruthy();
  });
});
