import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateSummary } from "../lib/api";
import { useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { placeElements } from "../test/intersection";
import { invoke, revealItemInDir as reveal } from "../test/tauri";
import { SlideRail } from "./SlideRail";
import { LayoutPicker, StylePicker } from "./Templates";

const DECK = deckFor(DECK_HTML);
const MINE: TemplateSummary = {
  id: "mine",
  title: "Mine",
  builtin: false,
  path: "/home/.slopslides/templates/mine",
  slides: ["cover", "pricing-tiers"],
};
const SWISS: TemplateSummary = {
  id: "swiss",
  title: "Swiss Design",
  builtin: true,
  path: null,
  slides: ["title", "split", "quote"],
};
const BENTO: TemplateSummary = {
  id: "bento-grid",
  title: "Bento Grid",
  builtin: true,
  path: null,
  slides: ["title", "stats"],
};

beforeEach(() => {
  reveal.mockReset();
  invoke.mockReset().mockImplementation(async (command: string) => {
    switch (command) {
      case "list_templates":
        return [MINE, SWISS, BENTO];
      case "stage_template":
        return "/home/.slopslides/sessions/1-ab/templates/x.html";
    }
  });
  useApp.setState({
    deck: DECK,
    selected: "intro",
    templates: [MINE, SWISS, BENTO],
    composerFill: null,
    toasts: [],
    running: false,
    sidebarOpen: true,
  });
});

const layoutNames = () => screen.getAllByRole("button", { name: / layout$/ }).map((b) => b.getAttribute("aria-label"));

describe("LayoutPicker", () => {
  it("loads the templates when they are not known yet", async () => {
    useApp.setState({ templates: undefined });
    render(<LayoutPicker mode="add" onDone={() => {}} />);
    expect(screen.getByText(/Loading templates/)).toBeTruthy();
    await waitFor(() => expect(layoutNames()).toEqual(["Cover layout", "Pricing tiers layout"]));
    expect(invoke).toHaveBeenCalledWith("list_templates");
  });

  it("starts on the deck's template without a style switcher when adding", () => {
    useApp.setState({ deck: { ...DECK, template: "swiss" } });
    render(<LayoutPicker mode="add" onDone={() => {}} />);
    expect(screen.queryByLabelText("Template")).toBeNull();
    expect(layoutNames()).toEqual(["Title layout", "Split layout", "Quote layout"]);
    expect(screen.getByText(/Adds a copy of the layout/)).toBeTruthy();
  });

  it("lifts every layout's thumbnail off the panel with a shadow", () => {
    useApp.setState({ deck: { ...DECK, template: "swiss" } });
    render(<LayoutPicker mode="add" onDone={() => {}} />);
    const picture = screen.getByRole("button", { name: "Title layout" }).firstElementChild!;
    expect(picture.classList).toContain("shadow-thumbnail");
  });

  it("loads a layout's preview only when the list shows it", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private report: ResizeObserverCallback) {}
        observe(target: Element) {
          this.report([{ target, contentRect: { width: 160 } } as ResizeObserverEntry], this as never);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    useApp.setState({ deck: { ...DECK, template: "swiss" } });
    const preview = (name: string) => screen.getByRole("button", { name }).querySelector("iframe");
    placeElements((element) => (element.closest("button")?.getAttribute("aria-label") === "Quote layout" ? 6 : 0));
    render(<LayoutPicker mode="add" onDone={() => {}} />);
    expect(preview("Title layout")).toBeTruthy();
    expect(preview("Quote layout")).toBeNull();
    for (const frame of document.querySelectorAll("iframe")) fireEvent.load(frame);
    act(() => placeElements(() => 0));
    expect(preview("Quote layout")).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("stays on the deck's template without a style switcher when changing", async () => {
    useApp.setState({ deck: { ...DECK, template: "swiss" } });
    localStorage.setItem("slopslide.layoutTemplate", "bento-grid");
    render(<LayoutPicker mode="change" onDone={() => {}} />);
    expect(screen.queryByLabelText("Template")).toBeNull();
    expect(screen.queryByRole("option")).toBeNull();
    expect(layoutNames()).toEqual(["Title layout", "Split layout", "Quote layout"]);
    expect(screen.getByText(/keeping its content and this deck's style/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Quote layout" })));
    await waitFor(() =>
      expect(useApp.getState().composerFill?.text).toContain('"Quote" layout of the "Swiss Design" template'),
    );
    expect(useApp.getState().composerFill?.text).toContain("do not take over the template's style");
  });

  it("opens on the template picked last when the deck has none", () => {
    localStorage.setItem("slopslide.layoutTemplate", "bento-grid");
    render(<LayoutPicker mode="change" onDone={() => {}} />);
    expect(screen.queryByLabelText("Template")).toBeNull();
    expect(layoutNames()).toEqual(["Title layout", "Stats layout"]);
  });

  it("adds a copy when the layout comes from the deck's template", async () => {
    useApp.setState({ deck: { ...DECK, template: "swiss" } });
    invoke.mockImplementation(async (command: string) =>
      command === "add_template_slide" ? { deck: { ...DECK, template: "swiss" }, slide: "outro" } : undefined,
    );
    render(<LayoutPicker mode="add" onDone={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Quote layout" })));
    expect(invoke).toHaveBeenCalledWith("add_template_slide", {
      id: DECK.id,
      template: "swiss",
      slide: "quote",
      after: "intro",
    });
    expect(useApp.getState().selected).toBe("outro");
  });

  it("adds the layout's slide to an empty deck without a style, giving it the template's style", async () => {
    const empty = { ...DECK, slides: [], template: null };
    const styled = { ...empty, template: "swiss" };
    const added = { ...styled, slides: [{ id: "quote", hash: "q", hidden: false, locked: false, moved: false }] };
    useApp.setState({ deck: empty, selected: null });
    invoke.mockImplementation(async (command: string) => {
      if (command === "apply_template") return styled;
      if (command === "add_template_slide") return { deck: added, slide: "quote" };
    });
    localStorage.setItem("slopslide.layoutTemplate", "swiss");
    render(<LayoutPicker mode="add" onDone={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Quote layout" })));
    expect(invoke).toHaveBeenCalledWith("apply_template", { id: DECK.id, template: "swiss" });
    expect(invoke).toHaveBeenCalledWith("add_template_slide", {
      id: DECK.id,
      template: "swiss",
      slide: "quote",
      after: null,
    });
    expect(useApp.getState().deck?.slides.map((s) => s.id)).toEqual(["quote"]);
    expect(useApp.getState().selected).toBe("quote");
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("tells that a layout picked in an empty deck is added as is", () => {
    useApp.setState({ deck: { ...DECK, slides: [], template: null }, selected: null });
    render(<LayoutPicker mode="add" onDone={() => {}} />);
    expect(screen.getByText(/Adds a copy of the layout/)).toBeTruthy();
  });

  it("asks the agent to change the slide's layout", async () => {
    render(<LayoutPicker mode="change" onDone={() => {}} />);
    expect(screen.getByText("Change layout")).toBeTruthy();
    expect(screen.getByText(/rebuild this slide on the layout/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cover layout" })));
    await waitFor(() =>
      expect(useApp.getState().composerFill?.text).toMatch(
        /^Change the layout of this slide to the "Cover" layout of the "Mine" template/,
      ),
    );
  });

  it("says so when there are no templates", () => {
    useApp.setState({ templates: [] });
    render(<LayoutPicker mode="add" onDone={() => {}} />);
    expect(screen.getByText("No templates found.")).toBeTruthy();
    expect(screen.queryByLabelText("Template")).toBeNull();
  });
});

describe("SlideRail pickers", () => {
  // Adding a slide is Edit mode's.
  beforeEach(() => useApp.setState({ editing: true }));
  afterEach(() => useApp.setState({ editing: false }));

  it("opens the new slide gallery from + and closes it on Escape", () => {
    useApp.setState({ deck: { ...DECK, template: "swiss" } });
    render(<SlideRail />);
    fireEvent.click(screen.getByTitle("New slide"));
    const dialog = screen.getByRole("dialog", { name: "New slide" });
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Blank slide", "Title layout", "Split layout", "Quote layout"]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves the style to Settings mode", () => {
    render(<SlideRail />);
    expect(screen.queryByTitle(/style/i)).toBeNull();
  });

  it("closes the picker on a click outside", () => {
    render(<SlideRail />);
    fireEvent.click(screen.getByTitle("New slide"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("style picker", () => {
  it("shows the deck's style and marks it in the list", () => {
    useApp.setState({ deck: { ...DECK, template: "swiss" } });
    render(<StylePicker />);
    const swiss = screen.getByRole("button", { name: "Swiss Design style" });
    expect(swiss.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "Mine style" }).textContent).toContain("Yours");
    expect(screen.getByText(/restyle every slide/)).toBeTruthy();
  });

  it("lifts every style's thumbnail off the panel with a shadow", () => {
    useApp.setState({ deck: { ...DECK, template: "swiss" } });
    render(<StylePicker />);
    for (const name of ["Swiss Design style", "Mine style"]) {
      expect(screen.getByRole("button", { name }).firstElementChild!.classList).toContain("shadow-thumbnail");
    }
  });

  it("puts a restyle prompt in the composer", async () => {
    render(<StylePicker />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Bento Grid style" })));
    await waitFor(() =>
      expect(useApp.getState().composerFill?.text).toContain('Restyle the whole deck in the "Bento Grid" style'),
    );
  });

  it("styles an empty deck directly and offers no template saving", async () => {
    const empty = { ...DECK, slides: [] };
    useApp.setState({ deck: empty, selected: null });
    invoke.mockImplementation(async (command: string) =>
      command === "apply_template" ? { ...empty, template: "swiss" } : undefined,
    );
    render(<StylePicker />);
    expect(screen.getByText(/takes the style's fonts/)).toBeTruthy();
    expect(screen.queryByText(/Save deck as template/)).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Swiss Design style" })));
    expect(invoke).toHaveBeenCalledWith("apply_template", { id: DECK.id, template: "swiss" });
    expect(useApp.getState().deck?.template).toBe("swiss");
  });

  it("says where the request went, and marks the style asked for", async () => {
    render(<StylePicker />);
    expect(screen.queryByRole("status")).toBeNull();
    const bento = screen.getByRole("button", { name: "Bento Grid style" });
    await act(async () => fireEvent.click(bento));
    expect(screen.getByRole("status").textContent).toBe("Request added to the chat. Send it to restyle.");
    expect(bento.dataset.requested).toBe("true");
    expect(bento.textContent).toContain("Requested");
    expect(screen.getByRole("button", { name: "Swiss Design style" }).dataset.requested).toBeUndefined();
    // Asking for another moves the mark.
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Swiss Design style" })));
    expect(bento.dataset.requested).toBeUndefined();
    expect(screen.getByRole("button", { name: "Swiss Design style" }).dataset.requested).toBe("true");
  });

  it("says nothing of a request when the style was applied directly, or could not be staged", async () => {
    const empty = { ...DECK, slides: [] };
    useApp.setState({ deck: empty, selected: null });
    invoke.mockImplementation(async (command: string) =>
      command === "apply_template" ? { ...empty, template: "swiss" } : undefined,
    );
    const { unmount } = render(<StylePicker />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Swiss Design style" })));
    expect(screen.queryByRole("status")).toBeNull();
    unmount();

    useApp.setState({ deck: DECK });
    invoke.mockImplementation(async (command: string) => {
      if (command === "stage_template") throw "template not found: swiss";
    });
    render(<StylePicker />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Swiss Design style" })));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Swiss Design style" }).dataset.requested).toBeUndefined();
  });

  it("forgets the request for another deck", async () => {
    render(<StylePicker />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Bento Grid style" })));
    expect(screen.getByRole("status")).toBeTruthy();
    act(() => useApp.setState({ deck: { ...DECK, id: "/other/deck.html" } }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("disables restyling while the agent is working, and says what it waits for", () => {
    useApp.setState({ running: true });
    render(<StylePicker />);
    const swiss = screen.getByRole("button", { name: "Swiss Design style" }) as HTMLButtonElement;
    expect(swiss.disabled).toBe(true);
    expect(swiss.title).toBe("Wait for the agent to finish to restyle the deck");
    expect(screen.getByText("Wait for the agent to finish to restyle the deck.")).toBeTruthy();
    act(() => useApp.setState({ running: false }));
    expect(swiss.disabled).toBe(false);
    expect(swiss.title).toBe("");
  });

  it("saves the deck as a template under the name given", async () => {
    const created: TemplateSummary = {
      id: "board",
      title: "Board",
      builtin: false,
      path: "/home/.slopslides/templates/board",
      slides: ["intro"],
    };
    invoke.mockImplementation(async (command: string) => {
      if (command === "create_template") return created;
      if (command === "list_templates") return [created, MINE, SWISS];
    });
    render(<StylePicker />);
    fireEvent.click(screen.getByRole("button", { name: /Save deck as template/ }));
    const name = screen.getByLabelText("Template name") as HTMLInputElement;
    expect(name.value).toBe(DECK.title);
    fireEvent.change(name, { target: { value: "Board" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(invoke).toHaveBeenCalledWith("create_template", { id: DECK.id, name: "Board" });
    expect(screen.getByText("Saved “Board”.")).toBeTruthy();
    expect(useApp.getState().templates?.[0]).toEqual(created);
    fireEvent.click(screen.getByTitle("Show the template's folder"));
    expect(reveal).toHaveBeenCalledWith("/home/.slopslides/templates/board/deck.html");
  });

  it("cancels naming a template with Escape, keeping the picker", () => {
    render(<StylePicker />);
    fireEvent.click(screen.getByRole("button", { name: /Save deck as template/ }));
    fireEvent.keyDown(screen.getByLabelText("Template name"), { key: "Escape" });
    expect(screen.queryByLabelText("Template name")).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith("create_template", expect.anything());
  });
});
