import { getVersion } from "@tauri-apps/api/app";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderSearch } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { api } from "../lib/api";
import { APPEARANCES, type Appearance, loadAppearance, setAppearance } from "../lib/theme";
import { cn, revealLabel } from "../lib/utils";
import { type RewindChoice, rememberedRewind, rememberRewind, showError } from "../store";
import { Button } from "./Button";
import { SectionLabel } from "./SectionLabel";

/** The rewind answer kept in storage: "ask" until the user picks one to keep giving. */
type RewindSetting = RewindChoice | "ask";

function loadRewind(): RewindSetting {
  return rememberedRewind() ?? "ask";
}

const APPEARANCE_LABELS: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };

/**
 * The app's settings, in a sidebar tab, for every deck alike: how the app looks, how undoing an
 * agent's changes treats the chat, where the library is, and the app's version. (A deck's own
 * settings, its title, slide size and style, open from the file menu.)
 */
export function SettingsPanel() {
  const [rewind, setRewind] = useState(loadRewind);
  const [appearance, setShownAppearance] = useState(loadAppearance);
  const [library, setLibrary] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    // Without them (the browser preview), the panel just leaves the path and the version out.
    const quietly = <T,>(read: () => Promise<T>) => Promise.resolve().then(read);
    quietly(api.libraryFolder).then(
      (path) => !gone && typeof path === "string" && setLibrary(path),
      () => {},
    );
    quietly(getVersion).then(
      (found) => !gone && typeof found === "string" && setVersion(found),
      () => {},
    );
    return () => {
      gone = true;
    };
  }, []);

  const pickRewind = (value: RewindSetting) => {
    rememberRewind(value === "ask" ? null : value);
    setRewind(value);
  };

  const pickAppearance = (value: Appearance) => {
    try {
      setAppearance(value);
    } catch (error) {
      // It shows, but storage could not keep it for the next launch.
      showError(error, "Could not remember the appearance: ");
    }
    setShownAppearance(value);
  };

  const revealLibrary = async () => {
    try {
      await revealItemInDir(library ?? (await api.libraryFolder()));
    } catch (error) {
      showError(error);
    }
  };

  const option = (value: RewindSetting, label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="radio"
        name="settings-rewind"
        className="accent-primary"
        checked={rewind === value}
        onChange={() => pickRewind(value)}
      />
      {label}
    </label>
  );

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4">
      <Section title="Appearance" hint="System follows your computer's light or dark mode.">
        <div
          role="radiogroup"
          aria-label="Appearance"
          className="grid grid-cols-3 gap-1 rounded-md border bg-muted p-0.5 text-xs"
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
                onChange={() => pickAppearance(value)}
              />
              {APPEARANCE_LABELS[value]}
            </label>
          ))}
        </div>
      </Section>
      <Section
        title="Undoing a chat message's changes"
        hint="What happens to the chat when you undo what the agent did."
      >
        {option("ask", "Ask each time")}
        {option("rewind", "Also rewind the chat")}
        {option("deck", "Only undo the deck changes")}
      </Section>
      <Section title="Library" hint="New decks from the start screen are kept in the SlopSlide library.">
        <div className="flex items-center gap-2">
          {library && (
            <span data-testid="library-path" title={library} className="selectable min-w-0 flex-1 truncate text-xs">
              {library}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => void revealLibrary()} className="shrink-0">
            <FolderSearch className="size-3.5" />
            {revealLabel}
          </Button>
        </div>
      </Section>
      {version && (
        <p data-testid="app-version" className="mt-auto text-2xs text-muted-foreground">
          SlopSlide {version}
        </p>
      )}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <SectionLabel as="h2">{title}</SectionLabel>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
