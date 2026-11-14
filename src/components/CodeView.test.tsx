import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import { lastError } from "../store/errors";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { answerUnsaved } from "../test/unsaved";

// The real thing, counted: finding the slides reads the whole document.
vi.mock("../lib/slideSpans", async (original) => {
  const actual = await original<typeof import("../lib/slideSpans")>();
  return { ...actual, findSlideSpans: vi.fn(actual.findSlideSpans) };
});

import { findSlideSpans } from "../lib/slideSpans";
import { CodePanel, CodeView, DIRTY_CHECK_DELAY } from "./CodeView";
import { REFIND_DELAY, slideMarks } from "./code/sourceEditor";

/** deck.html as the fake backend currently has it. */
let disk = DECK_HTML;
let rev = 0;
const fetchMock = vi.fn(async () => new Response(disk, { status: 200 }));

beforeEach(() => {
  disk = DECK_HTML;
  rev = 0;
  invoke.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  useApp.setState({
    deck: deckFor(disk, String(rev)),
    selected: "intro",
    revealRev: 0,
    codeDirty: false,
    toasts: [],
  });
});

/** Writes deck.html "on disk" and lets the app notice, as the file watcher would. */
async function writeDisk(html: string) {
  disk = html;
  rev += 1;
  await act(async () => useApp.getState().setDeck(deckFor(html, String(rev))));
}

async function renderView(active = true) {
  const result = render(<CodeView active={active} />);
  const view = EditorView.findFromDOM(result.container.querySelector(".cm-editor") as HTMLElement)!;
  await waitFor(() => expect(view.state.doc.toString()).toBe(disk));
  return { ...result, view };
}

/** Types `insert` right after the first occurrence of `after`. */
async function type(view: EditorView, after: string, insert: string) {
  const at = view.state.doc.toString().indexOf(after);
  expect(at).toBeGreaterThanOrEqual(0);
  const pos = at + after.length;
  await act(async () => {
    view.dispatch({ changes: { from: pos, insert }, userEvent: "input.type" });
  });
}

const highlighted = (container: HTMLElement) =>
  [...container.querySelectorAll(".cm-slide-line")].map((l) => l.textContent);
const header = () => document.querySelector(".h-9")!.textContent;
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("CodePanel: the sidebar's HTML tab", () => {
  it("asks for a deck when none is open, and shows the deck's source once one is", async () => {
    useApp.setState({ deck: null, selected: null });
    const { container } = render(<CodePanel active />);
    expect(screen.getByText("Open a deck to see its HTML.")).toBeTruthy();
    expect(container.querySelector(".cm-editor")).toBeNull();
    await act(async () => useApp.setState({ deck: deckFor(disk, "0"), selected: "intro" }));
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    await waitFor(() => expect(view.state.doc.toString()).toBe(disk));
    expect(screen.queryByText("Open a deck to see its HTML.")).toBeNull();
  });

  it("keeps the file's name and the save button in a narrow sidebar, the details giving way", async () => {
    const { container } = render(<CodePanel active />);
    await waitFor(() => expect(header()).toContain("Slide 1"));
    expect(container.firstElementChild!.classList.contains("@container")).toBe(true);
    expect(screen.getByText("deck.html").className).toContain("truncate");
    expect(screen.getByText(/Slide 1/).className).toContain("hidden");
    expect(button("Save").className).not.toContain("hidden");
  });
});

describe("CodeView: showing deck.html", () => {
  it("loads deck.html from the deck's file URL", async () => {
    await renderView();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/talk/deck.html");
  });

  it("highlights every line of the selected slide", async () => {
    const { container } = await renderView();
    await waitFor(() =>
      expect(highlighted(container)).toEqual([`<section class="slide" id="intro">`, `  <h1>Hello</h1>`, `</section>`]),
    );
    expect(container.querySelector(".cm-slide-first")!.textContent).toBe(`<section class="slide" id="intro">`);
    expect(container.querySelector(".cm-slide-last")!.textContent).toBe(`</section>`);
  });

  it("names the slide by its number and title in the header, with its id as the tooltip, and its lines", async () => {
    await renderView();
    await waitFor(() => expect(header()).toContain("Slide 1 · Intro"));
    expect(header()).not.toContain("#intro");
    expect(screen.getByText("Slide 1 · Intro").title).toBe('id="intro"');
    expect(header()).toContain("lines 4–6");
  });

  it("goes to a line asked for from elsewhere, once, with the caret at its start", async () => {
    const { view } = await renderView();
    await act(async () => useApp.setState({ codeReveal: 5 }));
    await waitFor(() => expect(useApp.getState().codeReveal).toBeNull());
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(5);
    // A line past the end is the last one.
    await act(async () => useApp.setState({ codeReveal: 9999 }));
    await waitFor(() => expect(useApp.getState().codeReveal).toBeNull());
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(view.state.doc.lines);
  });

  it("numbers every slide in the gutter and marks the selected one", async () => {
    const { container } = await renderView();
    await waitFor(() => {
      const numbers = [...container.querySelectorAll(".cm-slide-number")].map((n) => n.textContent);
      expect(numbers).toEqual(expect.arrayContaining(["1", "2", "3"]));
    });
    expect(container.querySelector(".cm-slide-number-active")!.textContent).toBe("1");
  });

  it("follows the selection to another slide", async () => {
    const { container, view } = await renderView();
    await act(async () => useApp.getState().select("outro"));
    await waitFor(() => expect(highlighted(container)[0]).toBe(`<section class="slide" id="outro">`));
    expect(header()).toContain("Slide 3");
    expect(header()).toContain("lines 10–12");
    // The caret jumps to the slide's opening tag.
    expect(view.state.selection.main.head).toBe(disk.indexOf(`<section class="slide" id="outro">`));
  });

  it("finds slides that have no id yet by position", async () => {
    const { container } = await renderView();
    await act(async () => useApp.getState().select("#2"));
    await waitFor(() => expect(highlighted(container)[1]).toBe(`  <p>Second</p>`));
    expect(header()).toContain("Slide 2");
  });

  it("highlights nothing when the selected slide is not in the file", async () => {
    const { container } = await renderView();
    await act(async () => useApp.setState({ selected: "missing" }));
    await waitFor(() => expect(highlighted(container)).toEqual([]));
    expect(header()).not.toContain("Slide");
  });

  it("selects the slide the user clicks into", async () => {
    const { view } = await renderView();
    const pos = disk.indexOf("<p>Bye</p>");
    const revealRev = useApp.getState().revealRev;
    await act(async () => {
      view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
    });
    expect(useApp.getState().selected).toBe("outro");
    // Picked in the editor, so no reveal request and the caret stays where the user clicked.
    expect(useApp.getState().revealRev).toBe(revealRev);
    expect(view.state.selection.main.head).toBe(pos);
  });

  it("ignores clicks between slides", async () => {
    const { view } = await renderView();
    await act(async () => {
      view.dispatch({ selection: { anchor: disk.indexOf("<style>") }, userEvent: "select.pointer" });
    });
    expect(useApp.getState().selected).toBe("intro");
  });

  it("does not change the selection for programmatic caret moves", async () => {
    const { view } = await renderView();
    await act(async () => {
      view.dispatch({ selection: { anchor: disk.indexOf("<p>Bye</p>") } });
    });
    expect(useApp.getState().selected).toBe("intro");
  });

  it("follows disk changes when there are no unsaved edits", async () => {
    const { view } = await renderView();
    await writeDisk(DECK_HTML.replace("Hello", "Hello from the agent"));
    await waitFor(() => expect(view.state.doc.toString()).toBe(disk));
    expect(useApp.getState().codeDirty).toBe(false);
    expect(screen.queryByText(/changed on disk/)).toBeNull();
  });

  it("does not put disk changes on the undo stack", async () => {
    const { view } = await renderView();
    await writeDisk(DECK_HTML.replace("Hello", "Agent"));
    await waitFor(() => expect(view.state.doc.toString()).toBe(disk));
    const { undoDepth } = await import("@codemirror/commands");
    expect(undoDepth(view.state)).toBe(0);
  });

  it("normalizes Windows line endings from disk", async () => {
    disk = DECK_HTML.replace(/\n/g, "\r\n");
    const result = render(<CodeView active />);
    const view = EditorView.findFromDOM(result.container.querySelector(".cm-editor") as HTMLElement)!;
    await waitFor(() => expect(view.state.doc.toString()).toBe(DECK_HTML));
    expect(useApp.getState().codeDirty).toBe(false);
  });

  it("shows an error when deck.html cannot be read", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("", { status: 404 }));
    render(<CodeView active />);
    await screen.findByText("Could not read deck.html (404)");
  });

  it("renders nothing without an open deck", () => {
    useApp.setState({ deck: null });
    const { container } = render(<CodeView active />);
    expect(container.querySelector(".h-9")).toBeNull();
  });

  it("stays hidden but alive when inactive", async () => {
    const { container, rerender, view } = await renderView();
    rerender(<CodeView active={false} />);
    expect(container.firstElementChild!.className).toContain("hidden");
    await type(view, "<h1>Hello", " draft");
    rerender(<CodeView active />);
    expect(container.firstElementChild!.className).not.toContain("hidden");
    expect(view.state.doc.toString()).toContain("Hello draft");
  });

  it("reveals the slide selected while hidden once shown", async () => {
    const { rerender, view } = await renderView();
    rerender(<CodeView active={false} />);
    await act(async () => useApp.getState().select("outro"));
    const outro = disk.indexOf(`<section class="slide" id="outro">`);
    // Hidden, the editor is left alone: neither the highlight nor the caret moves yet.
    expect(view.state.selection.main.head).not.toBe(outro);
    expect(view.state.field(slideMarks).active).toBe("intro");
    rerender(<CodeView active />);
    await waitFor(() => expect(view.state.selection.main.head).toBe(outro));
  });
});

describe("CodeView: behind the other sidebar tabs", () => {
  it("reads nothing while hidden, however often the file changes, and once when shown again", async () => {
    const { rerender, view } = await renderView();
    rerender(<CodeView active={false} />);
    fetchMock.mockClear();
    for (const word of ["one", "two", "three"]) await writeDisk(DECK_HTML.replace("Hello", word));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(DECK_HTML);
    rerender(<CodeView active />);
    await waitFor(() => expect(view.state.doc.toString()).toBe(disk));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not read the file again when shown with nothing changed", async () => {
    const { rerender } = await renderView();
    fetchMock.mockClear();
    rerender(<CodeView active={false} />);
    rerender(<CodeView active />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds the conflict as it shows again, when the file changed under unsaved edits", async () => {
    const { rerender, view } = await renderView();
    await type(view, "<h1>Hello", " mine");
    rerender(<CodeView active={false} />);
    await writeDisk(DECK_HTML.replace("<p>Bye</p>", "<p>Bye from the agent</p>"));
    expect(screen.queryByText(/changed on disk while/)).toBeNull();
    rerender(<CodeView active />);
    await screen.findByText("deck.html changed on disk while you were editing.");
    expect(view.state.doc.toString()).toContain("Hello mine");
    expect(useApp.getState().codeDirty).toBe(true);
  });

  it("does not move the hidden editor when another slide is selected", async () => {
    const { rerender, view } = await renderView();
    rerender(<CodeView active={false} />);
    const dispatch = vi.spyOn(view, "dispatch");
    await act(async () => useApp.getState().select("outro"));
    await act(async () => useApp.getState().select("#2"));
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("CodeView: the cost of a key", () => {
  it("finds the slides again once typing pauses, not for every key", async () => {
    const { view } = await renderView();
    await waitFor(() => expect(header()).toContain("lines 4–6"));
    vi.mocked(findSlideSpans).mockClear();
    for (const key of "typed") await type(view, "<h1>Hello", key);
    expect(findSlideSpans).not.toHaveBeenCalled();
    // Meanwhile the slides found before move with the text.
    const intro = view.state.field(slideMarks).spans[0]!;
    expect(view.state.sliceDoc(intro.from, intro.to)).toBe(
      `<section class="slide" id="intro">\n  <h1>Hellodepyt</h1>\n</section>`,
    );
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, REFIND_DELAY + 20))));
    expect(findSlideSpans).toHaveBeenCalledOnce();
  });

  it("moves the slides after an edit along with it, and keeps a slide typed into whole", async () => {
    const { view } = await renderView();
    const before = view.state.field(slideMarks).spans.map((span) => view.state.sliceDoc(span.from, span.to));
    await type(view, "<body>", "\n<!-- a note -->");
    await type(view, "<p>Second</p>", "<p>More</p>");
    const after = view.state.field(slideMarks).spans.map((span) => view.state.sliceDoc(span.from, span.to));
    expect(after).toEqual([before[0], before[1]!.replace("<p>Second</p>", "<p>Second</p><p>More</p>"), before[2]]);
  });

  it("compares the whole text with the saved one only for text of the same length, once typing pauses", async () => {
    const { view } = await renderView();
    vi.useFakeTimers();
    try {
      const whole = vi.spyOn(view.state.doc.constructor.prototype, "toString");
      // A longer text differs for sure: nothing is compared, now or later.
      act(() => view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }));
      expect(useApp.getState().codeDirty).toBe(true);
      expect(whole).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(DIRTY_CHECK_DELAY));
      // Read once, to find the slides again; not a second time, to compare.
      expect(whole).toHaveBeenCalledOnce();
      // Back to the saved length: still unsaved until the pause, when the texts are compared.
      act(() => view.dispatch({ changes: { from: 0, to: 1 }, userEvent: "delete.backward" }));
      expect(useApp.getState().codeDirty).toBe(true);
      act(() => void vi.advanceTimersByTime(DIRTY_CHECK_DELAY));
      expect(useApp.getState().codeDirty).toBe(false);
      // The same length with another text stays unsaved.
      act(() => view.dispatch({ changes: { from: 0, to: 1, insert: "?" }, userEvent: "input.type" }));
      act(() => void vi.advanceTimersByTime(DIRTY_CHECK_DELAY));
      expect(useApp.getState().codeDirty).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CodeView: editing and saving", () => {
  it("is editable", async () => {
    const { view } = await renderView();
    expect(view.state.readOnly).toBe(false);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
  });

  it("starts clean with Save and Revert disabled", async () => {
    await renderView();
    expect(button("Save").disabled).toBe(true);
    expect(button("Revert").disabled).toBe(true);
    expect(screen.queryByTitle("Unsaved changes")).toBeNull();
  });

  it("marks edits as unsaved", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    expect(useApp.getState().codeDirty).toBe(true);
    expect(button("Save").disabled).toBe(false);
    expect(button("Revert").disabled).toBe(false);
    expect(screen.getByTitle("Unsaved changes")).toBeTruthy();
  });

  it("is clean again when an edit is undone back to the saved text", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    const { undo } = await import("@codemirror/commands");
    await act(async () => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe(DECK_HTML);
    // As long as the saved text again: compared with it once the typing pauses.
    await waitFor(() => expect(useApp.getState().codeDirty).toBe(false));
  });

  it("re-finds slides while typing", async () => {
    const { view } = await renderView();
    await type(view, "<p>Bye</p>\n</section>\n", `<section class="slide" id="new">\n  <p>New</p>\n</section>\n`);
    await act(async () => useApp.setState({ selected: "new", revealRev: useApp.getState().revealRev + 1 }));
    await waitFor(() => expect(header()).toContain("Slide 4 · New"));
  });

  it("saves with the Save button, sending the edit and the text it started from", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    const edited = view.state.doc.toString();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "save_deck_source") {
        disk = edited;
        return deckFor(edited, "saved");
      }
    });
    await act(async () => fireEvent.click(button("Save")));
    expect(invoke).toHaveBeenCalledWith("save_deck_source", {
      id: "/decks/talk/deck.html",
      source: edited,
      base: DECK_HTML,
    });
    await waitFor(() => expect(useApp.getState().codeDirty).toBe(false));
    // The saved deck is adopted so thumbnails and the stage refresh.
    expect(useApp.getState().deck!.shellHash).toBe("shell-saved");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(view.state.doc.toString()).toBe(edited);
  });

  it("saves the edits when what leaves the deck is told to save them first", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    const edited = view.state.doc.toString();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "save_deck_source") {
        disk = edited;
        return deckFor(edited, "saved");
      }
    });
    let closing!: Promise<boolean>;
    act(() => {
      closing = useApp.getState().closeDeck();
    });
    await act(async () => void (await answerUnsaved("save")));
    expect(await closing).toBe(true);
    expect(invoke).toHaveBeenCalledWith("save_deck_source", {
      id: "/decks/talk/deck.html",
      source: edited,
      base: DECK_HTML,
    });
    expect(useApp.getState().deck).toBeNull();
  });

  it("keeps the deck open when saving first runs into a change on disk", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "save_deck_source") throw "deck.html changed on disk";
    });
    let closing!: Promise<boolean>;
    act(() => {
      closing = useApp.getState().closeDeck();
    });
    await act(async () => void (await answerUnsaved("save")));
    expect(await closing).toBe(false);
    expect(useApp.getState().deck).not.toBeNull();
    expect(useApp.getState().codeDirty).toBe(true);
    // The editor says why, in the tab that now shows.
    expect(useApp.getState().sidebarTab).toBe("code");
    expect(screen.getByText(/changed on disk while you were editing/)).toBeTruthy();
  });

  it("saves nothing for the store once it is gone", async () => {
    const { view, unmount } = await renderView();
    await type(view, "<h1>Hello", "!");
    unmount();
    useApp.setState({ codeDirty: true });
    const closing = useApp.getState().closeDeck();
    await answerUnsaved("save");
    expect(await closing).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith("save_deck_source", expect.anything());
  });

  // jsdom is not a Mac, so Mod is Ctrl here.
  it("saves with Mod-S", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    invoke.mockResolvedValue(deckFor(view.state.doc.toString(), "saved"));
    await act(async () => {
      fireEvent.keyDown(view.contentDOM, { key: "s", code: "KeyS", keyCode: 83, ctrlKey: true });
    });
    expect(invoke).toHaveBeenCalledWith("save_deck_source", expect.objectContaining({ base: DECK_HTML }));
  });

  it("does not save when nothing changed", async () => {
    const { view } = await renderView();
    await act(async () => {
      fireEvent.keyDown(view.contentDOM, { key: "s", code: "KeyS", keyCode: 83, ctrlKey: true });
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("picks up normalization the backend applied on save", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    const normalized = view.state.doc
      .toString()
      .replace(`<section class="slide">`, `<section class="slide" id="second">`);
    invoke.mockImplementation(async () => {
      disk = normalized;
      return deckFor(normalized, "saved");
    });
    await act(async () => fireEvent.click(button("Save")));
    await waitFor(() => expect(view.state.doc.toString()).toBe(normalized));
    expect(useApp.getState().codeDirty).toBe(false);
  });

  it("Revert discards edits", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", " there");
    await act(async () => fireEvent.click(button("Revert")));
    // It asks first: the edits are not on disk, so there is no getting them back.
    const dialog = screen.getByRole("dialog", { name: "Discard unsaved changes" });
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog", { name: "Discard unsaved changes" })).toBeNull();
    expect(useApp.getState().codeDirty).toBe(true);
    await act(async () => fireEvent.click(button("Revert")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Discard changes" })));
    expect(view.state.doc.toString()).toBe(DECK_HTML);
    expect(useApp.getState().codeDirty).toBe(false);
  });

  it("reports save errors in the app's error toast", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    invoke.mockRejectedValue("disk full");
    await act(async () => fireEvent.click(button("Save")));
    expect(lastError(useApp.getState())).toBe("disk full");
    expect(useApp.getState().codeDirty).toBe(true);
    expect(screen.queryByText(/changed on disk while/)).toBeNull();
  });

  it("clears the dirty flag when unmounted", async () => {
    const { view, unmount } = await renderView();
    await type(view, "<h1>Hello", "!");
    unmount();
    expect(useApp.getState().codeDirty).toBe(false);
  });
});

describe("CodeView: conflicts with changes on disk", () => {
  const AGENT = DECK_HTML.replace("<p>Bye</p>", "<p>Bye from the agent</p>");

  async function editThenAgentWrites() {
    const rendered = await renderView();
    await type(rendered.view, "<h1>Hello", " mine");
    await writeDisk(AGENT);
    await screen.findByText("deck.html changed on disk while you were editing.");
    return rendered;
  }

  it("keeps unsaved edits and warns when the agent writes", async () => {
    const { view } = await editThenAgentWrites();
    expect(view.state.doc.toString()).toContain("Hello mine");
    expect(view.state.doc.toString()).not.toContain("from the agent");
    expect(useApp.getState().codeDirty).toBe(true);
  });

  it("Load disk version takes the agent's text and drops the edits", async () => {
    const { view } = await editThenAgentWrites();
    await act(async () => fireEvent.click(button("Load disk version")));
    expect(view.state.doc.toString()).toBe(AGENT);
    expect(useApp.getState().codeDirty).toBe(false);
    expect(screen.queryByText(/changed on disk while/)).toBeNull();
  });

  it("Overwrite with mine saves without a base", async () => {
    const { view } = await editThenAgentWrites();
    const mine = view.state.doc.toString();
    invoke.mockImplementation(async () => {
      disk = mine;
      return deckFor(mine, "forced");
    });
    await act(async () => fireEvent.click(button("Overwrite with mine")));
    expect(invoke).toHaveBeenCalledWith("save_deck_source", { id: "/decks/talk/deck.html", source: mine, base: null });
    await waitFor(() => expect(screen.queryByText(/changed on disk while/)).toBeNull());
    expect(useApp.getState().codeDirty).toBe(false);
  });

  it("a normal save after a conflict is still checked against the original text", async () => {
    const { view } = await editThenAgentWrites();
    invoke.mockRejectedValue("deck.html changed on disk since you started editing");
    await act(async () => fireEvent.click(button("Save")));
    expect(invoke).toHaveBeenCalledWith(
      "save_deck_source",
      expect.objectContaining({ source: view.state.doc.toString(), base: DECK_HTML }),
    );
    expect(lastError(useApp.getState())).toBeNull();
    expect(screen.getByText("deck.html changed on disk while you were editing.")).toBeTruthy();
  });

  it("shows the banner when the backend refuses a save the watcher has not reported yet", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    invoke.mockRejectedValue("deck.html changed on disk since you started editing");
    await act(async () => fireEvent.click(button("Save")));
    await screen.findByText("deck.html changed on disk while you were editing.");
    expect(lastError(useApp.getState())).toBeNull();
  });

  it("no conflict when the disk catches up to the edits", async () => {
    const { view } = await renderView();
    await type(view, "<h1>Hello", "!");
    await writeDisk(view.state.doc.toString());
    await waitFor(() => expect(useApp.getState().codeDirty).toBe(false));
    expect(screen.queryByText(/changed on disk while/)).toBeNull();
  });
});

describe("CodeView: section markers", () => {
  const SECTIONED = DECK_HTML.replace(
    `<section class="slide" id="outro">`,
    `<div class="deck-section" data-title="Wrap up"></div>\n<section class="slide" id="outro">`,
  );

  /** What the backend reports after a section edit: slide and shell hashes do not change. */
  const sectionEdit = async (html: string) => {
    disk = html;
    await act(async () => useApp.getState().setDeck(deckFor(html, "0")));
  };

  beforeEach(() => {
    disk = SECTIONED;
    useApp.setState({ deck: deckFor(SECTIONED, "0") });
  });

  it("shows a section renamed in the rail, which leaves the slide hashes alone", async () => {
    const { view } = await renderView();
    expect(view.state.doc.toString()).toContain(`data-title="Wrap up"`);
    await sectionEdit(SECTIONED.replace("Wrap up", "Closing"));
    await waitFor(() => expect(view.state.doc.toString()).toContain(`data-title="Closing"`));
    expect(useApp.getState().codeDirty).toBe(false);
  });

  it("shows a section added or removed elsewhere", async () => {
    const { view } = await renderView();
    await sectionEdit(DECK_HTML);
    await waitFor(() => expect(view.state.doc.toString()).not.toContain("deck-section"));
    await sectionEdit(SECTIONED);
    await waitFor(() => expect(view.state.doc.toString()).toContain("deck-section"));
  });

  it("saves a renamed section after the rail renamed it, without a false conflict", async () => {
    const { view } = await renderView();
    await sectionEdit(SECTIONED.replace("Wrap up", "Closing"));
    await waitFor(() => expect(view.state.doc.toString()).toContain("Closing"));
    await type(view, `data-title="Closing`, ` time`);
    const renamed = SECTIONED.replace("Wrap up", "Closing time");
    invoke.mockImplementation(async (command: string) => {
      if (command !== "save_deck_source") return null;
      disk = renamed;
      return deckFor(renamed, "0");
    });
    await act(async () => fireEvent.click(button("Save")));
    expect(invoke).toHaveBeenCalledWith("save_deck_source", {
      id: "/decks/talk/deck.html",
      source: renamed,
      base: SECTIONED.replace("Wrap up", "Closing"),
    });
    expect(useApp.getState().deck?.sections[0]?.title).toBe("Closing time");
    expect(screen.queryByText(/changed on disk/)).toBeNull();
  });
});
