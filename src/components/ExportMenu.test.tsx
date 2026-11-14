import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { lastError, toastTexts } from "../store/errors";
import { useExports } from "../store/exports";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke, listen, open as openDialog, revealItemInDir, save } from "../test/tauri";
import { DeckActions } from "./DeckActions";
import { ExportDialog } from "./lazy";

// The export dialog is loaded on first use; here it is there, as once the app has been idle.
beforeAll(ExportDialog.preload);

const DECK_ID = "/decks/talk/deck.html";
const unlisten = vi.fn();
/** Each export's id, as the frontend names it for the backend: in order. */
let ids = 0;

beforeEach(() => {
  invoke.mockReset();
  save.mockReset();
  openDialog.mockReset();
  revealItemInDir.mockReset();
  listen.mockReset();
  unlisten.mockReset();
  listen.mockResolvedValue(unlisten);
  ids = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(
    () => `job-${++ids}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  for (const format of ["pdf", "pptx", "html", "images", "video"])
    localStorage.removeItem(`slopslide.export.${format}`);
  localStorage.removeItem("slopslide.video");
  useExports.setState({ runs: [], dialog: null, importing: null, report: null, reportOpen: false });
  useNarration.setState({ speech: null, audio: {}, audioDeck: null, render: null, settings: {}, settingsDeck: null });
  useApp.setState({
    workspace: { path: "/decks", name: "decks" },
    openedFile: { path: "talk/deck.html", absolute: DECK_ID, kind: "deck" },
    deck: deckFor(DECK_HTML),
    selected: "#2",
    toasts: [],
    presenting: false,
  });
});

const exportButton = () => screen.getByRole("button", { name: /^Export/ }) as HTMLButtonElement;
const saveButton = () => screen.getByRole("button", { name: /^Save / }) as HTMLButtonElement;
const summary = () => screen.getByTestId("export-summary").textContent;

/** Opens the Export menu and picks `item`, which opens its dialog. */
function choose(item: RegExp) {
  fireEvent.click(exportButton());
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

/** Presses Save in the open dialog, and lets the export start. */
async function saveIt() {
  await act(async () => fireEvent.click(saveButton()));
}

/** The listener the export gave for `event`. */
function listener<T>(event: string) {
  const call = listen.mock.calls.findLast(([name]) => name === event);
  return call?.[1] as (event: { payload: T }) => void;
}

/** Hidden slides: the deck's second one. */
function hideSecond() {
  const deck = deckFor(DECK_HTML);
  useApp.setState({ deck: { ...deck, slides: deck.slides.map((s, i) => ({ ...s, hidden: i === 1 })) } });
}

describe("the Export menu", () => {
  it("lists every format, each opening its dialog, with what it makes in a line", () => {
    render(<DeckActions />);
    fireEvent.click(exportButton());
    expect(exportButton().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "PDF…A page per slide, to print or send",
      "PowerPoint…Editable slides; some effects simplified",
      "Web page (HTML)…One file that plays in any browser",
      "Images…A PNG or JPEG of each slide",
      "Video…An MP4 with animations and narration",
    ]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(exportButton());
    fireEvent.click(screen.getByRole("menuitem", { name: /PowerPoint/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Export PowerPoint" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("works from the keyboard", () => {
    render(<DeckActions />);
    exportButton().focus();
    fireEvent.keyDown(exportButton(), { key: " " });
    fireEvent.click(exportButton());
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(items.at(-1)!, { key: "Escape" });
    expect(document.activeElement).toBe(exportButton());
  });

  it("opens its dialogs in the body, so the panes beside the deck don't cover them", () => {
    const { container } = render(<DeckActions />);
    choose(/PDF/);
    const dialog = screen.getByRole("dialog", { name: "Export PDF" });
    expect(container.contains(dialog)).toBe(false);
  });
});

describe("the export dialog", () => {
  it("exports every shown slide by default, to the file chosen, and says it is saved", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.pdf");
    invoke.mockResolvedValue(undefined);
    render(<DeckActions />);
    choose(/PDF/);
    const range = screen.getByRole("radiogroup", { name: "Slides" });
    expect((within(range).getByRole("radio", { name: "All" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Include hidden slides/ }) as HTMLInputElement).checked).toBe(false);
    expect(summary()).toBe("3 pages of slides, with text that can be selected and searched.");
    await saveIt();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Talk.pdf", filters: [{ name: "PDF document", extensions: ["pdf"] }] }),
    );
    expect(invoke).toHaveBeenCalledWith("export_pdf", {
      id: DECK_ID,
      dest: "/Users/me/Desktop/Talk.pdf",
      jobId: "job-1",
      options: { includeHidden: false, notes: false },
    });
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved Talk.pdf"]);
    expect(revealItemInDir).not.toHaveBeenCalled();
    await act(async () => useApp.getState().toasts.at(-1)?.action?.run());
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/me/Desktop/Talk.pdf");
    expect(unlisten).toHaveBeenCalled();
    expect(useExports.getState().runs).toEqual([]);
  });

  it("exports the current slide, or a range by the numbers the rail shows", async () => {
    save.mockResolvedValue("/out/Talk.pptx");
    invoke.mockResolvedValue({ changes: [] });
    render(<DeckActions />);
    choose(/PowerPoint/);
    fireEvent.click(screen.getByRole("radio", { name: "Current slide" }));
    expect(summary()).toBe("1 slide as editable PowerPoint slides, with their speaker notes.");
    fireEvent.click(screen.getByRole("radio", { name: "Range" }));
    // From the current slide to the last.
    expect((screen.getByLabelText("First slide") as HTMLInputElement).value).toBe("2");
    expect((screen.getByLabelText("Last slide") as HTMLInputElement).value).toBe("3");
    fireEvent.change(screen.getByLabelText("First slide"), { target: { value: "4" } });
    expect(screen.getByRole("alert").textContent).toBe("Enter slide numbers from 1 to 3.");
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("First slide"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Last slide"), { target: { value: "2" } });
    expect(screen.getByRole("alert").textContent).toBe("The first slide must come before the last.");
    fireEvent.change(screen.getByLabelText("First slide"), { target: { value: "1" } });
    await saveIt();
    expect(invoke).toHaveBeenCalledWith("export_pptx", {
      id: DECK_ID,
      dest: "/out/Talk.pptx",
      jobId: "job-1",
      scope: { slides: ["intro", "#2"], includeHidden: false },
    });
  });

  it("leaves hidden slides out unless asked, and remembers the choice for that format", async () => {
    hideSecond();
    save.mockResolvedValue(null);
    render(<DeckActions />);
    choose(/PDF/);
    expect(screen.getByText("1 slide is hidden. Left out, as the show skips them.")).toBeTruthy();
    expect(summary()).toMatch(/^2 pages of slides/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Include hidden slides/ }));
    expect(summary()).toMatch(/^3 pages of slides/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    choose(/PDF/);
    expect((screen.getByRole("checkbox", { name: /Include hidden slides/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Each format has its own; all start with hidden slides left out.
    choose(/Video/);
    expect((screen.getByRole("checkbox", { name: /Include hidden slides/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("says what is wrong when the current slide is hidden", () => {
    hideSecond();
    render(<DeckActions />);
    choose(/Images/);
    fireEvent.click(screen.getByRole("radio", { name: "Current slide" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "The current slide is hidden. Tick “Include hidden slides” to export it.",
    );
    expect(saveButton().disabled).toBe(true);
  });

  it("does not export when the save dialog is cancelled", async () => {
    save.mockResolvedValue(null);
    render(<DeckActions />);
    choose(/PDF/);
    await saveIt();
    expect(invoke).not.toHaveBeenCalled();
    expect(useExports.getState().runs).toEqual([]);
  });

  it.each([
    [/PDF/, "export_pdf", "Could not save the PDF: "],
    [/PowerPoint/, "export_pptx", "Could not save the PowerPoint file: "],
    [/Web page/, "export_deck", "Could not save the web page: "],
  ])("reports a %s export that fails", async (item, command, failure) => {
    save.mockResolvedValue("/read-only/Talk");
    invoke.mockImplementation(async (name: string) => {
      if (name === command) throw "Permission denied (os error 13)";
    });
    render(<DeckActions />);
    choose(item);
    await saveIt();
    expect(lastError(useApp.getState())).toBe(`${failure}Permission denied (os error 13)`);
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    expect(exportButton().textContent).toBe("Export");
  });

  it.each([
    [`Q3: "Plan" / <2025>?`, "Q3 Plan  2025.pdf"],
    [`a\\b|c*d`, "abcd.pdf"],
    [`///`, "presentation.pdf"],
  ])("suggests a file name safe on every OS for %j", async (title, expected) => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), title } });
    save.mockResolvedValue(null);
    render(<DeckActions />);
    choose(/PDF/);
    await saveIt();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: expected }));
  });
});

describe("PDF", () => {
  it("adds a page of notes after the slides that have them, when asked", async () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s, i) => ({ ...s, notes: i === 0 ? "Hi" : "" })) } });
    save.mockResolvedValue("/out/Talk.pdf");
    invoke.mockResolvedValue(undefined);
    render(<DeckActions />);
    choose(/PDF/);
    expect(screen.getByText("A page with the notes after each slide that has them (1 of 3).")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Speaker notes/ }));
    expect(summary()).toBe("3 pages of slides, and 1 page of notes, with text that can be selected and searched.");
    await saveIt();
    expect(invoke).toHaveBeenCalledWith(
      "export_pdf",
      expect.objectContaining({ options: { includeHidden: false, notes: true } }),
    );
  });
});

describe("PowerPoint", () => {
  it("says what the file did not keep, by slide, behind the toast's Details", async () => {
    save.mockResolvedValue("/out/Talk.pptx");
    invoke.mockResolvedValue({
      changes: [
        { what: "Parts that PowerPoint cannot draw became pictures", slides: [1, 3] },
        { what: "Animations are left out", slides: [2] },
      ],
    });
    render(<DeckActions />);
    choose(/PowerPoint/);
    await saveIt();
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast.kind).toBe("success");
    expect(toast.text).toBe("Saved Talk.pptx. 2 things changed; see Details");
    expect(toast.details).toBe(
      "Slides 1, 3: Parts that PowerPoint cannot draw became pictures.\nSlide 2: Animations are left out.",
    );
    expect(toast.action?.label).toBe("Show in folder");
  });
});

describe("web page", () => {
  it("leaves out notes, narration scripts and review marks unless ticked, and says narration audio is not in it", async () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({
      deck: { ...deck, slides: deck.slides.map((s, i) => ({ ...s, notes: i === 0 ? "Hi" : "", narration: "Said" })) },
    });
    save.mockResolvedValue("/out/Talk.html");
    invoke.mockResolvedValue(undefined);
    render(<DeckActions />);
    choose(/Web page/);
    expect(summary()).toBe(
      "3 slides in one file that plays in any browser, its images inside. Without speaker notes or narration scripts.",
    );
    expect(screen.getByText(/Narration audio is not included/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Speaker notes/ }));
    expect(summary()).toMatch(/Without narration scripts\.$/);
    await saveIt();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Talk.html", filters: [{ name: "HTML web page", extensions: ["html"] }] }),
    );
    expect(invoke).toHaveBeenCalledWith("export_deck", {
      id: DECK_ID,
      dest: "/out/Talk.html",
      options: { includeHidden: false, notes: true, narration: false, review: false },
    });
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved Talk.html"]);
  });

  it("needs a slide that is not hidden", () => {
    hideSecond();
    render(<DeckActions />);
    choose(/Web page/);
    fireEvent.click(screen.getByRole("checkbox", { name: /Include hidden slides/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Current slide" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "A web page skips hidden slides, so it needs one that is not hidden.",
    );
  });
});

describe("images", () => {
  it("saves several into a new folder inside the one chosen", async () => {
    openDialog.mockResolvedValue("/Users/me/Desktop");
    invoke.mockResolvedValue({ path: "/Users/me/Desktop/Talk", count: 3 });
    render(<DeckActions />);
    choose(/Images/);
    expect(summary()).toBe("3 PNG images, 1920 × 1080 px, in a new folder named after the deck.");
    fireEvent.click(screen.getByRole("radio", { name: "JPEG" }));
    fireEvent.click(screen.getByRole("radio", { name: /^2×/ }));
    expect(summary()).toBe("3 JPEG images, 3840 × 2160 px, in a new folder named after the deck.");
    await saveIt();
    expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
    expect(invoke).toHaveBeenCalledWith("export_slide_images", {
      id: DECK_ID,
      dest: "/Users/me/Desktop",
      jobId: "job-1",
      options: { includeHidden: false, format: "jpeg", scale: 2 },
    });
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved 3 slide images in Talk"]);
    await act(async () => useApp.getState().toasts.at(-1)?.action?.run());
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/me/Desktop/Talk");
  });

  it("saves the current slide alone to a file of its own", async () => {
    save.mockResolvedValue("/out/Talk - slide 2.png");
    invoke.mockResolvedValue({ path: "/out/Talk - slide 2.png", count: 1 });
    render(<DeckActions />);
    choose(/Images/);
    fireEvent.click(screen.getByRole("radio", { name: "Current slide" }));
    expect(summary()).toBe("One PNG image, 1920 × 1080 px.");
    expect(saveButton().textContent).toBe("Save image…");
    await saveIt();
    expect(openDialog).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: "Talk - slide 2.png",
        filters: [{ name: "PNG image", extensions: ["png"] }],
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      "export_slide_images",
      expect.objectContaining({ options: { slides: ["#2"], includeHidden: false, format: "png", scale: 1 } }),
    );
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved Talk - slide 2.png"]);
  });

  it("does nothing when no folder is chosen", async () => {
    openDialog.mockResolvedValue(null);
    render(<DeckActions />);
    choose(/Images/);
    await saveIt();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("progress and cancel", () => {
  /** Starts a PDF export that runs until `finish` or `fail`. */
  async function startPdf() {
    const run = { finish: () => {}, fail: (_reason: string) => {} };
    save.mockResolvedValue("/Users/me/Desktop/Talk.pdf");
    invoke.mockImplementation((command: string) =>
      command === "export_pdf"
        ? new Promise<void>((resolve, reject) => {
            run.finish = resolve;
            run.fail = reject;
          })
        : Promise.resolve(),
    );
    choose(/PDF/);
    await saveIt();
    return run;
  }

  it("shows the format and the slide on the Export button, and the details with Cancel in its menu", async () => {
    render(<DeckActions />);
    const run = await startPdf();
    expect(exportButton().textContent).toContain("PDF …");
    expect(exportButton().querySelector(".animate-spin")).toBeTruthy();
    act(() => listener("export-progress")({ payload: { job: "job-1", done: 1, total: 3 } }));
    // Another export's progress is not this one's.
    act(() => listener("export-progress")({ payload: { job: "job-9", done: 0, total: 9 } }));
    expect(exportButton().textContent).toContain("PDF 2/3");
    expect(exportButton().getAttribute("aria-label")).toBe("Export, PDF 2/3");
    fireEvent.click(exportButton());
    const running = screen.getByRole("region", { name: "Exports in progress" });
    expect(running.textContent).toContain("PDF · Talk.pdf");
    expect(within(running).getByRole("status").textContent).toBe("Slide 2 of 3");
    expect(within(running).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("33");
    // The formats stay there, to start another.
    expect(screen.getAllByRole("menuitem")).toHaveLength(5);
    await act(async () => run.finish());
    expect(exportButton().textContent).toBe("Export");
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved Talk.pdf"]);
  });

  it("cancels, saying nothing was saved", async () => {
    render(<DeckActions />);
    const run = await startPdf();
    fireEvent.click(exportButton());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel the pdf export" })));
    expect(invoke).toHaveBeenCalledWith("cancel_export", { jobId: "job-1" });
    expect(screen.getByRole("status").textContent).toBe("Stopping…");
    expect((screen.getByRole("button", { name: "Cancel the pdf export" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => run.fail("the export was cancelled"));
    expect(lastError(useApp.getState())).toBeNull();
    expect(toastTexts(useApp.getState(), "info")).toEqual(["Stopped the pdf export. Nothing was saved."]);
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    expect(useExports.getState().runs).toEqual([]);
  });

  it("starts another export while a video renders, and counts them on the button", async () => {
    save.mockResolvedValueOnce("/out/Talk.mp4").mockResolvedValueOnce("/out/Talk.pdf");
    invoke.mockImplementation((command: string) =>
      command === "export_video" || command === "export_pdf" ? new Promise(() => {}) : Promise.resolve(),
    );
    render(<DeckActions />);
    choose(/Video/);
    await saveIt();
    act(() =>
      listener<{ phase: string; frame: number; frames: number }>("video-export-progress")({
        payload: { phase: "video", frame: 42, frames: 100 },
      }),
    );
    expect(exportButton().textContent).toContain("Video 42%");
    fireEvent.click(exportButton());
    expect(screen.getByRole("menuitem", { name: /Video/ }).textContent).toContain("A video is being exported");
    fireEvent.click(screen.getByRole("menuitem", { name: /PDF/ }));
    await saveIt();
    expect(exportButton().textContent).toContain("2 exports");
    fireEvent.click(exportButton());
    const running = screen.getByRole("region", { name: "Exports in progress" });
    expect(within(running).getAllByRole("progressbar")).toHaveLength(2);
    expect(running.textContent).toContain("Rendering video 42%");
    // A second video waits for the first.
    fireEvent.click(screen.getByRole("menuitem", { name: /Video/ }));
    expect(screen.getByRole("alert").textContent).toMatch(/A video is being exported/);
    expect(saveButton().disabled).toBe(true);
  });

  it("keeps going when the menu closes and the deck goes, and says so when done", async () => {
    let finish = () => {};
    save.mockResolvedValue("/out/Talk.pptx");
    invoke.mockImplementation((command: string) =>
      command === "export_pptx"
        ? new Promise((resolve) => (finish = () => resolve({ changes: [] })))
        : Promise.resolve(),
    );
    const { unmount } = render(<DeckActions />);
    choose(/PowerPoint/);
    await saveIt();
    unmount();
    useApp.setState({ deck: null });
    expect(useExports.getState().runs).toHaveLength(1);
    await act(async () => finish());
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved Talk.pptx"]);
    expect(useExports.getState().runs).toEqual([]);
  });
});

describe("video", () => {
  const seconds = () => screen.getByLabelText("Seconds per slide without narration") as HTMLInputElement;
  /** Unfolds the deck's times in the dialog, the one place they are set. */
  const openTiming = () => fireEvent.click(screen.getByRole("button", { name: "Timing…" }));
  const openVideo = () => choose(/Video/);

  it("shows the deck's times with the way to change them, then records the slides to the chosen file", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.mp4");
    render(<DeckActions />);
    openVideo();
    expect(screen.getByTestId("timing-summary").textContent).toBe(
      "5 s per slide without narration, pauses 0.5 s before and 1 s after",
    );
    expect(summary()).toBe("3 slides, 0:15 long, 1920 × 1080 px.");
    expect(screen.getByText(/MP4 with AV1 video/)).toBeTruthy();
    openTiming();
    expect(seconds().value).toBe("5");
    await act(async () => fireEvent.change(seconds(), { target: { value: "2.5" } }));
    // Kept with the deck, for the timeline and the show's Play too.
    expect(invoke).toHaveBeenCalledWith("set_narration_timing", {
      id: DECK_ID,
      timing: { secondsPerSlide: 2.5, pauseBefore: 0.5, pauseAfter: 1 },
    });
    fireEvent.change(screen.getByLabelText("Frame rate"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Play animations/ }));
    fireEvent.click(screen.getByRole("radio", { name: "720p" }));
    expect(summary()).toBe("3 slides, 0:08 long, 1280 × 720 px.");
    await saveIt();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Talk.mp4", filters: [{ name: "MP4 video", extensions: ["mp4"] }] }),
    );
    expect(invoke).toHaveBeenCalledWith("export_video", {
      id: DECK_ID,
      dest: "/Users/me/Desktop/Talk.mp4",
      options: { secondsPerSlide: 2.5, fps: 60, animate: false, narration: true, pauseBefore: 0.5, pauseAfter: 1 },
      output: { includeHidden: false, height: 720, captions: null },
    });
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved Talk.mp4"]);
    expect(unlisten).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Export video" })).toBeNull();
  });

  it("offers 4K, and remembers the resolution", () => {
    render(<DeckActions />);
    openVideo();
    fireEvent.click(screen.getByRole("radio", { name: "4K" }));
    expect(summary()).toMatch(/3840 × 2160 px\.$/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openVideo();
    expect((screen.getByRole("radio", { name: "4K" }) as HTMLInputElement).checked).toBe(true);
  });

  it("remembers each choice as it is made, without exporting, leaving the times to the deck", () => {
    render(<DeckActions />);
    openVideo();
    const stored = () => JSON.parse(localStorage.getItem("slopslide.video") ?? "null");
    expect(stored()).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: /Speak narration/ }));
    expect(stored().narration).toBe(false);
    expect(stored().secondsPerSlide).toBe(5);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openVideo();
    expect((screen.getByRole("checkbox", { name: /Speak narration/ }) as HTMLInputElement).checked).toBe(false);
  });

  it("leaves hidden slides out of the count", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s, i) => ({ ...s, hidden: i > 0 })) } });
    render(<DeckActions />);
    openVideo();
    expect(summary()).toMatch(/^1 slide, 0:05 long/);
  });

  it("cannot record a deck whose slides are all hidden", () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s) => ({ ...s, hidden: true })) } });
    render(<DeckActions />);
    openVideo();
    expect(screen.getByRole("alert").textContent).toMatch(/Every slide is hidden/);
    expect(saveButton().disabled).toBe(true);
  });

  /** The deck with narration on its first two slides; the first one's audio ready. */
  function narrated(key: "saved" | null) {
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
        ? { rendering: null, providers: [{ id: "openai", name: "OpenAI", key, voices: [] }], languages: [] }
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
    narrated("saved");
    render(<DeckActions />);
    openVideo();
    await act(async () => {});
    // 0.5 + 20 + 1 s, about 0.5 + 60 + 1 s for the 150 words not yet spoken, and 5 s.
    expect(summary()).toMatch(/^3 slides, about 1:28 long/);
    expect(screen.getByTestId("spoken-first").textContent).toBe(
      "1 slide is spoken by OpenAI first (749 characters, about 1:00 of audio).",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Speak narration/ }));
    expect(screen.queryByTestId("spoken-first")).toBeNull();
    expect(summary()).toMatch(/^3 slides, 0:15 long/);
  });

  it("writes captions of the narration beside the video when asked", async () => {
    narrated("saved");
    save.mockResolvedValue("/out/Talk.mp4");
    render(<DeckActions />);
    openVideo();
    await act(async () => {});
    fireEvent.click(screen.getByRole("checkbox", { name: /Captions/ }));
    fireEvent.click(screen.getByRole("radio", { name: "WebVTT (.vtt)" }));
    await saveIt();
    expect(invoke).toHaveBeenCalledWith(
      "export_video",
      expect.objectContaining({ output: { includeHidden: false, height: null, captions: "vtt" } }),
    );
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved Talk.mp4 and Talk.vtt"]);
  });

  it("asks for the API key when narration still has to be spoken", async () => {
    narrated(null);
    render(<DeckActions />);
    openVideo();
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("Add your OpenAI API key, or leave the narration out.");
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Open Narration settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Speak narration/ }));
    expect(saveButton().disabled).toBe(false);
  });

  it("offers to add narration when no slide in it has any, opening the Narration tab", async () => {
    render(<DeckActions />);
    openVideo();
    await act(async () => {});
    expect(screen.getByText("No slide in the video has narration.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add narration" }));
    expect(screen.queryByRole("dialog", { name: "Export video" })).toBeNull();
    expect(useApp.getState().sidebarTab).toBe("narration");
  });

  it("says how far it has got, with about how long it still takes, and cancels quietly", async () => {
    let fail = (_reason: string) => {};
    save.mockResolvedValue("/out/Talk.mp4");
    invoke.mockImplementation((command: string) =>
      command === "export_video" ? new Promise((_, reject) => (fail = reject)) : Promise.resolve(),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    render(<DeckActions />);
    openVideo();
    await saveIt();
    const progress = listener<{ phase: string; frame: number; frames: number }>("video-export-progress");
    act(() => progress({ payload: { phase: "narration", frame: 1, frames: 4 } }));
    expect(exportButton().textContent).toContain("Narration 2/4");
    act(() => progress({ payload: { phase: "video", frame: 0, frames: 600 } }));
    now.mockReturnValue(1_060_000);
    act(() => progress({ payload: { phase: "video", frame: 200, frames: 600 } }));
    fireEvent.click(exportButton());
    const running = screen.getByRole("region", { name: "Exports in progress" });
    expect(within(running).getByRole("status").textContent).toBe("Rendering video 33%, about 2 min left");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel the video export" })));
    expect(invoke).toHaveBeenCalledWith("cancel_video_export");
    await act(async () => fail("the video export was cancelled"));
    expect(lastError(useApp.getState())).toBeNull();
    expect(toastTexts(useApp.getState(), "info")).toEqual(["Stopped the video export. Nothing was saved."]);
    now.mockRestore();
  });

  it("reports a video that cannot be recorded", async () => {
    save.mockResolvedValue("/out/Talk.mp4");
    invoke.mockRejectedValue("the deck took too long to get ready for recording the video");
    render(<DeckActions />);
    openVideo();
    await saveIt();
    expect(lastError(useApp.getState())).toBe(
      "Could not save the video: the deck took too long to get ready for recording the video",
    );
    expect(unlisten).toHaveBeenCalled();
  });
});
