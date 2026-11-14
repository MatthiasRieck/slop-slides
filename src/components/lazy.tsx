// The parts of the app the window does not need to start: each is loaded on first use, and all
// of them once the browser is idle after the first paint, so using one does not wait in practice.
// The chat (with its Markdown) and the slide rail are on the first screen and are not here.
import { preloadWhenIdle } from "../lib/idle";
import { lazyPart } from "../lib/lazyPart";

/** Holds a panel's place, at its size, until the panel's code is there. */
const panelPlaceholder = <div className="h-full" />;

/** The sidebar's HTML tab, with the code editor it brings (CodeMirror). */
export const CodePanel = lazyPart(() => import("./CodeView").then((m) => m.CodePanel), panelPlaceholder);
export const SvgEditor = lazyPart(() => import("./SvgEditor").then((m) => m.SvgEditor), panelPlaceholder);
export const ChangesView = lazyPart(() => import("./ChangesView").then((m) => m.ChangesView), panelPlaceholder);
export const ChangesRail = lazyPart(() => import("./ChangesView").then((m) => m.ChangesRail), panelPlaceholder);
export const DeckSettings = lazyPart(() => import("./DeckSettings").then((m) => m.DeckSettings), panelPlaceholder);
export const NarrationTimeline = lazyPart(() => import("./NarrationTimeline").then((m) => m.NarrationTimeline));
export const Presenter = lazyPart(() => import("./Presenter").then((m) => m.Presenter));
export const RewindDialog = lazyPart(() => import("./RewindDialog").then((m) => m.RewindDialog));
export const SlideImageExport = lazyPart(() => import("./SlideImageExport").then((m) => m.SlideImageExport));
export const VideoExportPanel = lazyPart(() => import("./VideoExport").then((m) => m.VideoExportPanel));

/** In the order they are likely to be wanted. */
const PARTS = [
  NarrationTimeline,
  Presenter,
  CodePanel,
  ChangesView,
  ChangesRail,
  DeckSettings,
  VideoExportPanel,
  SlideImageExport,
  RewindDialog,
  SvgEditor,
];

/** Loads every lazy part now. Tests call it (or a part's own `preload`) to render them at once. */
export const preloadLazyParts = () => Promise.all(PARTS.map((part) => part.preload())).then(() => undefined);

/** Loads the lazy parts one at a time while the browser is idle. Returns what calls the rest off. */
export const preloadLazyPartsWhenIdle = () => preloadWhenIdle(PARTS.map((part) => part.preload));
