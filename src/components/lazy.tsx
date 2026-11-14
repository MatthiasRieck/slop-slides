// The parts of the app the window does not need to start: each is loaded on first use, and all
// of them once the browser is idle after the first paint, so using one does not wait in practice.
// The window starts on the start screen; the workbench around an open folder comes first.
import { preloadWhenIdle } from "../lib/idle";
import { lazyPart } from "../lib/lazyPart";

/** Holds a panel's place, at its size, until the panel's code is there. */
const panelPlaceholder = <div className="h-full" />;

/** The workbench's parts, from one chunk: they arrive together (see ./workbench.ts). */
const workbench = () => import("./workbench");
export const TopBar = lazyPart(() => workbench().then((m) => m.TopBar), <div className="h-14 shrink-0 border-b" />);
export const SlideRail = lazyPart(() => workbench().then((m) => m.SlideRail), panelPlaceholder);
export const StageOrOverview = lazyPart(() => workbench().then((m) => m.StageOrOverview), panelPlaceholder);
export const Sidebar = lazyPart(() => workbench().then((m) => m.Sidebar), panelPlaceholder);
export const FileViewer = lazyPart(() => workbench().then((m) => m.FileViewer), panelPlaceholder);

/** The sidebar's HTML tab, with the code editor it brings (CodeMirror). */
export const CodePanel = lazyPart(() => import("./CodeView").then((m) => m.CodePanel), panelPlaceholder);
export const SvgEditor = lazyPart(() => import("./SvgEditor").then((m) => m.SvgEditor), panelPlaceholder);
export const ChangesView = lazyPart(() => import("./ChangesView").then((m) => m.ChangesView), panelPlaceholder);
export const ChangesRail = lazyPart(() => import("./ChangesView").then((m) => m.ChangesRail), panelPlaceholder);
export const DeckSettings = lazyPart(() => import("./DeckSettings").then((m) => m.DeckSettings));
export const NarrationTimeline = lazyPart(() => import("./NarrationTimeline").then((m) => m.NarrationTimeline));
export const Presenter = lazyPart(() => import("./Presenter").then((m) => m.Presenter));
export const RewindDialog = lazyPart(() => import("./RewindDialog").then((m) => m.RewindDialog));
/** The Export menu's dialog, with each format's options. */
export const ExportDialog = lazyPart(() => import("./ExportDialog").then((m) => m.ExportDialog));
/** The command palette (⇧⌘P). */
export const CommandPalette = lazyPart(() => import("./CommandPalette").then((m) => m.CommandPalette));

/** In the order they are likely to be wanted: the workbench first, as most windows open a folder at once. */
const PARTS = [
  TopBar,
  SlideRail,
  StageOrOverview,
  Sidebar,
  FileViewer,
  NarrationTimeline,
  Presenter,
  CodePanel,
  ChangesView,
  ChangesRail,
  DeckSettings,
  ExportDialog,
  RewindDialog,
  CommandPalette,
  SvgEditor,
];

/** Loads every lazy part now. Tests call it (or a part's own `preload`) to render them at once. */
export const preloadLazyParts = () => Promise.all(PARTS.map((part) => part.preload())).then(() => undefined);

/** Loads the lazy parts one at a time while the browser is idle. Returns what calls the rest off. */
export const preloadLazyPartsWhenIdle = () => preloadWhenIdle(PARTS.map((part) => part.preload));
