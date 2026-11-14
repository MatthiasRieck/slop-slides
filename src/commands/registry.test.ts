import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChanges } from "../changesStore";
import { SECTIONS } from "../components/ShortcutHelp";
import { reportFromEditor, resetEditorState } from "../components/stage/editorState";
import { COMMAND_SPECS, normalKeys } from "../lib/commands";
import type { EditSelection } from "../lib/editTools";
import { deckMode, useApp } from "../store";
import { DECK_HTML, deckFor } from "../test/fixtures";
import { ACTIONS, COMMANDS, command, commandContext, commandEnabled, menuState, runCommand } from ".";
import { usePalette } from "./palette";
import { type StageTarget, setStageTarget } from "./stage";

const DECK = deckFor(DECK_HTML);

const stage = (): StageTarget => ({
  post: vi.fn(),
  menuAction: vi.fn(),
  pickImage: vi.fn(),
  askForInsert: vi.fn(),
  zoomBy: vi.fn(),
  resetView: vi.fn(),
});

/** A selection on the slide, as the editor reports it. */
function select(more: Partial<EditSelection> = {}) {
  const app = useApp.getState();
  reportFromEditor(app.selected!, "selection", {
    kind: "text",
    text: true,
    locked: false,
    editing: false,
    group: false,
    flippable: false,
    ...more,
  } as EditSelection);
}

beforeEach(() => {
  localStorage.clear();
  resetEditorState();
  setStageTarget(null);
  useApp.setState({
    workspace: { path: "/decks/talk", name: "talk" },
    openedFile: null,
    deck: DECK,
    selected: DECK.slides[0]!.id,
    editing: false,
    slideMode: "view",
    presenting: false,
    sidebarOpen: true,
    railOpen: true,
    overview: false,
    history: null,
    running: false,
  });
  useChanges.setState({ repository: null });
  usePalette.setState({ open: false });
});

describe("the registry", () => {
  it("has something to do for every command of the table, and no more", () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(COMMAND_SPECS.map((spec) => spec.id).sort());
    expect(COMMANDS).toHaveLength(COMMAND_SPECS.length);
  });

  it("gives every key to one command at most", () => {
    const keyed = COMMAND_SPECS.filter((spec) => spec.keys).map((spec) => normalKeys(spec.keys!));
    expect(new Set(keyed).size).toBe(keyed.length);
  });

  it("lists every command's keys in the shortcut help, in the section the command names", () => {
    for (const spec of COMMAND_SPECS.filter((spec) => spec.keys)) {
      // The edit tools are listed with Edit's keys.
      const section = SECTIONS.find((s) => s.title === (spec.help === "Tools" ? "Edit" : spec.help));
      expect(section, spec.id).toBeDefined();
      expect(
        section!.rows.map(([keys]) => keys),
        spec.id,
      ).toContain(`{${spec.keys}}`);
    }
  });

  it("lists no keys twice in a section of the help", () => {
    for (const { title, rows } of SECTIONS) {
      const keys = rows.map(([keys]) => keys);
      expect(new Set(keys).size, title).toBe(keys.length);
    }
  });
});

describe("running a command", () => {
  it("does it when it can, and says false when it cannot", () => {
    expect(runCommand("view.sidebar")).toBe(true);
    expect(useApp.getState().sidebarOpen).toBe(false);
    expect(runCommand("view.edit")).toBe(true);
    expect(deckMode(useApp.getState())).toBe("edit");
    expect(runCommand("view.changes")).toBe(false);
    expect(deckMode(useApp.getState())).toBe("edit");
    expect(runCommand("no.such.command")).toBe(false);
  });

  it("says why a command cannot run", () => {
    const why = (id: string) => commandEnabled(command(id), commandContext());
    expect(why("view.changes")).toBe("This deck is not kept with Git");
    useChanges.setState({ repository: DECK.id });
    expect(why("view.changes")).toBe(true);
    expect(why("edit.undo")).toBe("Nothing to undo");
    expect(why("arrange.group")).toBe("Only in Edit, on a slide that is not locked");
    useApp.setState({ deck: null });
    expect(why("view.edit")).toBe("Open a deck first");
    expect(why("deck.settings")).toBe("Open a deck first");
    expect(why("app.settings")).toBe(true);
  });

  it("runs nothing during a show but a new window", () => {
    useApp.setState({ presenting: true });
    const ctx = commandContext();
    expect(commandEnabled(command("view.sidebar"), ctx)).toBe("Not during a show");
    expect(commandEnabled(command("window.new"), ctx)).toBe(true);
    expect(runCommand("view.sidebar")).toBe(false);
    expect(useApp.getState().sidebarOpen).toBe(true);
  });

  it("opens the palette", () => {
    expect(runCommand("help.palette")).toBe(true);
    expect(usePalette.getState().open).toBe(true);
  });

  it("asks the slide editor for what is done to the selection, once something is selected", () => {
    const target = stage();
    setStageTarget(target);
    useApp.setState({ editing: true });
    expect(runCommand("arrange.front")).toBe(false);
    select();
    expect(runCommand("arrange.front")).toBe(true);
    expect(target.menuAction).toHaveBeenCalledWith("front");
    expect(runCommand("format.bold")).toBe(true);
    expect(target.post).toHaveBeenCalledWith({ type: "slop:edit-toggle-style", key: "bold" });
    // Grouping takes two; ungrouping a group.
    expect(commandEnabled(command("arrange.group"), commandContext())).toBe("Select two or more elements first");
    expect(commandEnabled(command("arrange.ungroup"), commandContext())).toBe("Select a group first");
    select({ locked: true });
    expect(commandEnabled(command("edit.delete"), commandContext())).toBe("The selection is locked");
    expect(runCommand("arrange.lock")).toBe(true);
    expect(target.post).toHaveBeenLastCalledWith({ type: "slop:edit-lock", locked: false });
  });

  it("undoes the typing in the slide while text is typed there, else the deck's last change", () => {
    const target = stage();
    setStageTarget(target);
    const undo = vi.fn(async () => {});
    useApp.setState({ editing: true, undo, history: { undo: { label: "Move", source: "user", time: 0 } } as never });
    select({ editing: true });
    expect(runCommand("edit.undo")).toBe(true);
    expect(target.post).toHaveBeenCalledWith({ type: "slop:edit-undo", redo: false });
    expect(undo).not.toHaveBeenCalled();
    select({ editing: false });
    expect(runCommand("edit.undo")).toBe(true);
    expect(undo).toHaveBeenCalled();
  });

  it("zooms the stage's view, while there is one", () => {
    expect(runCommand("view.zoomIn")).toBe(false);
    const target = stage();
    setStageTarget(target);
    expect(runCommand("view.zoomIn")).toBe(true);
    expect(target.zoomBy).toHaveBeenCalledWith(1.25);
    expect(runCommand("view.zoomFit")).toBe(true);
    expect(target.resetView).toHaveBeenCalled();
  });

  it("opens the slide list for a new slide's layouts", () => {
    useApp.setState({ railOpen: false, addingSlide: false });
    expect(runCommand("slide.new")).toBe(true);
    expect(useApp.getState()).toMatchObject({ railOpen: true, addingSlide: true });
  });

  it("says when what it started went wrong", async () => {
    const failing = vi.fn(async () => {
      throw new Error("disk full");
    });
    useApp.setState({ confirmSaved: failing });
    expect(runCommand("file.save")).toBe(true);
    await vi.waitFor(() => expect(useApp.getState().toasts.at(-1)?.text).toMatch(/disk full/));
  });
});

describe("the menu bar's state", () => {
  it("lists the commands that cannot run and those that are on", () => {
    const state = menuState(commandContext());
    expect(state.disabled).toContain("edit.undo");
    expect(state.disabled).not.toContain("view.sidebar");
    expect(state.checked).toEqual(expect.arrayContaining(["view.sidebar", "view.rail"]));
    expect(state.checked).not.toContain("view.overview");
    useApp.setState({ overview: true, sidebarOpen: false });
    const after = menuState(commandContext());
    expect(after.checked).toContain("view.overview");
    expect(after.checked).not.toContain("view.sidebar");
  });
});
