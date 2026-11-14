// The Slide and Present menus' commands: what the slide list does to the slides picked in it (the
// one shown when none are), and starting a show.
import { usePresent } from "../components/presenter/present";
import { railSelection } from "../store";
import { type CommandAction, type CommandActions, type CommandContext, needs } from "./types";

/** The slides the command is about: those picked in the slide list, else the one shown. */
const picked = (ctx: CommandContext) => railSelection(ctx.app);

/** Whether every picked slide has `flag`. */
const all = (ctx: CommandContext, flag: "hidden" | "locked") => {
  const ids = picked(ctx);
  const slides = ctx.app.deck?.slides.filter((slide) => ids.includes(slide.id)) ?? [];
  return slides.length > 0 && slides.every((slide) => slide[flag]);
};

/** A change to the picked slides. */
const onSlides = (run: (ctx: CommandContext, slides: string[]) => unknown): CommandAction => ({
  enabled: (ctx) => needs(ctx, "slide"),
  run: (ctx) => void run(ctx, picked(ctx)),
});

/** A show, from where `from` says. */
const present = (from: "current" | "start", windows = false): CommandAction => ({
  enabled: (ctx) => needs(ctx, "slide"),
  run: () => (windows ? usePresent.getState().presentInWindows(from) : usePresent.getState().present(from)),
});

export const SLIDE_COMMANDS: CommandActions = {
  "slide.new": {
    enabled: (ctx) => needs(ctx, "deck"),
    run: (ctx) => {
      // The layouts open from the slide list, which shows for them.
      if (!ctx.app.railOpen) ctx.app.setRailOpen(true);
      ctx.app.setAddingSlide(true);
    },
  },
  "slide.duplicate": onSlides((ctx, slides) => ctx.app.duplicateSlides(slides)),
  "slide.delete": onSlides((ctx, slides) => ctx.app.deleteSlides(slides)),
  "slide.moveUp": onSlides((ctx) => ctx.app.moveSlides(-1)),
  "slide.moveDown": onSlides((ctx) => ctx.app.moveSlides(1)),
  "slide.startSection": {
    enabled: (ctx) => needs(ctx, "slide"),
    run: (ctx) => {
      if (ctx.app.selected) return ctx.app.startSection(ctx.app.selected);
    },
  },
  "slide.hide": {
    ...onSlides((ctx, slides) => ctx.app.setSlidesHidden(slides, !all(ctx, "hidden"))),
    checked: (ctx) => all(ctx, "hidden"),
  },
  "slide.lock": {
    ...onSlides((ctx, slides) => ctx.app.setSlidesLocked(slides, !all(ctx, "locked"))),
    checked: (ctx) => all(ctx, "locked"),
  },
  "present.current": present("current"),
  "present.start": present("start"),
  "present.windows": present("current", true),
};
