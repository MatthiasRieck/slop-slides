import { getVersion } from "@tauri-apps/api/app";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, FolderSearch, Info, Keyboard, MessageSquare, SunMoon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import { useRovingTabs } from "../hooks/useRovingTabs";
import { api } from "../lib/api";
import {
  APPEARANCES,
  type Appearance,
  loadAppearance,
  loadTextSize,
  setAppearance,
  setTextSize,
  TEXT_SIZES,
  type TextSize,
} from "../lib/theme";
import { cn, revealLabel } from "../lib/utils";
import { openShortcutHelp, type RewindChoice, rememberedRewind, rememberRewind, showError, useApp } from "../store";
import { Button } from "./Button";

/** The rewind answer kept in storage: "ask" until the user picks one to keep giving. */
type RewindSetting = RewindChoice | "ask";

function loadRewind(): RewindSetting {
  return rememberedRewind() ?? "ask";
}

const APPEARANCE_LABELS: Record<Appearance, string> = { system: "System", light: "Light", dark: "Dark" };
const TEXT_SIZE_LABELS: Record<TextSize, string> = { small: "Small", default: "Default", large: "Large" };

/** The sections of the settings, in the order of the list on the left. Add a section here. */
const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: SunMoon, render: () => <AppearanceSection /> },
  { id: "chat", label: "Chat", icon: MessageSquare, render: () => <ChatSection /> },
  { id: "library", label: "Library", icon: FolderOpen, render: () => <LibrarySection /> },
  { id: "about", label: "About", icon: Info, render: () => <AboutSection /> },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/**
 * The app's settings, for every deck alike, as the settings dialog shows them (see
 * AppSettings.tsx): the sections in a list on the left, the one picked beside it. How the app
 * looks and how large its text is, how undoing an agent's changes treats the chat, where the
 * library is, and the app's version. (A deck's own settings, its title, slide size and style,
 * open from the file menu.)
 */
export function SettingsPanel() {
  const [section, setSection] = useState<SectionId>("appearance");
  const tabs = useRovingTabs<HTMLDivElement>("vertical");
  const id = useId();
  const shown = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <div
        role="tablist"
        aria-label="Settings sections"
        aria-orientation="vertical"
        {...tabs}
        className="flex w-36 shrink-0 flex-col gap-0.5"
      >
        {SECTIONS.map(({ id: sectionId, label, icon: Icon }) => (
          <button
            key={sectionId}
            type="button"
            role="tab"
            id={`${id}-${sectionId}-tab`}
            aria-selected={sectionId === section}
            aria-controls={`${id}-panel`}
            onClick={() => setSection(sectionId)}
            onFocus={() => setSection(sectionId)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground",
              sectionId === section && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${shown.id}-tab`}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto border-l pl-5"
      >
        {shown.render()}
      </div>
    </div>
  );
}

/** Saves a choice, saying so when it only holds until the app closes. */
function remembering(save: () => void, what: string) {
  try {
    save();
  } catch (error) {
    // It shows, but storage could not keep it for the next launch.
    showError(error, { doing: `Could not remember the ${what}` });
  }
}

function AppearanceSection() {
  const [appearance, setShownAppearance] = useState(loadAppearance);
  const [textSize, setShownTextSize] = useState(loadTextSize);
  return (
    <>
      <Setting title="Appearance" hint="System follows your computer's light or dark mode.">
        <Segmented
          label="Appearance"
          name="settings-appearance"
          options={APPEARANCES}
          labels={APPEARANCE_LABELS}
          value={appearance}
          onChange={(value) => {
            remembering(() => setAppearance(value), "appearance");
            setShownAppearance(value);
          }}
        />
      </Setting>
      <Setting
        title="Interface text size"
        hint="How large the app's own text and controls are. Your slides stay as they are."
      >
        <Segmented
          label="Interface text size"
          name="settings-text-size"
          options={TEXT_SIZES}
          labels={TEXT_SIZE_LABELS}
          value={textSize}
          onChange={(value) => {
            remembering(() => setTextSize(value), "text size");
            setShownTextSize(value);
          }}
        />
      </Setting>
    </>
  );
}

function ChatSection() {
  const [rewind, setRewind] = useState(loadRewind);
  const option = (value: RewindSetting, label: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="radio"
        name="settings-rewind"
        className="accent-primary"
        checked={rewind === value}
        onChange={() => {
          rememberRewind(value === "ask" ? null : value);
          setRewind(value);
        }}
      />
      {label}
    </label>
  );
  return (
    <Setting title="Undoing a chat message's changes" hint="What happens to the chat when you undo what the agent did.">
      {option("ask", "Ask each time")}
      {option("rewind", "Also rewind the chat")}
      {option("deck", "Only undo the deck changes")}
    </Setting>
  );
}

function LibrarySection() {
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

  const revealLibrary = async () => {
    try {
      await revealItemInDir(library ?? (await api.libraryFolder()));
    } catch (error) {
      showError(error, { doing: "Could not show the library folder" });
    }
  };

  return (
    <Setting title="Library" hint="New decks from the start screen are kept in the SlopSlide library.">
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
    </Setting>
  );
}

function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    // Without it (the browser preview), the section just leaves the version out.
    Promise.resolve()
      .then(getVersion)
      .then(
        (found) => !gone && typeof found === "string" && setVersion(found),
        () => {},
      );
    return () => {
      gone = true;
    };
  }, []);

  const showShortcuts = () => {
    useApp.getState().closeAppSettings();
    openShortcutHelp();
  };

  return (
    <>
      <Setting title="SlopSlide" hint="Describe a presentation, and an agent writes it as a deck you can edit.">
        {version && (
          <p data-testid="app-version" className="text-xs text-muted-foreground">
            Version {version}
          </p>
        )}
      </Setting>
      <Setting title="Keyboard shortcuts" hint="Every key the app answers to, in one list you can search.">
        <div>
          <Button variant="outline" size="sm" onClick={showShortcuts}>
            <Keyboard className="size-3.5" />
            Show keyboard shortcuts
          </Button>
        </div>
      </Setting>
    </>
  );
}

/** One of a few choices, side by side; the arrow keys go between them, as in any group of radios. */
function Segmented<T extends string>(props: {
  label: string;
  name: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      style={{ gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` }}
      className="grid max-w-72 gap-1 rounded-md border bg-muted p-0.5 text-xs"
    >
      {props.options.map((value) => (
        <label
          key={value}
          className={cn(
            "flex cursor-pointer items-center justify-center rounded px-2 py-1 font-medium text-muted-foreground hover:text-foreground has-focus-visible:ring-2 has-focus-visible:ring-primary/40",
            props.value === value && "bg-background text-foreground shadow-sm ring-1 ring-border",
          )}
        >
          <input
            type="radio"
            name={props.name}
            className="sr-only"
            checked={props.value === value}
            onChange={() => props.onChange(value)}
          />
          {props.labels[value]}
        </label>
      ))}
    </div>
  );
}

/** One setting: what it is, a line about it, and its control. */
function Setting({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}
