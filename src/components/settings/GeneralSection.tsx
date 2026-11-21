import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderSearch } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import { APPEARANCES, type Appearance, type RewindSetting } from "../../lib/settings";
import { cn, revealLabel } from "../../lib/utils";
import { showError, useApp } from "../../store";
import { Button } from "../Button";
import { SettingRow, SettingsGroup } from "./parts";

const APPEARANCE_LABELS: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };

/** What undoing an agent's changes does to the chat, as the settings offer it. */
const REWIND_OPTIONS: [RewindSetting, string][] = [
  ["ask", "Ask each time"],
  ["rewind", "Also rewind the chat"],
  ["deck", "Only undo the deck changes"],
];

/**
 * The settings' General section, for every deck alike: how the app looks, how undoing an agent's
 * changes treats the chat, and where the library is. (A deck's own settings, its title, slide
 * size and style, open from the file menu.) A choice is the backend's to keep: it shows once the
 * backend has it, in every window.
 */
export function GeneralSection() {
  const appearance = useApp((s) => s.settings.appearance);
  const rewind = useApp((s) => s.settings.rewind);
  const [library, setLibrary] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    // Without it (the browser preview), the section just leaves the path out.
    Promise.resolve()
      .then(api.libraryFolder)
      .then(
        (path) => !gone && typeof path === "string" && setLibrary(path),
        () => {},
      );
    return () => {
      gone = true;
    };
  }, []);

  const update = useApp.getState().updateSettings;

  const revealLibrary = async () => {
    try {
      await revealItemInDir(library ?? (await api.libraryFolder()));
    } catch (error) {
      showError(error);
    }
  };

  return (
    <SettingsGroup>
      <SettingRow title="Appearance" hint="System follows your computer's light or dark mode.">
        <div
          role="radiogroup"
          aria-label="Appearance"
          className="grid w-52 shrink-0 grid-cols-3 gap-1 rounded-md border bg-muted p-0.5 text-xs"
        >
          {APPEARANCES.map((value) => (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer items-center justify-center rounded px-2 py-1 font-medium text-muted-foreground hover:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-primary/40",
                appearance === value && "bg-background text-foreground shadow-sm ring-1 ring-border",
              )}
            >
              <input
                type="radio"
                name="settings-appearance"
                className="sr-only"
                checked={appearance === value}
                onChange={() => void update({ appearance: value })}
              />
              {APPEARANCE_LABELS[value]}
            </label>
          ))}
        </div>
      </SettingRow>
      <SettingRow
        stacked
        title="Undoing a chat message's changes"
        hint="What happens to the chat when you undo what the agent did."
      >
        <div role="radiogroup" aria-label="Undoing a chat message's changes" className="flex flex-col gap-2">
          {REWIND_OPTIONS.map(([value, label]) => (
            <label key={value} className="flex cursor-pointer items-center gap-2 self-start text-sm">
              <input
                type="radio"
                name="settings-rewind"
                className="accent-primary"
                checked={rewind === value}
                onChange={() => void update({ rewind: value })}
              />
              {label}
            </label>
          ))}
        </div>
      </SettingRow>
      <SettingRow stacked title="Library" hint="New decks from the start screen are kept in the SlopSlide library.">
        <div className="flex items-center gap-2">
          {library && (
            <span
              data-testid="library-path"
              title={library}
              className="selectable min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1 font-mono text-xs"
            >
              {library}
            </span>
          )}
          <Button variant="outline" size="md" onClick={() => void revealLibrary()} className="shrink-0">
            <FolderSearch className="size-3.5" />
            {revealLabel}
          </Button>
        </div>
      </SettingRow>
    </SettingsGroup>
  );
}
