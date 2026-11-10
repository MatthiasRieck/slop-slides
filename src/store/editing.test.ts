import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DECK_HTML, deckFor } from "../test/fixtures";
import { editedSlidesOf, editingSlide } from "./editing";
import { backend, calls, DECK, freshModule, freshStore, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("deck mode", () => {
  it("setMode switches between modes, one at a time", async () => {
    const { useApp, deckMode } = await freshModule();
    useApp.setState({ deck: DECK, selected: "intro", editing: false, slideMode: "view" });
    const mode = () => deckMode(useApp.getState());
    useApp.getState().setMode("edit");
    expect(mode()).toBe("edit");
    useApp.getState().setMode("git");
    expect(useApp.getState()).toMatchObject({ editing: false, slideMode: "git" });
    useApp.getState().setMode("settings");
    expect(mode()).toBe("settings");
    useApp.getState().setMode("edit");
    expect(useApp.getState()).toMatchObject({ editing: true, slideMode: "view" });
    useApp.getState().setMode("view");
    expect(mode()).toBe("view");
  });

  it("edit mode is the deck's, also on a locked slide, which the stage then does not edit", async () => {
    const { useApp, deckMode, editingSlide } = await freshModule();
    const locked = { ...DECK, slides: DECK.slides.map((s, i) => ({ ...s, locked: i === 0 })) };
    useApp.setState({ deck: locked, selected: "intro", editing: false, slideMode: "git" });
    useApp.getState().setMode("edit");
    expect(deckMode(useApp.getState())).toBe("edit");
    expect(editingSlide(useApp.getState())).toBe(false);
    // Going on to a slide that is not locked, the mode is still there to edit it.
    useApp.getState().select(locked.slides[1]!.id);
    expect(editingSlide(useApp.getState())).toBe(true);
    useApp.getState().setMode("view");
    expect(editingSlide(useApp.getState())).toBe(false);
  });

  it("narration, notes and the HTML are sidebar tabs, opened beside whatever mode the deck is in", async () => {
    const { useApp, deckMode } = await freshModule();
    useApp.setState({ deck: DECK, selected: "intro", sidebarOpen: false });
    useApp.getState().setMode("edit");
    for (const tab of ["narration", "notes", "code"] as const) {
      useApp.getState().setSidebarTab(tab);
      expect(useApp.getState()).toMatchObject({ sidebarTab: tab, sidebarOpen: true });
      expect(deckMode(useApp.getState())).toBe("edit");
    }
    expect(useApp.getState().sidebarTabs).toEqual(["chat", "files", "narration", "notes", "code"]);
  });
});

describe("editing slides on the stage", () => {
  const MOVED = `<section class="slide" id="intro">\n  <h1 data-moved="" style="translate: 4px 0px;">Hello</h1>\n</section>`;
  const ORIGINAL = `<section class="slide" id="intro">\n  <h1>Hello</h1>\n</section>`;
  /** Backend whose `update_slide` swaps in the markup; like the real one, the hash follows the content. */
  function slideBackend() {
    const revs = new Map([[ORIGINAL, 1]]);
    let rev = 1;
    let markup = ORIGINAL;
    backend({
      update_slide: ({ slide, markup: next, base }) => {
        if (base !== `${String(slide)}-${rev}`) throw "The slide changed while you were editing it.";
        markup = String(next);
        if (!revs.has(markup)) revs.set(markup, revs.size + 1);
        rev = revs.get(markup)!;
        const deck = deckFor(DECK_HTML, String(rev));
        return {
          ...deck,
          slides: deck.slides.map((s) => (s.id === slide ? { ...s, moved: markup.includes("data-moved") } : s)),
        };
      },
      deck_history: () => ({ undo: null, redo: null, current: "v7" }),
      restore_slides: ({ slides }) => {
        if ((slides as string[]).includes("intro")) markup = ORIGINAL;
        return deckFor(DECK_HTML, "1");
      },
    });
    return { markup: () => markup };
  }

  it("saves an edit against the slide's current hash and remembers the slide as edited", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    await useApp.getState().saveSlideEdit("intro", MOVED);
    expect(calls("update_slide")).toEqual([
      { id: "/decks/talk/deck.html", slide: "intro", markup: MOVED, base: "intro-1" },
    ]);
    const deck = useApp.getState().deck!;
    expect(deck.slides[0]).toMatchObject({ hash: "intro-2", moved: true });
    expect(useApp.getState().editedSlides).toEqual(["intro"]);
  });

  it("saves edits one after another, each on top of the last", async () => {
    const useApp = await freshStore();
    const disk = slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    const first = useApp.getState().saveSlideEdit("intro", MOVED);
    const second = useApp.getState().saveSlideEdit("intro", MOVED.replace("Hello", "Hi"));
    await Promise.all([first, second]);
    expect(calls("update_slide").map((c) => c.base)).toEqual(["intro-1", "intro-2"]);
    expect(disk.markup()).toContain("Hi");
    expect(useApp.getState().error).toBeNull();
  });

  it("changes a slide's markup as it is in the file, saving it against the hash it was read at", async () => {
    const useApp = await freshStore();
    backend({
      slide_source: () => ({ markup: ORIGINAL, hash: "h-disk" }),
      update_slide: () => deckFor(DECK_HTML, "2"),
    });
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", editedSlides: [] });
    const saved = await useApp.getState().changeSlideMarkup("intro", (markup) => markup.replace("Hello", "Hi"));
    expect(saved).toBe(true);
    expect(calls("slide_source")).toEqual([{ id: "/decks/talk/deck.html", slide: "intro" }]);
    expect(calls("update_slide")).toEqual([
      { id: "/decks/talk/deck.html", slide: "intro", markup: ORIGINAL.replace("Hello", "Hi"), base: "h-disk" },
    ]);
    expect(useApp.getState().deck!.slides[0]!.hash).toBe("intro-2");
    expect(useApp.getState().editedSlides).toEqual(["intro"]);
  });

  it("reads the slide for a markup change only once the edits before it are saved", async () => {
    const useApp = await freshStore();
    let current = ORIGINAL;
    backend({
      update_slide: ({ markup }) => {
        current = String(markup);
        return deckFor(DECK_HTML, "2");
      },
      slide_source: () => ({ markup: current, hash: "h" }),
    });
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    const edit = useApp.getState().saveSlideEdit("intro", MOVED);
    const change = useApp.getState().changeSlideMarkup("intro", (markup) => `${markup}<!-- x -->`);
    await Promise.all([edit, change]);
    expect(calls("update_slide").at(-1)!.markup).toBe(`${MOVED}<!-- x -->`);
  });

  it("shows why a markup change could not be made, and saves nothing", async () => {
    const useApp = await freshStore();
    backend({ slide_source: () => ({ markup: ORIGINAL, hash: "h" }) });
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    const saved = await useApp.getState().changeSlideMarkup("intro", () => {
      throw new Error("The drawing has changed.");
    });
    expect(saved).toBe(false);
    expect(calls("update_slide")).toEqual([]);
    expect(useApp.getState().error).toBe("The drawing has changed.");
  });

  it("reports a refused save and reloads the slide from disk", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML, "9"), selected: "intro", editReload: 0 });
    await useApp.getState().saveSlideEdit("intro", MOVED);
    expect(useApp.getState().error).toContain("changed");
    expect(useApp.getState().editReload).toBe(1);
    expect(useApp.getState().editedSlides).toEqual([]);
  });

  it("ignores edits of slides that are gone", async () => {
    const useApp = await freshStore();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    await useApp.getState().saveSlideEdit("deleted", MOVED);
    expect(calls("update_slide")).toEqual([]);
  });

  it("entering edit mode remembers where the deck's history was, after edits still being saved", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setEditing(true);
    await useApp.getState().saveSlideEdit("intro", MOVED);
    expect(useApp.getState().editBase).toEqual({
      version: "v7",
      hashes: { intro: "intro-1", "#2": "#2-1", outro: "outro-1" },
    });
    expect(useApp.getState().editedSlides).toEqual(["intro"]);
  });

  it("discard puts the edited slides back as they were on entering edit mode, staying in it", async () => {
    const useApp = await freshStore();
    const disk = slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", editReload: 0 });
    useApp.getState().setEditing(true);
    await useApp.getState().saveSlideEdit("intro", MOVED);
    await useApp.getState().saveSlideEdit("intro", MOVED.replace("Hello", "Hi"));
    await useApp.getState().discardSlideEdits();
    expect(calls("restore_slides")).toEqual([{ id: "/decks/talk/deck.html", since: "v7", slides: ["intro"] }]);
    expect(disk.markup()).toBe(ORIGINAL);
    expect(useApp.getState()).toMatchObject({ editing: true, editedSlides: [], editReload: 1, error: null });
  });

  it("discarding one slide puts only it back and keeps the others' edits", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setEditing(true);
    await useApp.getState().saveSlideEdit("intro", MOVED);
    useApp.setState((s) => ({ editedSlides: [...s.editedSlides, "outro"] }));
    await useApp.getState().discardSlideEdits("intro");
    expect(calls("restore_slides").at(-1)).toMatchObject({ slides: ["intro"] });
    expect(useApp.getState()).toMatchObject({ editing: true, editedSlides: ["outro"], error: null });
  });

  it("counts only slides that are not as they were on entering edit mode as edited", () => {
    const deck = deckFor(DECK_HTML, "2");
    const editBase = { version: "v1", hashes: { intro: "intro-1", outro: "outro-2" } };
    const editedSlides = ["intro", "outro", "gone"];
    expect(editedSlidesOf({ deck, editBase, editedSlides })).toEqual(["intro"]);
    expect(editedSlidesOf({ deck, editBase: null, editedSlides })).toEqual([]);
  });

  it("reports a discard that failed and stays in edit mode", async () => {
    const useApp = await freshStore();
    slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setEditing(true);
    await useApp.getState().saveSlideEdit("intro", MOVED);
    backend({
      restore_slides: () => {
        throw "The slide `intro` is locked; unlock it to change it.";
      },
    });
    await useApp.getState().discardSlideEdits();
    expect(useApp.getState().error).toContain("locked");
    expect(useApp.getState()).toMatchObject({ editing: true, editedSlides: ["intro"] });
  });

  it("accepting (leaving edit mode) keeps the edits, and each session starts afresh", async () => {
    const useApp = await freshStore();
    const disk = slideBackend();
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro" });
    useApp.getState().setEditing(true);
    await useApp.getState().saveSlideEdit("intro", MOVED);
    useApp.getState().setEditing(true);
    expect(useApp.getState().editedSlides).toHaveLength(1);
    useApp.getState().setEditing(false);
    expect(disk.markup()).toBe(MOVED);
    expect(useApp.getState()).toMatchObject({ editing: false, editBase: null, editedSlides: [] });
  });

  it("leaves edit mode and forgets its edits when the deck closes", async () => {
    const useApp = await freshStore();
    useApp.setState({
      deck: DECK,
      editing: true,
      editTool: "draw",
      editBase: { version: "v1", hashes: {} },
      editedSlides: ["intro"],
    });
    await useApp.getState().closeDeck();
    expect(useApp.getState()).toMatchObject({ editing: false, editTool: "select", editBase: null, editedSlides: [] });
  });

  it("starts each edit session with the select tool, and keeps the styles for new elements", async () => {
    const useApp = await freshStore();
    expect(useApp.getState().editTool).toBe("select");
    useApp.getState().setEditing(true);
    useApp.getState().setEditTool("ellipse");
    useApp.getState().setEditStyle("shape", { fill: "#ef4444" });
    useApp.getState().setEditStyle("shape", { bold: true });
    expect(useApp.getState().editStyles.shape).toMatchObject({ fill: "#ef4444", bold: true, color: "#ffffff" });
    expect(useApp.getState().editStyles.text.fill).toBeNull();
    useApp.getState().setEditing(false);
    useApp.getState().setEditing(true);
    expect(useApp.getState().editTool).toBe("select");
    expect(useApp.getState().editStyles.shape.fill).toBe("#ef4444");
  });

  it("enters edit mode on a locked slide too, without editing that slide", async () => {
    const useApp = await freshStore();
    useApp.setState({
      deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)),
      selected: "intro",
      editing: false,
    });
    useApp.getState().setEditing(true);
    expect(useApp.getState().editing).toBe(true);
    expect(editingSlide(useApp.getState())).toBe(false);
    useApp.getState().select("outro");
    expect(editingSlide(useApp.getState())).toBe(true);
  });

  describe("tidying the layout", () => {
    let target: HTMLElement;
    beforeEach(() => {
      target = document.createElement("div");
      target.setAttribute("data-sketch-target", "");
      target.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
      document.body.appendChild(target);
    });
    afterEach(() => target.remove());

    it("screenshots the slide, leaves edit mode, and prepares the request in the composer", async () => {
      const { useApp, TIDY_PROMPT } = await freshModule();
      backend({ capture_sketch: () => "/home/.slopslides/sessions/1-ab/sketches/2-cd.png" });
      useApp.setState({ deck: DECK, selected: "intro", sidebarOpen: false, composerFill: null, editing: true });
      await useApp.getState().tidyLayout();
      expect(calls("capture_sketch")).toHaveLength(1);
      expect(calls("send_message")).toHaveLength(0);
      expect(useApp.getState().messages).toEqual([]);
      expect(useApp.getState()).toMatchObject({
        sidebarOpen: true,
        editing: false,
        composerFill: { text: TIDY_PROMPT, screenshot: "/home/.slopslides/sessions/1-ab/sketches/2-cd.png" },
      });
    });

    it("does not tidy a locked slide", async () => {
      const { useApp } = await freshModule();
      useApp.setState({
        deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)),
        selected: "intro",
        composerFill: null,
      });
      await useApp.getState().tidyLayout();
      expect(calls("capture_sketch")).toEqual([]);
      expect(useApp.getState().composerFill).toBeNull();
    });

    it("still prepares the request when the screenshot fails", async () => {
      const { useApp, TIDY_PROMPT } = await freshModule();
      backend({
        capture_sketch: () => {
          throw "slide screenshots are not supported on this platform yet";
        },
      });
      useApp.setState({ deck: DECK, selected: "intro", composerFill: null });
      await useApp.getState().tidyLayout();
      expect(useApp.getState().composerFill).toEqual({ text: TIDY_PROMPT, rev: 1 });
    });

    it("lists the overflow the editor found in the request", async () => {
      const { useApp, tidyPrompt } = await freshModule();
      backend({ capture_sketch: () => "/home/.slopslides/sessions/1-ab/sketches/4.png" });
      useApp.setState({ deck: DECK, selected: "intro" });
      const overflow = ['<p> "Long" runs past the bottom edge by 80px', "<h1> is cut off by its own box"];
      await useApp.getState().tidyLayout(overflow);
      expect(useApp.getState().composerFill?.text).toBe(tidyPrompt(overflow));
      expect(tidyPrompt(overflow)).toContain(`The editor found overflow:\n- ${overflow[0]}\n- ${overflow[1]}`);
      expect(tidyPrompt()).toBe(tidyPrompt([]));
    });

    const ELEMENT = {
      path: "#intro > h1:nth-child(1)",
      markup: "<h1>Welcome</h1>",
      name: '<h1> "Welcome"',
      added: true,
    };

    it("readies the composer for a question about an element, staying in edit mode", async () => {
      const { useApp } = await freshModule();
      backend({ capture_sketch: () => "/home/.slopslides/sessions/1-ab/sketches/5.png" });
      useApp.setState({ deck: DECK, selected: "intro", sidebarOpen: false, composerFill: null, editing: true });
      await useApp.getState().askAboutElement(ELEMENT);
      expect(calls("send_message")).toHaveLength(0);
      expect(useApp.getState()).toMatchObject({
        sidebarOpen: true,
        editing: true,
        composerFill: { text: "", screenshot: "/home/.slopslides/sessions/1-ab/sketches/5.png", element: ELEMENT },
      });
    });

    it("prepares a tidy of just the element, leaving edit mode like Tidy layout", async () => {
      const { useApp, TIDY_ELEMENT_PROMPT } = await freshModule();
      backend({ capture_sketch: () => "/home/.slopslides/sessions/1-ab/sketches/6.png" });
      useApp.setState({ deck: DECK, selected: "intro", composerFill: null, editing: true });
      await useApp.getState().tidyElement(ELEMENT);
      expect(useApp.getState()).toMatchObject({
        editing: false,
        composerFill: {
          text: TIDY_ELEMENT_PROMPT,
          screenshot: "/home/.slopslides/sessions/1-ab/sketches/6.png",
          element: ELEMENT,
        },
      });
    });

    it("does not hand over an element of a locked slide", async () => {
      const { useApp } = await freshModule();
      useApp.setState({
        deck: deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)),
        selected: "intro",
        composerFill: null,
      });
      await useApp.getState().askAboutElement(ELEMENT);
      await useApp.getState().tidyElement(ELEMENT);
      expect(calls("capture_sketch")).toEqual([]);
      expect(useApp.getState().composerFill).toBeNull();
    });

    it("tells the agent which element the message is about", async () => {
      const { useApp } = await freshModule();
      useApp.setState({ deck: DECK, selected: "intro" });
      await useApp.getState().send("Make this a chart", {
        includeSlide: true,
        attachments: [],
        screenshot: "/home/.slopslides/sessions/1-ab/sketches/7.png",
        element: ELEMENT,
      });
      expect(useApp.getState().messages[0]).toMatchObject({ role: "user", element: ELEMENT });
      expect((calls("send_message")[0]!.args as { prompt: string }).prompt).toBe(
        [
          "[context]",
          "Open file: deck.html (deck)",
          'Current slide: <section id="intro"> in deck.html (slide 1 of 3)',
          "Screenshot: /home/.slopslides/sessions/1-ab/sketches/7.png (screenshot of the slide with the selected element outlined)",
          "Selected element: #intro > h1:nth-child(1) (CSS selector)",
          "Its markup: <h1>Welcome</h1>",
          "[/context]",
          "",
          "Make this a chart",
        ].join("\n"),
      );
    });

    it("sends the screenshot handed over with the message", async () => {
      const { useApp, TIDY_PROMPT } = await freshModule();
      useApp.setState({ deck: DECK, selected: "intro" });
      await useApp.getState().send(TIDY_PROMPT, {
        includeSlide: true,
        attachments: [],
        screenshot: "/home/.slopslides/sessions/1-ab/sketches/2-cd.png",
      });
      expect(calls("capture_sketch")).toHaveLength(0);
      expect((calls("send_message")[0]!.args as { prompt: string }).prompt).toBe(
        [
          "[context]",
          "Open file: deck.html (deck)",
          'Current slide: <section id="intro"> in deck.html (slide 1 of 3)',
          "Screenshot: /home/.slopslides/sessions/1-ab/sketches/2-cd.png (screenshot of the slide with the user's hand edits)",
          "[/context]",
          "",
          TIDY_PROMPT,
        ].join("\n"),
      );
      expect(useApp.getState().messages[0]).toMatchObject({
        text: TIDY_PROMPT,
        slide: "intro",
        sketch: null,
        screenshot: "/home/.slopslides/sessions/1-ab/sketches/2-cd.png",
      });
    });

    it("captures any sketch alongside the handed-over screenshot", async () => {
      const useApp = await freshStore();
      backend({ capture_sketch: () => "/home/.slopslides/sessions/1-ab/sketches/3.png" });
      const ink = [{ tool: "pen" as const, color: "#f00", points: [[0.5, 0.5]] as [number, number][] }];
      useApp.setState({ deck: DECK, selected: "intro", sketches: { intro: ink } });
      await useApp.getState().send("Tidy", {
        includeSlide: true,
        attachments: [],
        screenshot: "/home/.slopslides/sessions/1-ab/sketches/2.png",
      });
      expect(calls("capture_sketch")).toHaveLength(1);
      expect(useApp.getState().messages[0]).toMatchObject({
        sketch: { image: "/home/.slopslides/sessions/1-ab/sketches/3.png" },
        screenshot: "/home/.slopslides/sessions/1-ab/sketches/2.png",
      });
      expect(useApp.getState().sketches).toEqual({ intro: ink });
    });
  });
});
