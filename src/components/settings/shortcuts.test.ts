import { describe, expect, it } from "vitest";

import { EDIT_TOOL_KEYS } from "../../lib/editTools";
import { TOOL_KEYS } from "../../lib/ink";
import { formatKeys } from "../../lib/keys";
import { SHELL_SHORTCUTS } from "../../lib/shellKeys";
import { keysLabel, SECTIONS, TOOL_ROWS } from "./shortcuts";

const section = (title: string) => SECTIONS.find((s) => s.title === title)!;
/** The single keys a section lists, such as `v` or the four in `{l} / {p} / {h} / {e}`. */
const singleKeys = (rows: [string, string][]) =>
  rows.flatMap(([keys]) => [...keys.matchAll(/\{([a-z])\}/g)].map((m) => m[1]!));

describe("the shortcuts listed", () => {
  it("writes each row's keys as the platform does, leaving the words between them", () => {
    expect(keysLabel("{mod+c} / {mod+x} / {mod+v}")).toBe("Ctrl+C / Ctrl+X / Ctrl+V");
    expect(keysLabel("{shift} moving")).toBe("Shift moving");
    expect(keysLabel("Double-click a group")).toBe("Double-click a group");
    expect(keysLabel("{mod+shift+z}")).toBe(formatKeys("mod+shift+z"));
  });

  it("lists the shell's shortcuts under General, as the shell writes them", () => {
    const general = SECTIONS.find((s) => s.title === "General")!.rows.map(([keys]) => keysLabel(keys));
    expect(general).toEqual(
      expect.arrayContaining([
        formatKeys(SHELL_SHORTCUTS.openFolder),
        [SHELL_SHORTCUTS.view, SHELL_SHORTCUTS.edit, SHELL_SHORTCUTS.git].map((keys) => formatKeys(keys)).join(" / "),
        formatKeys(SHELL_SHORTCUTS.sidebar),
        formatKeys(SHELL_SHORTCUTS.rail),
        formatKeys(SHELL_SHORTCUTS.appSettings),
      ]),
    );
    expect(general).toContain("Ctrl+Shift+\\");
  });

  it("says where the settings and the shortcuts themselves open", () => {
    const rows = new Map(section("General").rows);
    expect(rows.get("{mod+,}")).toBe("Settings");
    expect(rows.get("{?} / {mod+/}")).toBe("Show these shortcuts, in the settings");
  });

  it("groups them by where they work", () => {
    expect(SECTIONS.map((s) => s.title)).toEqual([
      "General",
      "Slides",
      "View",
      "Edit",
      "Text",
      "Lines",
      "Chat",
      "Presenting",
      "HTML and SVG editors",
      "Changes (Git)",
    ]);
  });

  it("lists every edit tool's key, and nothing else as one", () => {
    expect(singleKeys(TOOL_ROWS).sort()).toEqual(Object.keys(EDIT_TOOL_KEYS).sort());
    expect(TOOL_ROWS.every(([keys]) => /^\{[a-z]\}$/.test(keys))).toBe(true);
    expect(section("Edit").rows).toEqual(expect.arrayContaining(TOOL_ROWS));
    expect(singleKeys(section("Edit").rows).sort()).toEqual(Object.keys(EDIT_TOOL_KEYS).sort());
  });

  it("lists every presenting tool's key", () => {
    const listed = singleKeys(section("Presenting").rows);
    for (const key of Object.keys(TOOL_KEYS)) expect(listed).toContain(key);
  });

  it("names each row once in its section, with keys the platform can write", () => {
    for (const { title, rows } of SECTIONS) {
      const keys = rows.map(([row]) => row);
      expect(new Set(keys).size, title).toBe(keys.length);
      for (const [row, what] of rows) {
        expect(what.length, row).toBeGreaterThan(0);
        // A spec left unformatted would show its braces.
        expect(keysLabel(row)).not.toMatch(/[{}]/);
        expect(keysLabel(what)).not.toMatch(/[{}]/);
      }
    }
  });
});
