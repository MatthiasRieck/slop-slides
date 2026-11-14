// The workbench's own keyboard shortcuts: which keys ask for what. Acting on them is
// hooks/useShellKeys.ts; the specs here are what the tooltips and the shortcut help show.

/** What a shell shortcut asks for: a mode, a panel shown or hidden, the app's settings, another folder. */
export type ShellCommand = "view" | "edit" | "git" | "sidebar" | "rail" | "appSettings" | "openFolder";

/** The keys of each command, as `formatKeys` specs. */
export const SHELL_SHORTCUTS: Record<ShellCommand, string> = {
  view: "mod+1",
  edit: "mod+2",
  git: "mod+3",
  sidebar: "mod+\\",
  rail: "mod+shift+\\",
  appSettings: "mod+,",
  openFolder: "mod+o",
};

/** A key as pressed: in the app (a keyboard event) or in a slide preview, which forwards it. */
export interface PressedKey {
  key: string;
  /** The physical key, when known: Shift turns `\` into `|`, and layouts move both. */
  code?: string;
  /** The platform's command modifier is held (see `isMod`). */
  mod: boolean;
  shift: boolean;
  alt?: boolean;
}

const MODES: Record<string, ShellCommand> = { "1": "view", "2": "edit", "3": "git" };

/** The command the pressed key asks for; null when it is not a shell shortcut. */
export function shellCommand({ key, code, mod, shift, alt = false }: PressedKey): ShellCommand | null {
  if (!mod || alt) return null;
  if (key === "\\" || key === "|" || code === "Backslash") return shift ? "rail" : "sidebar";
  if (shift) return null;
  if (key === ",") return "appSettings";
  if (key.toLowerCase() === "o") return "openFolder";
  return MODES[key] ?? null;
}
