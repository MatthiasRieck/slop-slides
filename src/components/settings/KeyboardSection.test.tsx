import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { filterShortcuts, KeyboardSection } from "./KeyboardSection";
import { keysLabel, SECTIONS } from "./shortcuts";

const filterBox = () => screen.getByRole("searchbox", { name: "Filter shortcuts" });
const filter = (text: string) => fireEvent.change(filterBox(), { target: { value: text } });
const groups = () => screen.getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
/** The table under the heading `title`. */
const table = (title: string) =>
  within(screen.getByRole("heading", { level: 4, name: title }).closest("section")!).getByRole("table");
/** What a row says: its description, then its keys as written. */
const rows = (title: string) =>
  within(table(title))
    .getAllByRole("row")
    .map((row) =>
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    );

describe("KeyboardSection", () => {
  it("lists the keys of every part of the app, a table for each", () => {
    render(<KeyboardSection />);
    expect(groups()).toEqual(SECTIONS.map((s) => s.title));
    for (const { title, rows: listed } of SECTIONS) {
      expect(rows(title)).toEqual(listed.map(([keys, what]) => [keysLabel(what), keysLabel(keys)]));
    }
    expect(screen.getByText("Steer: send into the agent's turn now")).toBeTruthy();
  });

  it("keeps the filter box over the pane's top padding, so no row shows above it", () => {
    render(<KeyboardSection />);
    const bar = screen.getByRole("searchbox", { name: "Filter shortcuts" }).parentElement!.parentElement!;
    // The pane pads its content by 5; the box sticks that much higher and covers the padding.
    for (const name of ["sticky", "-top-5", "-mt-5", "pt-5", "bg-background"]) {
      expect(bar.className.split(" ")).toContain(name);
    }
  });

  it("writes each shortcut as a key cap, as the platform writes it, the words between as they are", () => {
    render(<KeyboardSection />);
    const caps = (description: string) =>
      [...screen.getByText(description).closest("tr")!.querySelectorAll("kbd[data-slot=kbd]")].map(
        (kbd) => kbd.textContent,
      );
    expect(caps("Copy / cut / paste")).toEqual(["Ctrl+C", "Ctrl+X", "Ctrl+V"]);
    expect(caps("Straight across or up and down")).toEqual(["Shift"]);
    expect(caps("Select what it holds")).toEqual([]);
    expect(screen.getByText("Straight across or up and down").closest("tr")!.lastElementChild!.textContent).toBe(
      "Shift moving",
    );
    // Nothing reads the keys' markup as text.
    expect(document.body.textContent).not.toMatch(/[{}]/);
  });

  it("keeps the rows whose description has what is typed, and the cards that still have rows", () => {
    render(<KeyboardSection />);
    filter("  DUPLICATE ");
    expect(groups()).toEqual(["Slides", "Edit", "HTML and SVG editors"]);
    expect(rows("Edit")).toEqual([["Duplicate", "Ctrl+D"]]);
    expect(rows("Slides")).toEqual([["Cut / duplicate the picked slides", "Ctrl+X / Ctrl+D in the list"]]);
  });

  it("keeps the rows whose keys have what is typed, as written or as named", () => {
    render(<KeyboardSection />);
    filter("ctrl+shift+z");
    expect(groups()).toEqual(["General", "Presenting", "HTML and SVG editors"]);
    expect(rows("General")).toEqual([["Undo / redo a change to the deck", "Ctrl+Z / Ctrl+Shift+Z"]]);
    // By the key's name, however the platform writes it.
    filter("pagedown");
    expect(rows("Slides").map(([what]) => what)).toEqual(["Next slide"]);
    expect(groups()).toContain("Presenting");
  });

  it("says so when nothing matches, and lists everything again once the box is empty", () => {
    render(<KeyboardSection />);
    filter("no such key");
    expect(groups.bind(null)).toThrow();
    expect(screen.getByRole("status").textContent).toBe("No shortcut matches “no such key”.");
    expect(screen.getByRole("status").dataset.slot).toBe("empty");
    expect(screen.queryByRole("table")).toBeNull();
    filter("");
    expect(screen.queryByRole("status")).toBeNull();
    expect(groups()).toEqual(SECTIONS.map((s) => s.title));
  });
});

describe("filterShortcuts", () => {
  it("gives every section for an empty filter, and only matching rows otherwise", () => {
    expect(filterShortcuts(SECTIONS, "   ")).toBe(SECTIONS);
    const found = filterShortcuts(SECTIONS, "laser");
    expect(found.map((s) => s.title)).toEqual(["Presenting"]);
    expect(found[0]!.rows).toHaveLength(1);
    expect(filterShortcuts(SECTIONS, "zzzz")).toEqual([]);
  });
});
