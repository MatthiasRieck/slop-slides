import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseSelection } from "../../lib/editTools";
import { useApp } from "../../store";
import { DECK_HTML, deckFor } from "../../test/fixtures";
import {
  editorRestarted,
  reportDeckLook,
  reportFromEditor,
  resetEditorState,
  setEditorMenu,
  slideReport,
  useEditorState,
} from "./editorState";

const geometry = (x: number) => ({ count: 1, x, y: 20, w: 300, h: 200, rotation: 0 });
const layer = (selected: boolean) => ({
  path: [0],
  name: "Title",
  group: false,
  locked: false,
  held: false,
  selected,
  depth: 0,
  canUp: false,
  canDown: false,
});
const menu = {
  x: 10,
  y: 20,
  at: { x: 20, y: 40 },
  element: null,
  elements: [],
  editable: false,
  unlockable: false,
  under: [],
  parent: null,
};

describe("what the slide editor reports", () => {
  const notified = vi.fn();
  let stop: () => void;

  beforeEach(() => {
    useApp.setState({ deck: deckFor(DECK_HTML), selected: "intro", editing: true });
    notified.mockClear();
    stop = useEditorState.subscribe(notified);
  });
  afterEach(() => {
    stop();
    resetEditorState();
    useApp.setState({ editing: false });
  });

  it("tells nobody of a report that says what the last one said, whatever it is about", () => {
    reportFromEditor("intro", "selection", parseSelection({ kind: "text", bold: true }));
    reportFromEditor("intro", "geometry", geometry(10));
    reportFromEditor("intro", "layers", [layer(false)]);
    reportFromEditor("intro", "overflow", ["<h1> Hello"]);
    reportDeckLook({ fonts: [{ name: "Inter", stack: "Inter, sans-serif" }] });
    reportDeckLook({ colors: [{ name: "--accent", value: "#ff0000" }] });
    reportDeckLook({ background: "#ffffff" });
    expect(notified).toHaveBeenCalledTimes(7);
    const state = useEditorState.getState();

    reportFromEditor("intro", "selection", parseSelection({ kind: "text", bold: true }));
    reportFromEditor("intro", "geometry", geometry(10));
    reportFromEditor("intro", "layers", [layer(false)]);
    reportFromEditor("intro", "overflow", ["<h1> Hello"]);
    reportDeckLook({ fonts: [{ name: "Inter", stack: "Inter, sans-serif" }] });
    reportDeckLook({ colors: [{ name: "--accent", value: "#ff0000" }] });
    reportDeckLook({ background: "#ffffff" });
    expect(notified).toHaveBeenCalledTimes(7);
    expect(useEditorState.getState()).toBe(state);
  });

  it("takes each report that differs, keeping the rest of what it knew as it was", () => {
    reportFromEditor("intro", "selection", parseSelection({ kind: "text" }));
    reportFromEditor("intro", "layers", [layer(false)]);
    const { selection, layers } = slideReport();
    reportFromEditor("intro", "geometry", geometry(10));
    reportFromEditor("intro", "geometry", geometry(11));
    expect(notified).toHaveBeenCalledTimes(4);
    expect(slideReport().geometry).toEqual(geometry(11));
    // What did not change is the very thing it was: whoever shows it has nothing to do.
    expect(slideReport().selection).toBe(selection);
    expect(slideReport().layers).toBe(layers);
    reportFromEditor("intro", "layers", [layer(true)]);
    expect(slideReport().layers).toEqual([layer(true)]);
    reportFromEditor("intro", "selection", null);
    expect(slideReport().selection).toBeNull();
  });

  it("knows only the slide the editor is at work on", () => {
    reportFromEditor("intro", "selection", parseSelection({ kind: "text" }));
    reportFromEditor("intro", "overflow", ["<h1> Hello"]);
    expect(slideReport().selection).not.toBeNull();
    // Another slide is shown: what was said about the first is not about it.
    useApp.getState().select("outro");
    expect(slideReport()).toEqual({ selection: null, geometry: null, layers: [], overflow: [] });
    // Its own report replaces the first slide's, which is forgotten.
    reportFromEditor("outro", "geometry", geometry(5));
    expect(slideReport()).toMatchObject({ selection: null, geometry: geometry(5), overflow: [] });
    useApp.getState().select("intro");
    expect(slideReport().selection).toBeNull();
    // Out of edit mode the editor is not at work at all.
    useApp.getState().select("outro");
    useApp.setState({ editing: false });
    expect(slideReport().geometry).toBeNull();
  });

  it("starts a fresh editor with nothing selected and no menu, keeping the layers and the deck's look", () => {
    reportFromEditor("intro", "selection", parseSelection({ kind: "text" }));
    reportFromEditor("intro", "geometry", geometry(10));
    reportFromEditor("intro", "layers", [layer(true)]);
    reportDeckLook({ background: "#000000" });
    setEditorMenu(menu);
    notified.mockClear();
    editorRestarted();
    expect(notified).toHaveBeenCalledTimes(1);
    expect(slideReport()).toMatchObject({ selection: null, geometry: null, layers: [layer(true)] });
    expect(useEditorState.getState()).toMatchObject({ menu: null, background: "#000000" });
    // Started again with nothing to clear, it tells nobody.
    editorRestarted();
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("tells a slide's own background from the deck's, and a gradient or image from a color", () => {
    reportDeckLook({ background: "#ffffff" });
    expect(useEditorState.getState()).toMatchObject({ backgroundOther: false, backgroundOwn: false });
    reportDeckLook({ background: "#ffffff", backgroundOther: true });
    expect(useEditorState.getState()).toMatchObject({ background: "#ffffff", backgroundOther: true });
    reportDeckLook({ background: "#ff0000", backgroundOwn: true });
    expect(useEditorState.getState()).toMatchObject({ backgroundOther: false, backgroundOwn: true });
    // A report about the fonts leaves the background as it was.
    notified.mockClear();
    reportDeckLook({ fonts: [] });
    expect(useEditorState.getState().backgroundOwn).toBe(true);
    reportDeckLook({ background: "#ff0000", backgroundOwn: true });
    expect(notified).not.toHaveBeenCalled();
  });

  it("forgets everything when the stage goes", () => {
    reportFromEditor("intro", "geometry", geometry(10));
    useEditorState.setState({ sizeMode: "stretch", keepRatio: true });
    resetEditorState();
    expect(useEditorState.getState()).toMatchObject({ slide: null, sizeMode: "resize", keepRatio: false, fonts: [] });
    expect(slideReport().geometry).toBeNull();
  });
});
