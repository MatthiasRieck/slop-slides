import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, listen, open as openDialog, revealItemInDir, save } from "../test/tauri";

const unlisten = vi.fn();

import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { lastError, toastTexts } from "../store/errors";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { DeckActions } from "./DeckActions";
import { VideoExportPanel } from "./lazy";
import { usePresent, usePresentKeys } from "./presenter/present";

/** Mounts the keys that start a show, as the app does next to its other global keys. */
function Keys() {
  usePresentKeys();
  return null;
}

// The video export's panel is loaded on first use; here it is there, as once the app has been idle.
beforeAll(VideoExportPanel.preload);

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
  localStorage.removeItem("slopslide.screenChoices");
  usePresent.setState({ screens: null, previews: null, from: "current" });
  useNarration.setState({ speech: null, audio: {}, audioDeck: null, render: null });
  useApp.setState({
    workspace: WORKSPACE,
    openedFile: OPENED,
    deck: deckFor(DECK_HTML),
    editing: false,
    slideMode: "view",
    sidebarOpen: true,
    railOpen: true,
    codeDirty: false,
    presenting: false,
    toasts: [],
    imageExport: null,
  });
});

describe("deck actions", () => {
  const exportButton = () => screen.getByRole("button", { name: /Export/ }) as HTMLButtonElement;
  const presentButton = () => screen.getByRole("button", { name: "Present" }) as HTMLButtonElement;
  async function exportAs(item: "HTML file" | "PDF" | "PowerPoint" | "PNG images") {
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
    expect(useApp.getState().presentFrom).toBe("current");
  });

  describe("where the show starts", () => {
    const two = [
      { index: 0, name: "A", x: 0, y: 0, width: 100, height: 100, pixelWidth: 100, pixelHeight: 100, primary: true },
      { index: 1, name: "B", x: 100, y: 0, width: 100, height: 100, pixelWidth: 100, pixelHeight: 100, primary: false },
    ];
    const choose = async (item: RegExp) => {
      fireEvent.click(screen.getByRole("button", { name: "More ways to present" }));
      await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: item })));
    };

    it("offers the beginning, the current slide and windows, with the keys of the first two", () => {
      render(<DeckActions />);
      fireEvent.click(screen.getByRole("button", { name: "More ways to present" }));
      expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
        "From the beginningCtrl+Shift+Enter",
        "From current slideCtrl+Enter",
        "Present in windowsSlides in this window to share in a call; your notes in another",
      ]);
      expect(presentButton().title).toBe("Present from the current slide (Ctrl+Enter)");
    });

    it("presents from the beginning", async () => {
      invoke.mockResolvedValue([two[0]]);
      render(<DeckActions />);
      await choose(/From the beginning/);
      expect(useApp.getState().presenting).toBe(true);
      expect(useApp.getState().presentFrom).toBe("start");
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("presents from the current slide", async () => {
      invoke.mockResolvedValue([two[0]]);
      render(<DeckActions />);
      await choose(/From current slide/);
      expect(useApp.getState().presenting).toBe(true);
      expect(useApp.getState().presentFrom).toBe("current");
    });

    it("keeps where to start through the screen picker, and remembers the screens picked", async () => {
      invoke.mockImplementation(async (name: string) => (name === "list_screens" ? two : []));
      render(<DeckActions />);
      await choose(/From the beginning/);
      expect(useApp.getState().presenting).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Swap" }));
      fireEvent.click(screen.getByText("Start presenting"));
      expect(useApp.getState().presentFrom).toBe("start");
      expect(useApp.getState().screens).toEqual({ audience: 0, presenter: 1 });
      // The next show on these screens starts with the same choice.
      useApp.setState({ presenting: false });
      await act(async () => fireEvent.click(presentButton()));
      expect(screen.getByTestId("screen-0").dataset.role).toBe("audience");
      fireEvent.click(screen.getByText("Start presenting"));
      expect(useApp.getState().presentFrom).toBe("current");
    });

    describe("from the keyboard", () => {
      const mount = () =>
        render(
          <>
            <Keys />
            <DeckActions />
            <input aria-label="A field" />
            <iframe title="Slide" />
          </>,
        );
      beforeEach(() => invoke.mockResolvedValue([two[0]]));

      it("Ctrl+Enter presents from the current slide, Ctrl+Shift+Enter from the beginning", async () => {
        mount();
        const event = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
        await act(async () => void document.body.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
        expect(useApp.getState().presenting).toBe(true);
        expect(useApp.getState().presentFrom).toBe("current");
        useApp.setState({ presenting: false });
        await act(async () => void fireEvent.keyDown(document.body, { key: "Enter", metaKey: true, shiftKey: true }));
        expect(useApp.getState().presentFrom).toBe("start");
      });

      it("asks for the screens as the button does", async () => {
        invoke.mockImplementation(async (name: string) => (name === "list_screens" ? two : []));
        mount();
        await act(async () => void fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true, shiftKey: true }));
        expect(useApp.getState().presenting).toBe(false);
        fireEvent.click(screen.getByText("Start presenting"));
        expect(useApp.getState().presentFrom).toBe("start");
      });

      it("leaves the keys to a text field, and plain Enter and Alt to everything else", async () => {
        mount();
        await act(
          async () => void fireEvent.keyDown(screen.getByLabelText("A field"), { key: "Enter", ctrlKey: true }),
        );
        await act(async () => void fireEvent.keyDown(document.body, { key: "Enter" }));
        await act(async () => void fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true, altKey: true }));
        expect(useApp.getState().presenting).toBe(false);
        expect(invoke).not.toHaveBeenCalled();
      });

      it("does nothing during a show, on an empty deck, or under an open menu", async () => {
        mount();
        useApp.setState({ presenting: true, presentFrom: "current" });
        await act(async () => void fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true, shiftKey: true }));
        expect(useApp.getState().presentFrom).toBe("current");
        useApp.setState({ presenting: false, deck: { ...deckFor(DECK_HTML), slides: [] } });
        await act(async () => void fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true }));
        expect(useApp.getState().presenting).toBe(false);
        act(() => useApp.setState({ deck: deckFor(DECK_HTML) }));
        fireEvent.click(screen.getByRole("button", { name: "More ways to present" }));
        expect(screen.getByRole("menu")).toBeTruthy();
        await act(async () => void fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true }));
        expect(useApp.getState().presenting).toBe(false);
      });

      it("takes the keys pressed in a slide preview, and from nowhere else", async () => {
        mount();
        const frame = screen.getByTitle("Slide") as HTMLIFrameElement;
        const key = (source: MessageEventSource | null, data: object) =>
          act(async () => void window.dispatchEvent(new MessageEvent("message", { data, source })));
        await key(window, { type: "slop:key", key: "Enter", mod: true, shift: false });
        await key(frame.contentWindow, { type: "slop:key", key: "Enter", mod: false, shift: false });
        await key(frame.contentWindow, { type: "slop:key", key: "Enter", mod: true, shift: false, alt: true });
        expect(useApp.getState().presenting).toBe(false);
        await key(frame.contentWindow, { type: "slop:key", key: "Enter", mod: true, shift: true });
        expect(useApp.getState().presenting).toBe(true);
        expect(useApp.getState().presentFrom).toBe("start");
      });
    });
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

  it("presents in windows from the menu beside Present, even on one screen", async () => {
    render(<DeckActions />);
    fireEvent.click(screen.getByRole("button", { name: "More ways to present" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Present in windows/ }));
    expect(useApp.getState().presenting).toBe(true);
    expect(useApp.getState().screens).toBe("windows");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("list_screens");
  });

  it("presents in windows from the screen picker", async () => {
    const attached = [
      { index: 0, name: "A", x: 0, y: 0, width: 100, height: 100, pixelWidth: 100, pixelHeight: 100, primary: true },
      { index: 1, name: "B", x: 100, y: 0, width: 100, height: 100, pixelWidth: 100, pixelHeight: 100, primary: false },
    ];
    invoke.mockImplementation(async (name: string) => (name === "list_screens" ? attached : []));
    render(<DeckActions />);
    await act(async () => fireEvent.click(presentButton()));
    fireEvent.click(screen.getByRole("button", { name: /Present in windows/ }));
    expect(useApp.getState().presenting).toBe(true);
    expect(useApp.getState().screens).toBe("windows");
    expect(screen.queryByText("Start presenting")).toBeNull();
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

  const FILES = [
    ["HTML file", "Talk.html", "HTML presentation", "export_deck", "Could not save the HTML file: "],
    ["PDF", "Talk.pdf", "PDF document", "export_pdf", "Could not save the PDF: "],
    ["PowerPoint", "Talk.pptx", "PowerPoint presentation", "export_pptx", "Could not save the PowerPoint file: "],
  ] as const;

  it.each(FILES)("exports a %s to the chosen file and says it is saved", async (item, name, filter, command) => {
    const dest = `/Users/me/Desktop/${name}`;
    const extension = name.split(".")[1];
    save.mockResolvedValue(dest);
    render(<DeckActions />);
    await exportAs(item);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: name, filters: [{ name: filter, extensions: [extension] }] }),
    );
    expect(invoke).toHaveBeenCalledWith(command, { id: "/decks/talk/deck.html", dest });
    // The file manager opens only when asked for, from the toast.
    expect(revealItemInDir).not.toHaveBeenCalled();
    expect(toastTexts(useApp.getState(), "success")).toEqual([`Saved ${name}`]);
    const toast = useApp.getState().toasts.at(-1)!;
    expect(toast.action?.label).toBe("Show in folder");
    await act(async () => toast.action?.run());
    expect(revealItemInDir).toHaveBeenCalledWith(dest);
    expect(useApp.getState().imageExport).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says a saved file could not be shown, never that it could not be saved", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.pdf");
    revealItemInDir.mockRejectedValue("no file manager");
    render(<DeckActions />);
    await exportAs("PDF");
    expect(lastError(useApp.getState())).toBeNull();
    await act(async () => useApp.getState().toasts.at(-1)?.action?.run());
    expect(lastError(useApp.getState())).toBe(
      "Talk.pdf is saved, but it could not be shown in its folder: no file manager",
    );
    expect(lastError(useApp.getState())).not.toMatch(/Could not save/);
  });

  it.each(FILES)("does not export a %s when the save dialog is cancelled", async (item) => {
    save.mockResolvedValue(null);
    render(<DeckActions />);
    await exportAs(item);
    expect(invoke).not.toHaveBeenCalled();
    expect(revealItemInDir).not.toHaveBeenCalled();
  });

  it.each(FILES)("reports a %s export that fails", async (item, name, _filter, _command, failure) => {
    save.mockResolvedValue(`/read-only/${name}`);
    invoke.mockRejectedValueOnce("Permission denied (os error 13)");
    render(<DeckActions />);
    await exportAs(item);
    expect(lastError(useApp.getState())).toBe(`${failure}Permission denied (os error 13)`);
    expect(revealItemInDir).not.toHaveBeenCalled();
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    expect(exportButton().disabled).toBe(false);
  });

  it("reports an export that fails with an error, by its message", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.pptx");
    invoke.mockImplementation(async (command: string) => {
      if (command === "export_pptx") throw new Error("disk full");
    });
    render(<DeckActions />);
    await exportAs("PowerPoint");
    await vi.waitFor(() => expect(lastError(useApp.getState())).toBe("Could not save the PowerPoint file: disk full"));
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

  it("opens and closes the export menu", () => {
    render(<DeckActions />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(exportButton());
    expect(exportButton().getAttribute("aria-expanded")).toBe("true");
    // Each goes on to ask where to save, and says what becomes of hidden slides.
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "HTML file…One self-contained file to share. Hidden slides stay in it; the show skips them",
      "PDF…One page per slide, for printing or sharing. Hidden slides are left out",
      "PowerPoint…Editable slides; some effects are simplified. Hidden slides are left out",
      "PNG images…One image per slide, in a new folder. Hidden slides are included",
      "Video…An MP4 that plays the animations and speaks the narration. Hidden slides are left out",
    ]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(exportButton());
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("works the export menu from the keyboard", () => {
    render(<DeckActions />);
    exportButton().focus();
    fireEvent.keyDown(exportButton(), { key: " " });
    fireEvent.click(exportButton());
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(items.at(-1)!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "Escape" });
    expect(document.activeElement).toBe(exportButton());
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

  it("includes hidden slides in the PNGs, as its menu item says", async () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s, i) => ({ ...s, hidden: i === 1 })) } });
    openDialog.mockResolvedValue("/Users/me/Desktop");
    invoke.mockImplementation(async (command: string) =>
      command === "create_image_export_dir" ? "/Users/me/Desktop/Talk" : undefined,
    );
    render(<DeckActions />);
    await exportAs("PNG images");
    expect(useApp.getState().imageExport?.slides).toEqual(["intro", "#2", "outro"]);
  });

  it.each([
    ["PDF", "Talk.pdf"],
    ["HTML file", "Talk.html"],
    ["PowerPoint", "Talk.pptx"],
  ] as const)("shows the %s is being written, and blocks another export meanwhile", async (item, name) => {
    let finish!: () => void;
    save.mockResolvedValue(`/Users/me/Desktop/${name}`);
    invoke.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<DeckActions />);
    await exportAs(item);
    expect(exportButton().textContent).toContain("Exporting…");
    expect(exportButton().disabled).toBe(true);
    expect(exportButton().querySelector(".animate-spin")).toBeTruthy();
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    await act(async () => finish());
    expect(exportButton().getAttribute("aria-label")).toBe("Export");
    // Its name, which shows where the window is wide enough.
    expect(exportButton().textContent).toBe("Export");
    expect(exportButton().querySelector("span")?.className).toContain("hidden xl:inline");
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
    expect(lastError(useApp.getState())).toBe("Permission denied (os error 13)");
    expect(useApp.getState().imageExport).toBeNull();
  });

  it("cannot export or present an empty deck", () => {
    useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] } });
    render(<DeckActions />);
    expect(exportButton().disabled).toBe(true);
    expect(presentButton().disabled).toBe(true);
    // Both say what they wait for.
    expect(exportButton().title).toBe("Add a slide first");
    expect(presentButton().title).toBe("Add a slide first");
    expect(screen.getByRole("button", { name: "More ways to present" }).title).toBe("Add a slide first");
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
    expect(revealItemInDir).not.toHaveBeenCalled();
    expect(toastTexts(useApp.getState(), "success")).toEqual(["Saved Talk.mp4"]);
    await act(async () => useApp.getState().toasts.at(-1)?.action?.run());
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/me/Desktop/Talk.mp4");
    expect(unlisten).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Export video" })).toBeNull();
  });

  it("opens in the body, so the panes beside the deck don't cover it", () => {
    const { container } = render(<DeckActions />);
    openPanel();
    const dialog = screen.getByRole("dialog", { name: "Export video" });
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
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

  it("remembers each choice as it is made, for the timeline and the show's Play, without exporting", () => {
    render(<DeckActions />);
    openPanel();
    const stored = () => JSON.parse(localStorage.getItem("slopslide.video") ?? "null");
    // Opening it changes nothing.
    expect(stored()).toBeNull();
    fireEvent.change(seconds(), { target: { value: "8" } });
    expect(stored().secondsPerSlide).toBe(8);
    fireEvent.click(screen.getByRole("checkbox", { name: /Speak narration/ }));
    expect(stored().narration).toBe(false);
    // A time the backend would refuse is not kept.
    fireEvent.change(seconds(), { target: { value: "0" } });
    expect(stored().secondsPerSlide).toBe(8);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
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
        ? {
            rendering: null,
            providers: [{ id: "openai", name: "OpenAI", key, voices: [] }],
            languages: [],
          }
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
    openPanel();
    await act(async () => {});
    // 0.5 + 20 + 1 s, about 0.5 + 60 + 1 s for the 150 words not yet spoken, and 5 s.
    expect(screen.getByText(/3 slides, about 1:28 long/)).toBeTruthy();
    expect(screen.getByText(/1 slide is spoken first/)).toBeTruthy();
    // With narration, the seconds are for the slides that have none.
    expect(screen.getByLabelText("Seconds per slide without narration")).toBeTruthy();
    expect(screen.getByText("Seconds per slide without narration")).toBeTruthy();
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

  it("speaks a recording on a slide without written narration, with no API key", async () => {
    const deck = deckFor(DECK_HTML);
    useApp.setState({ deck: { ...deck, slides: deck.slides.map((s) => ({ ...s, narration: "" })) } });
    invoke.mockImplementation(async (command: string) =>
      command === "speech_status"
        ? {
            rendering: null,
            providers: [{ id: "openai", name: "OpenAI", key: null, voices: [] }],
            languages: [],
          }
        : undefined,
    );
    useNarration.setState({
      audioDeck: deck.id,
      audio: { intro: { slide: "intro", state: "ready", seconds: 20, recorded: true } },
    });
    render(<DeckActions />);
    openPanel();
    await act(async () => {});
    expect(screen.queryByText(/No shown slide has narration/)).toBeNull();
    expect(screen.getByLabelText("Pause before narration")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("asks for the API key when narration still has to be spoken", async () => {
    narrated(null);
    render(<DeckActions />);
    openPanel();
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toMatch(/Add your OpenAI API key/);
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Speak narration/ }));
    expect(saveButton().disabled).toBe(false);
  });

  /** Starts a video export that runs until `fail` rejects it. */
  async function startExport() {
    const run = { fail: (_reason: string) => {} };
    save.mockResolvedValue("/Users/me/Desktop/Talk.mp4");
    invoke.mockImplementation((command: string) =>
      command === "export_video" ? new Promise<void>((_, reject) => (run.fail = reject)) : Promise.resolve(),
    );
    render(<DeckActions />);
    openPanel();
    await act(async () => fireEvent.click(saveButton()));
    return run;
  }
  const progress = () => screen.queryByRole("dialog", { name: "Video export" });

  it("says so while narration is generated first", async () => {
    await startExport();
    act(() => progressListener()({ payload: { phase: "narration", frame: 1, frames: 4 } as never }));
    expect(exportButton().textContent).toContain("Narration 2/4");
    expect(exportButton().getAttribute("aria-label")).toBe("Exporting video: Generating narration 2 of 4");
    fireEvent.click(exportButton());
    expect(progress()!.textContent).toContain("Generating narration 2 of 4");
    expect(screen.queryByText(/Speaking/)).toBeNull();
  });

  it("keeps the percentage in the button, and opens the details on a press", async () => {
    await startExport();
    expect(exportButton().textContent).toContain("0%");
    // It stays pressable while the video is recorded: that is how the details open.
    expect(exportButton().disabled).toBe(false);
    act(() => progressListener()({ payload: { phase: "video", frame: 45, frames: 100 } as never }));
    expect(exportButton().textContent).toContain("45%");
    expect(progress()).toBeNull();

    fireEvent.click(exportButton());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(exportButton().getAttribute("aria-expanded")).toBe("true");
    const panel = progress()!;
    expect(panel.textContent).toContain("Talk.mp4");
    expect(panel.textContent).toContain("Rendering video 45%");
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("45");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("45%");
    // It follows the export while open.
    act(() => progressListener()({ payload: { phase: "video", frame: 90, frames: 100 } as never }));
    expect(panel.textContent).toContain("Rendering video 90%");
    fireEvent.click(exportButton());
    expect(progress()).toBeNull();
  });

  it("cancels from the details, quietly", async () => {
    const run = await startExport();
    fireEvent.click(exportButton());
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    expect(invoke).toHaveBeenCalledWith("cancel_video_export");
    await act(async () => run.fail("the video export was cancelled"));
    expect(lastError(useApp.getState())).toBeNull();
    expect(toastTexts(useApp.getState(), "success")).toEqual([]);
    expect(revealItemInDir).not.toHaveBeenCalled();
    expect(exportButton().textContent).toBe("Export");
    expect(exportButton().disabled).toBe(false);
    expect(progress()).toBeNull();
    // The next press opens the menu again.
    fireEvent.click(exportButton());
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("reports a video that cannot be recorded", async () => {
    save.mockResolvedValue("/Users/me/Desktop/Talk.mp4");
    invoke.mockRejectedValue("the deck took too long to get ready for recording the video");
    render(<DeckActions />);
    openPanel();
    await act(async () => fireEvent.click(saveButton()));
    expect(lastError(useApp.getState())).toBe(
      "Could not save the video: the deck took too long to get ready for recording the video",
    );
    expect(unlisten).toHaveBeenCalled();
  });
});
