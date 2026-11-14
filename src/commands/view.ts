// The View menu's commands: the deck's modes, the panels around the slide, the zoom and the chat.
import { ZOOM_STEP } from "../components/stage/usePasteboard";
import { type CommandAction, type CommandActions, type CommandContext, needs, WHY } from "./types";

/** The view of the slide, while the stage shows one. */
const zoom = (change: (ctx: CommandContext) => void): CommandAction => ({
  enabled: (ctx) => {
    const ready = needs(ctx, "slide", "stage");
    if (ready !== true) return ready;
    return ctx.stage && !ctx.app.overview ? true : "Only with a slide on the stage";
  },
  run: change,
});

export const VIEW_COMMANDS: CommandActions = {
  "view.view": { enabled: (ctx) => needs(ctx, "deck"), run: (ctx) => ctx.app.setMode("view") },
  "view.edit": { enabled: (ctx) => needs(ctx, "deck"), run: (ctx) => ctx.app.setMode("edit") },
  "view.changes": {
    enabled: (ctx) => (!ctx.app.deck ? WHY.noDeck : ctx.repository ? true : "This deck is not kept with Git"),
    run: (ctx) => ctx.app.setMode("git"),
  },
  "view.overview": {
    enabled: (ctx) => needs(ctx, "slide", "stage"),
    checked: (ctx) => ctx.app.overview,
    run: (ctx) => ctx.app.setOverview(!ctx.app.overview),
  },
  "view.rail": {
    enabled: (ctx) => needs(ctx, "deck"),
    checked: (ctx) => ctx.app.railOpen,
    run: (ctx) => ctx.app.setRailOpen(!ctx.app.railOpen),
  },
  "view.sidebar": {
    enabled: (ctx) => (ctx.app.workspace ? true : WHY.noFolder),
    checked: (ctx) => ctx.app.sidebarOpen,
    run: (ctx) => ctx.app.setSidebarOpen(!ctx.app.sidebarOpen),
  },
  "view.notes": {
    enabled: (ctx) => needs(ctx, "slide", "stage"),
    checked: (ctx) => ctx.app.notesOpen,
    run: (ctx) => ctx.app.setNotesOpen(!ctx.app.notesOpen),
  },
  "view.timeline": {
    enabled: (ctx) => needs(ctx, "slide", "stage"),
    checked: (ctx) => ctx.app.timelineOpen,
    run: (ctx) => ctx.app.setTimelineOpen(!ctx.app.timelineOpen),
  },
  "view.zoomIn": zoom((ctx) => ctx.stage?.zoomBy(ZOOM_STEP)),
  "view.zoomOut": zoom((ctx) => ctx.stage?.zoomBy(1 / ZOOM_STEP)),
  "view.zoomFit": zoom((ctx) => ctx.stage?.resetView()),
  "view.chat": {
    enabled: (ctx) => (ctx.app.workspace ? true : WHY.noFolder),
    run: (ctx) => ctx.app.focusComposer(),
  },
};
