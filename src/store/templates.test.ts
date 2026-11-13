import { beforeEach, describe, expect, it } from "vitest";

import type { Deck } from "../lib/api";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { invoke } from "../test/tauri";
import { lastError } from "./errors";
import { backend, calls, DECK, freshModule, freshStore, resetBackend } from "./testing";

beforeEach(resetBackend);

describe("templates", () => {
  const SWISS = { id: "swiss", title: "Swiss Design", builtin: true, path: null, slides: ["title", "split", "quote"] };
  const MINE = { id: "mine", title: "Mine", builtin: false, path: "/t/mine", slides: ["cover"] };
  const STAGED = "/home/.slopslides/sessions/1-ab/templates/swiss.html";

  async function storeWith(deck: Deck, selected: string | null = "intro") {
    const useApp = await freshStore();
    useApp.setState({ deck, selected, templates: [MINE, SWISS], sidebarOpen: true });
    return useApp;
  }

  it("points every message at a copy of the deck's template", async () => {
    const useApp = await storeWith({ ...DECK, template: "swiss" }, null);
    backend({ stage_template: () => STAGED });
    await useApp.getState().send("Add a slide", { includeSlide: false, attachments: [] });
    expect(calls("stage_template")).toEqual([{ id: DECK.id, template: "swiss" }]);
    expect(calls("send_message")[0]!.args).toMatchObject({
      prompt: `[context]\nOpen file: deck.html (deck)\nDeck template: ${STAGED} (copy of the deck's template, for its layouts)\n[/context]\n\nAdd a slide`,
    });
  });

  it("sends without a template copy when the deck has none or it is gone", async () => {
    const useApp = await storeWith(DECK, null);
    await useApp.getState().send("Hi", { includeSlide: false, attachments: [] });
    expect(calls("stage_template")).toEqual([]);
    expect(calls("send_message")[0]!.args).toMatchObject({
      prompt: "[context]\nOpen file: deck.html (deck)\n[/context]\n\nHi",
    });

    useApp.setState({ deck: { ...DECK, template: "gone" }, running: false, messages: [] });
    backend({
      stage_template: () => {
        throw "template not found: gone";
      },
    });
    await useApp.getState().send("Hi again", { includeSlide: false, attachments: [] });
    expect(calls("stage_template")).toEqual([{ id: DECK.id, template: "gone" }]);
    expect(calls("send_message").at(-1)!.args).toMatchObject({
      prompt: "[context]\nOpen file: deck.html (deck)\n[/context]\n\nHi again",
    });
  });

  it("loads the template list", async () => {
    const useApp = await freshStore();
    backend({ list_templates: () => [MINE, SWISS] });
    await useApp.getState().refreshTemplates();
    expect(useApp.getState().templates).toEqual([MINE, SWISS]);
    backend({
      list_templates: () => {
        throw "cannot locate home folder";
      },
    });
    await useApp.getState().refreshTemplates();
    expect(useApp.getState().templates).toEqual([]);
    expect(lastError(useApp.getState())).toBe("cannot locate home folder");
  });

  it("restyles a deck with slides through a prompt in the composer", async () => {
    const useApp = await storeWith(DECK);
    useApp.setState({ sidebarOpen: false, sidebarTab: "files" });
    backend({ stage_template: () => STAGED });
    // The caller learns that it became a request, to say so where the style was picked.
    expect(await useApp.getState().applyStyle("swiss")).toBe("requested");
    expect(calls("stage_template")).toEqual([{ id: DECK.id, template: "swiss" }]);
    expect(calls("apply_template")).toEqual([]);
    const text = useApp.getState().composerFill?.text ?? "";
    expect(text).toContain('"Swiss Design" style');
    expect(text).toContain(STAGED);
    expect(text).toContain('<meta name="slopslide-template" content="swiss">');
    expect(useApp.getState().sidebarOpen).toBe(true);
    expect(useApp.getState().sidebarTab).toBe("chat");
  });

  it("gives an empty deck the style directly", async () => {
    const empty = { ...DECK, slides: [] };
    const useApp = await storeWith(empty, null);
    const styled = { ...empty, template: "swiss", shellHash: "styled" };
    backend({ apply_template: () => styled });
    expect(await useApp.getState().applyStyle("swiss")).toBe("applied");
    expect(calls("apply_template")).toEqual([{ id: DECK.id, template: "swiss" }]);
    expect(useApp.getState().deck).toEqual(styled);
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("ignores unknown templates and reports failures", async () => {
    const useApp = await storeWith(DECK);
    expect(await useApp.getState().applyStyle("nope")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    backend({
      stage_template: () => {
        throw "template not found: swiss";
      },
    });
    expect(await useApp.getState().applyStyle("swiss")).toBeNull();
    expect(lastError(useApp.getState())).toBe("template not found: swiss");
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("copies a layout into a deck that uses the template", async () => {
    const useApp = await storeWith({ ...DECK, template: "swiss" });
    const next = {
      ...DECK,
      template: "swiss",
      slides: [...DECK.slides, { id: "quote", hash: "q", hidden: false, locked: false, moved: false }],
    };
    backend({ add_template_slide: () => ({ deck: next, slide: "quote" }) });
    await useApp.getState().addLayoutSlide("swiss", "quote");
    expect(calls("add_template_slide")).toEqual([{ id: DECK.id, template: "swiss", slide: "quote", after: "intro" }]);
    expect(useApp.getState()).toMatchObject({ deck: next, selected: "quote", composerFill: null });
  });

  it("asks the agent for a layout from another template", async () => {
    const useApp = await storeWith({ ...DECK, template: "mine" });
    backend({ stage_template: () => STAGED });
    await useApp.getState().addLayoutSlide("swiss", "split");
    expect(calls("add_template_slide")).toEqual([]);
    const text = useApp.getState().composerFill?.text ?? "";
    expect(text).toContain("after this one");
    expect(text).toContain(`the "Split" layout of the "Swiss Design" template (slide \`split\` in \`${STAGED}\`)`);
    expect(text).toContain("this deck's design system");

    useApp.setState({ selected: null });
    await useApp.getState().addLayoutSlide("swiss", "split");
    expect(useApp.getState().composerFill?.text).toContain("at the end of the deck");
  });

  it("asks the agent to change the selected slide's layout", async () => {
    const useApp = await storeWith({ ...DECK, template: "swiss" });
    backend({ stage_template: () => STAGED });
    await useApp.getState().changeLayout("swiss", "quote");
    const same = useApp.getState().composerFill?.text ?? "";
    expect(same).toMatch(/^Change the layout of this slide to the "Quote" layout/);
    expect(same).toMatch(/keep this slide's id, its content, and its style/);
    expect(same).toMatch(/do not take over the template's style\.$/);

    // Another template's layout still keeps the slide's style.
    useApp.setState({ deck: { ...DECK, template: null } });
    await useApp.getState().changeLayout("swiss", "quote");
    expect(useApp.getState().composerFill?.text).toMatch(/keep this slide's id, its content, and its style/);
    expect(useApp.getState().composerFill?.text).toMatch(/do not take over the template's style\.$/);

    useApp.setState({ selected: null, composerFill: null });
    await useApp.getState().changeLayout("swiss", "quote");
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("does not change the layout of a locked slide", async () => {
    const useApp = await storeWith(deckFor(DECK_HTML.replace(`id="intro"`, `id="intro" data-locked`)));
    backend({ stage_template: () => STAGED });
    useApp.setState({ selected: "intro", composerFill: null });
    await useApp.getState().changeLayout("swiss", "quote");
    expect(useApp.getState().composerFill).toBeNull();
    expect(calls("stage_template")).toEqual([]);
  });

  it("saves the deck as a template and reloads the list", async () => {
    const useApp = await storeWith(DECK);
    const created = { id: "/decks/talk/deck.html", title: "Talk", builtin: false, path: "/t/talk", slides: ["intro"] };
    backend({ create_template: () => created, list_templates: () => [created, MINE, SWISS] });
    expect(await useApp.getState().saveAsTemplate("Talk")).toEqual(created);
    expect(calls("create_template")).toEqual([{ id: DECK.id, name: "Talk" }]);
    expect(useApp.getState().templates).toEqual([created, MINE, SWISS]);

    backend({
      create_template: () => {
        throw "The deck has no slides to make a template from.";
      },
    });
    expect(await useApp.getState().saveAsTemplate("Talk")).toBeNull();
    expect(lastError(useApp.getState())).toBe("The deck has no slides to make a template from.");
  });
});

describe("changing the slide size", () => {
  const PORTRAIT = { width: 1080, height: 1350, unit: "px" as const };
  const resized = (size = PORTRAIT) => ({
    ...DECK,
    shellHash: "shell-2",
    size: { ...size, pixelWidth: 1080, pixelHeight: 1350 },
  });

  it("resizes the slides, then prepares a message asking the agent to lay them out again", async () => {
    const { useApp } = await freshModule();
    backend({ set_slide_size: () => resized() });
    useApp.setState({ deck: DECK, sidebarOpen: false, composerFill: null, running: false });
    expect(await useApp.getState().resizeSlides(PORTRAIT)).toBe("requested");
    expect(calls("set_slide_size")).toEqual([{ id: "/decks/talk/deck.html", size: PORTRAIT }]);
    expect(useApp.getState().deck?.size).toMatchObject(PORTRAIT);
    expect(calls("send_message")).toEqual([]);
    const fill = useApp.getState().composerFill;
    expect(useApp.getState().sidebarOpen).toBe(true);
    expect(fill?.text).toContain("from landscape, 1920 × 1080 px to portrait, 1080 × 1350 px");
    expect(fill?.text).toContain("Re-lay out every slide");
  });

  it("does not prompt for a deck without slides", async () => {
    const { useApp } = await freshModule();
    const empty = { ...DECK, slides: [] };
    backend({ set_slide_size: () => ({ ...resized(), slides: [] }) });
    useApp.setState({ deck: empty, composerFill: null });
    expect(await useApp.getState().resizeSlides(PORTRAIT)).toBe("applied");
    expect(calls("set_slide_size")).toHaveLength(1);
    expect(useApp.getState().deck?.size).toMatchObject(PORTRAIT);
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("leaves the deck alone for the same size, or while the agent works", async () => {
    const { useApp } = await freshModule();
    backend({ set_slide_size: () => resized() });
    useApp.setState({ deck: DECK, composerFill: null, running: false });
    expect(await useApp.getState().resizeSlides({ width: 1920, height: 1080, unit: "px" })).toBeNull();
    useApp.setState({ running: true });
    expect(await useApp.getState().resizeSlides(PORTRAIT)).toBeNull();
    expect(calls("set_slide_size")).toEqual([]);
    expect(useApp.getState().composerFill).toBeNull();
  });

  it("shows the backend's refusal", async () => {
    const { useApp } = await freshModule();
    backend({
      set_slide_size: () => {
        throw "A slide must be 100 to 10000 pixels on each side";
      },
    });
    useApp.setState({ deck: DECK, composerFill: null, toasts: [], running: false });
    expect(await useApp.getState().resizeSlides({ width: 1, height: 1, unit: "in" })).toBeNull();
    expect(lastError(useApp.getState())).toContain("100 to 10000");
    expect(useApp.getState().deck).toBe(DECK);
    expect(useApp.getState().composerFill).toBeNull();
  });
});
