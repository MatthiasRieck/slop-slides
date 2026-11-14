import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, listen, open as openDialog, revealItemInDir, save } from "../test/tauri";

const unlisten = vi.fn();

// The Export menu, counted: each render of the deck's actions renders it.
vi.mock("./ExportMenu", async (original) => {
  const actual = await original<typeof import("./ExportMenu")>();
  return { ...actual, ExportMenu: vi.fn(actual.ExportMenu) };
});

import { useNarration } from "../narrationStore";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { DeckActions } from "./DeckActions";
import { ExportMenu } from "./ExportMenu";
import { usePresent, usePresentKeys } from "./presenter/present";

/** Mounts the keys that start a show, as the app does next to its other global keys. */
function Keys() {
  usePresentKeys();
  return null;
}

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
  localStorage.removeItem("slopslide.presentInWindows");
  usePresent.setState({ screens: null, previews: null, from: "current", windowed: false });
  useNarration.setState({ speech: null, audio: {}, audioDeck: null, render: null, settings: {}, settingsDeck: null });
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
  });
});

describe("deck actions", () => {
  it("renders as the deck gains or loses its slides, not with every change to it", () => {
    render(<DeckActions />);
    const renders = vi.mocked(ExportMenu).mock.calls.length;
    act(() => useApp.setState({ deck: deckFor(DECK_HTML, "2") }));
    act(() => useApp.setState({ deck: deckFor(DECK_HTML, "3") }));
    expect(vi.mocked(ExportMenu).mock.calls.length).toBe(renders);
    act(() => useApp.setState({ deck: { ...deckFor(DECK_HTML), slides: [] } }));
    expect(vi.mocked(ExportMenu).mock.calls.length).toBe(renders + 1);
    expect((screen.getByRole("button", { name: /Export/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  const exportButton = () => screen.getByRole("button", { name: /Export/ }) as HTMLButtonElement;
  const presentButton = () => screen.getByRole("button", { name: "Present" }) as HTMLButtonElement;

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
      ]);
      const windows = screen.getByRole("menuitemcheckbox", { name: /Present in windows/ });
      expect(windows.textContent).toBe(
        "Present in windowsSlides in this window, to share in a call; the presenter view in another",
      );
      expect(windows.getAttribute("aria-checked")).toBe("false");
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

  it("presents in windows once that is picked in the menu, from either start and with either key, even on one screen", async () => {
    render(
      <>
        <DeckActions />
        <Keys />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More ways to present" }));
    const windows = screen.getByRole("menuitemcheckbox", { name: /Present in windows/ });
    fireEvent.click(windows);
    // A choice, not a start: the menu stays to start from, and the choice is kept.
    expect(useApp.getState().presenting).toBe(false);
    expect(windows.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("slopslide.presentInWindows")).toBe("true");
    expect(presentButton().title).toBe("Present in windows from the current slide (Ctrl+Enter)");
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: /From the beginning/ })));
    expect(useApp.getState().presenting).toBe(true);
    expect(useApp.getState().screens).toBe("windows");
    expect(useApp.getState().presentFrom).toBe("start");
    expect(invoke).not.toHaveBeenCalledWith("list_screens");
    useApp.setState({ presenting: false, screens: null });
    await act(async () => fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true }));
    expect(useApp.getState().screens).toBe("windows");
    expect(useApp.getState().presentFrom).toBe("current");
    // Unpicked, a show goes full screen again.
    invoke.mockResolvedValue([]);
    useApp.setState({ presenting: false, screens: null });
    fireEvent.click(screen.getByRole("button", { name: "More ways to present" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Present in windows/ }));
    expect(localStorage.getItem("slopslide.presentInWindows")).toBe("false");
    await act(async () => fireEvent.click(presentButton()));
    expect(useApp.getState().screens).toBeNull();
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
