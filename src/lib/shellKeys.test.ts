import { describe, expect, it } from "vitest";

import { commandKeys } from "./commands";
import { formatKeys } from "./keys";
import { SHELL_SHORTCUTS, type ShellCommand, shellCommand } from "./shellKeys";

const mod = (key: string, more: { shift?: boolean; alt?: boolean; code?: string } = {}) =>
  shellCommand({ key, mod: true, shift: false, ...more });

describe("shellCommand", () => {
  it("goes to a mode on ⌘1, ⌘2 and ⌘3", () => {
    expect(mod("1")).toBe("view");
    expect(mod("2")).toBe("edit");
    expect(mod("3")).toBe("git");
    expect(mod("4")).toBeNull();
  });

  it("shows or hides the sidebar on ⌘\\, and the slide list with Shift", () => {
    expect(mod("\\")).toBe("sidebar");
    expect(mod("\\", { shift: true })).toBe("rail");
    // Shift turns the key into `|` on a US layout.
    expect(mod("|", { shift: true })).toBe("rail");
    // The physical key counts where the layout writes something else on it.
    expect(mod("#", { code: "Backslash" })).toBe("sidebar");
  });

  it("opens the app's settings on ⌘, a deck on ⌘O, and a folder with Shift", () => {
    expect(mod(",")).toBe("appSettings");
    expect(mod("o")).toBe("openDeck");
    expect(mod("O")).toBe("openDeck");
    expect(mod("O", { shift: true })).toBe("openFolder");
    expect(mod("o", { shift: true })).toBe("openFolder");
  });

  it("answers ⌘S, the habit of saving", () => {
    expect(mod("s")).toBe("save");
    expect(mod("S")).toBe("save");
    expect(mod("s", { shift: true })).toBeNull();
  });

  it("closes the deck on ⌘W and the window with Shift, and opens the command palette on ⇧⌘P", () => {
    expect(mod("w")).toBe("close");
    expect(mod("W", { shift: true })).toBe("closeWindow");
    expect(mod("P", { shift: true, code: "KeyP" })).toBe("palette");
    // ⌘P alone is not the palette's.
    expect(mod("p")).toBeNull();
  });

  it("takes its keys from the command registry", () => {
    expect(SHELL_SHORTCUTS.palette).toBe(commandKeys("help.palette"));
    expect(SHELL_SHORTCUTS.git).toBe(commandKeys("view.changes"));
  });

  it("is nothing without the command modifier, or with more than it", () => {
    for (const key of ["1", "\\", ",", "o", "s"]) {
      expect(shellCommand({ key, mod: false, shift: false })).toBeNull();
      expect(mod(key, { alt: true })).toBeNull();
    }
    expect(mod("1", { shift: true })).toBeNull();
    expect(mod(",", { shift: true })).toBeNull();
    expect(mod("z")).toBeNull();
  });

  it("is what its own shortcut says, for every command", () => {
    for (const [command, spec] of Object.entries(SHELL_SHORTCUTS) as [ShellCommand, string][]) {
      const parts = spec.split("+");
      const key = parts.at(-1)!;
      expect(shellCommand({ key, mod: parts.includes("mod"), shift: parts.includes("shift") })).toBe(command);
    }
    expect(formatKeys(SHELL_SHORTCUTS.rail, false)).toBe("Ctrl+Shift+\\");
    expect(formatKeys(SHELL_SHORTCUTS.sidebar, true)).toBe("⌘\\");
  });
});
