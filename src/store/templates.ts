import { api, errorMessage, type TemplateSummary } from "../lib/api";
import { DEFAULT_SIZE, type SlideSize, sameSize } from "../lib/slideSize";
import { promptAgent } from "./composer";
import { showErrorIn } from "./errors";
import { addLayoutPrompt, changeLayoutPrompt, resizePrompt, stylePrompt } from "./prompts";
import { selectedSlide } from "./slides";
import type { Slice } from "./types";

/** The deck's design: templates for its style and layouts, and its slide size. */
export interface TemplatesSlice {
  /** Templates for layouts and styles; `undefined` until loaded. */
  templates: TemplateSummary[] | undefined;

  refreshTemplates: () => Promise<void>;
  /**
   * Restyles the deck like the template: an empty deck takes its styles directly; otherwise
   * the composer gets a prompt asking the agent to.
   */
  applyStyle: (template: string) => Promise<void>;
  /**
   * Adds a slide on the template's layout `slide` after the selected one: a copy of it when
   * the deck uses that template, else a prompt in the composer for the agent.
   */
  addLayoutSlide: (template: string, slide: string) => Promise<void>;
  /** Puts a prompt in the composer to rebuild the selected slide on the template's layout. */
  changeLayout: (template: string, slide: string) => Promise<void>;
  /** Saves the deck as a user template with placeholder content; null when it failed. */
  saveAsTemplate: (name: string) => Promise<TemplateSummary | null>;
  /**
   * Gives every slide the canvas `size`, then (when the deck has slides) puts a prompt in the
   * composer asking the agent to lay the slides out again for it.
   */
  resizeSlides: (size: SlideSize) => Promise<void>;
}

export const createTemplatesSlice: Slice<TemplatesSlice> = (set, get, app) => {
  const findTemplate = (id: string) => get().templates?.find((t) => t.id === id);
  return {
    templates: undefined,

    refreshTemplates: async () => {
      try {
        const templates = await api.listTemplates();
        set({ templates: Array.isArray(templates) ? templates : [] });
      } catch (error) {
        set({ templates: [], error: errorMessage(error) });
      }
    },

    applyStyle: async (id) => {
      const { deck } = get();
      const template = findTemplate(id);
      if (!deck || !template) return;
      try {
        if (deck.slides.length === 0) {
          get().setDeck(await api.applyTemplate(deck.id, id));
          return;
        }
        const path = await api.stageTemplate(deck.id, id);
        promptAgent(app, stylePrompt(template, path));
      } catch (error) {
        showErrorIn(app, error);
      }
    },

    addLayoutSlide: async (id, slide) => {
      const { deck, selected } = get();
      const template = findTemplate(id);
      if (!deck || !template) return;
      try {
        if (deck.template === id || deck.slides.length === 0) {
          // An empty deck takes the template's style first, as picking the style would.
          if (deck.template !== id) get().setDeck(await api.applyTemplate(deck.id, id));
          const created = await api.addTemplateSlide(deck.id, id, slide, selected);
          get().setDeck(created.deck);
          get().select(created.slide);
          return;
        }
        const path = await api.stageTemplate(deck.id, id);
        promptAgent(app, addLayoutPrompt(template, slide, path, selected));
      } catch (error) {
        showErrorIn(app, error);
      }
    },

    changeLayout: async (id, slide) => {
      const { deck, selected } = get();
      const template = findTemplate(id);
      if (!deck || !template || !selected || selectedSlide(get())?.locked) return;
      try {
        const path = await api.stageTemplate(deck.id, id);
        promptAgent(app, changeLayoutPrompt(template, slide, path));
      } catch (error) {
        showErrorIn(app, error);
      }
    },

    saveAsTemplate: async (name) => {
      const { deck } = get();
      if (!deck) return null;
      try {
        const created = await api.createTemplate(deck.id, name);
        await get().refreshTemplates();
        return created;
      } catch (error) {
        showErrorIn(app, error);
        return null;
      }
    },

    resizeSlides: async (size) => {
      const { deck, running } = get();
      if (!deck || running) return;
      const from = deck.size ?? DEFAULT_SIZE;
      if (sameSize(from, size)) return;
      try {
        const resized = await api.setSlideSize(deck.id, size);
        if (get().deck?.id !== deck.id) return;
        get().setDeck(resized);
        if (resized.slides.length > 0) promptAgent(app, resizePrompt(from, resized.size ?? size));
      } catch (error) {
        showErrorIn(app, error);
      }
    },
  };
};
